// みんなのデータページ (閲覧専用)。集計はすべてサーバー側RPC。
import { fetchDistribution, fetchCompInsights, fetchSiteState, backendConfigured } from './backend.js';
import { escapeHtml, CHAR_IMG_RE, THRESHOLDS, ATTR_INFO, enablePullToRefresh, attrName } from './shared.js';
import { makeCharResolver, tileHTML, sortForDisplay } from './tiles.js';
import { t, initLang, applyStaticI18n, mountLangToggle } from './i18n.js';

let infoOf = () => null;

// DB由来のキャラID → 自作タイル。CHECK済みだが二重防御で形式を再検証し、
// 不正なら描画しない (XSS遮断)。名前・属性は tiles.js がエスケープして描画する。
// 未知のID (旧シーズンの未登録キャラ等) はグレーの「？」タイルになる。
function charTileTag(img, { xs = false } = {}) {
    if (typeof img !== 'string' || !CHAR_IMG_RE.test(img)) return '';
    return tileHTML(infoOf(img), { xs });
}

const ATTRS = Object.keys(ATTR_INFO);

// RPC由来の «人数» を差し込む前に数値へ落とす。t() は素の文字列を返すだけで
// エスケープしないので、数値のつもりの値が文字列で返ってきたら innerHTML に
// そのまま入ってしまう (CLAUDE.md 絶対ルール4)。数値化は escape より強い防御 —
// HTMLになり得る文字が構造的に残らない (Codex指摘)
const count = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

const $ = (id) => document.getElementById(id);
let base = null, characters = null, raid = null, site = null;
let viewSeason = null, current = null;

async function init() {
    // 表示言語をまず確定 (この後の描画は全部これを見る)
    initLang();
    applyStaticI18n();
    mountLangToggle();
    document.title = t('stats.page_title');
    [base, characters, raid, site] = await Promise.all([
        fetch('./data/base.json').then(x => x.json()),
        fetch('./data/characters.json').then(x => x.json()).catch(() => null),
        fetch('./data/raid.json').then(x => x.json()).catch(() => null),
        fetchSiteState().catch(() => null),
    ]);
    infoOf = makeCharResolver(characters);
    // 連絡先X (data/site.json — 失敗しても致命ではない)
    fetch('./data/site.json').then(x => x.json()).then(sc => {
        const xid = /^[A-Za-z0-9_]{1,15}$/.test(sc?.xAccount ?? '') ? sc.xAccount : null;
        if (xid) document.querySelectorAll('.contact-x').forEach(el => {
            el.innerHTML = `<a href="https://x.com/${xid}" target="_blank" rel="noopener">X @${xid}</a>`;
        });
    }).catch(() => {});
    // 表示するシーズン: open なら現行 (base.version)、between/maintenance なら display_season
    const status = site?.status ?? 'open';
    viewSeason = (status === 'open') ? base.version : (site?.display_season ?? null);
    if (status !== 'open' && viewSeason) {
        const el = document.querySelector('header');
        if (el) el.insertAdjacentHTML('beforeend',
            `<p class="hint" style="margin-top:6px;color:var(--sub2);">${t('stats.viewing_season', {
                mode: t(status === 'between' ? 'ui.between_h' : 'ui.maint_h'),
                season: escapeHtml(viewSeason),
            })}</p>`);
    }
    enablePullToRefresh();   // PWA standalone にはブラウザの更新ボタンが無いので自前で
    current = orderedAttrs()[0];
    renderTabs();
    if (!viewSeason) {
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = `<p class="err">${t('stats.no_season')}</p>`;
        return;
    }
    load();
    renderEase();   // ボスの通りやすさ (全属性の中央値・タブに依存しない)
}

// ⚖️ ボスの通りやすさ: 5属性の中央値を取り、真ん中の属性を ×1.00 に正規化して表示。
// 解禁済みが3属性未満のうちは出さない (中央の基準が不安定なため)。失敗しても静かに諦める。
async function renderEase() {
    try {
        const attrs = orderedAttrs();
        const dists = await Promise.all(attrs.map(a =>
            fetchDistribution({ attribute: a, season: viewSeason, score: 0 }).catch(() => null)));
        const meds = attrs.map((a, i) => ({
            attr: a,
            median: (dists[i] && !dists[i].gated && Number.isFinite(dists[i].median)) ? dists[i].median : null,
        }));
        const avail = meds.filter(m => m.median != null).map(m => m.median).sort((x, y) => x - y);
        if (avail.length < 3) return;
        const center = avail[Math.floor(avail.length / 2)];   // 真ん中の属性 = ×1.00
        if (!(center > 0)) return;
        $('easeArea').innerHTML = meds.map(({ attr, median }) => {
            const info = ATTR_INFO[attr];
            if (median == null) return `
            <div class="ease-cell">
                <span class="e-name" style="color:${info.color};">${attrName(attr)}</span>
                <span class="e-val" style="color:var(--faint);">—</span>
                <span class="e-med">${t('stats.ease_pending')}</span>
            </div>`;
            const v = median / center;
            return `
            <div class="ease-cell${Math.abs(v - 1) < 1e-9 ? ' center' : ''}">
                <span class="e-name" style="color:${info.color};">${attrName(attr)}</span>
                <span class="e-val">×${v.toFixed(2)}</span>
                <span class="e-med">${t('ui.axis_median', { v: median.toFixed(2) })}</span>
            </div>`;
        }).join('');
        $('easeCard').style.display = 'block';
    } catch (e) { console.warn('通りやすさの算出失敗:', e); }
}

// 属性タブの順 (raid.order があればそれ)。between 中は raid.json が次シーズンに先行しているので、
// 表示中シーズンと一致するときだけ採用 (前シーズンの統計を次シーズンのボス順で並べない)
function orderedAttrs() {
    const o = (raid?.season === viewSeason) ? raid?.order : null;
    if (Array.isArray(o) && o.length === 5 && new Set(o).size === 5 && o.every(a => ATTRS.includes(a))) return o;
    return ATTRS;
}

function renderTabs() {
    $('attrTabs').innerHTML = orderedAttrs().map(a => {
        const i = ATTR_INFO[a];
        return `
        <button type="button" class="attr-tab${a === current ? ' active' : ''}" data-attr="${a}"
                style="--ac:${i.color};">
            <span class="ico">${escapeHtml(t(`attr.short.${a}`))}</span><span class="name">${escapeHtml(t('ui.team_of', { code: attrName(a) }))}</span>
        </button>`;
    }).join('');
    $('attrTabs').querySelectorAll('.attr-tab').forEach(b =>
        b.addEventListener('click', () => { current = b.dataset.attr; renderTabs(); load(); }));
}

// タブは await 中でも切り替わる。**この読み込みが対象にした属性**を掴んでおき、
// 描画にもラベルにもそれを使う (current を後から読むと、遅れて届いた応答が
// 別属性のラベルで描かれる)。世代トークンで古い応答は捨てる — Codex指摘
let loadGen = 0;
async function load() {
    const attr = current;
    const gen = ++loadGen;
    $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = `<p class="err">${t('stats.loading')}</p>`;
    if (!backendConfigured()) {
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = `<p class="err">${t('stats.backend_off')}</p>`;
        return;
    }
    try {
        const [dist, ins] = await Promise.all([
            // p_score=0 で呼ぶ (自分の位置は不要・分布だけ使う)
            fetchDistribution({ attribute: attr, season: viewSeason, score: 0 }),
            fetchCompInsights({ attribute: attr, season: viewSeason }),
        ]);
        if (gen !== loadGen) return;   // その間に別タブへ切り替わった → この応答は捨てる
        renderDist(dist, attr);
        renderInsights(ins, attr);
    } catch (e) {
        console.warn(e);
        if (gen !== loadGen) return;
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = `<p class="err">${t('stats.fetch_failed')}</p>`;
    }
}

function gateHTML(rawN, rawMin, what) {
    const n = count(rawN);
    const min = count(rawMin, 1) || 1;   // 0除算にしない
    const pct = Math.min(100, Math.round((n / min) * 100));
    return `
    <div class="gate-note">
        <span>🔒</span>
        <span>${t('stats.gate', { what, min, n })}</span>
        <span class="gate-bar"><span style="width:${pct}%"></span></span>
    </div>`;
}

function renderDist(d, attr) {
    // 分布本体はサーバーが閾値以上のときだけ返す (gated / bins欠如なら未解禁)
    if (!d || d.gated || !Array.isArray(d.bins)) {
        $('distArea').innerHTML = gateHTML(d?.n ?? 0, d?.need ?? THRESHOLDS.dist,
            t('stats.what_dist', { team: t('ui.team_of', { code: attrName(attr) }) }));
        return;
    }
    const maxBin = Math.max(...d.bins, 1);
    $('distArea').innerHTML = `
    <div class="hist">${d.bins.map(v =>
        `<div class="bar" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('')}</div>
    <div class="hist-axis"><span>${d.lo.toFixed(2)}</span><span>${t('ui.axis_median', { v: d.median.toFixed(2) })}</span><span>${d.hi.toFixed(2)}</span></div>
    <p class="dist-note">${t('stats.dist_note', {
        team: t('ui.team_of', { code: attrName(attr) }), n: count(d.n), v: d.median.toFixed(2),
    })}</p>`;
}

function renderInsights(ins, attr) {
    const n = count(ins?.n);
    if (!ins || ins.gated || !ins.chars) {   // サーバー閾値未満は本体なし
        $('charsArea').innerHTML = gateHTML(n, ins?.need ?? THRESHOLDS.insights,
            t('stats.what_comp', { team: t('ui.team_of', { code: attrName(attr) }) }));
        $('compsArea').innerHTML = `<p class="hint">${t('stats.comps_gated')}</p>`;
        return;
    }
    // キャラ採用率 (img は charTileTag が形式検証 + 名前エスケープ)
    $('charsArea').innerHTML = `<div class="char-grid">${(ins.chars || []).slice(0, 18).map(c => `
        <div class="char-cell">
            ${charTileTag(c.img)}
            <div class="pct">${Math.round((c.count / n) * 100)}%</div>
        </div>`).join('')}</div>
    <p class="dist-note">${t('stats.chars_target', { n })}</p>`;
    // 💪 中央値が高い編成 (採用5人以上のみ・サーバーが選抜)。08未適用の旧サーバーでは
    // medianTop が無いので、そのときはセクションごと出さない (静かに劣化)
    const medianTop = (Array.isArray(ins.medianTop) ? ins.medianTop : []).map((cp, i) => `
    <div class="comp-row strong-comp">
        <span class="rank">${i + 1}</span>
        <span class="comp-meta">
            <span>${t('stats.median_strong', { v: Number(cp.median).toFixed(2) })}</span>
            <span>${t('stats.used_strong', { n: count(cp.n) })}</span>
        </span>
        <span class="comp-faces">${sortForDisplay(Array.isArray(cp.chars) ? cp.chars : [], infoOf).map(img => charTileTag(img)).join('')}</span>
    </div>`);
    const medianTopHtml = medianTop.length
        ? `<p class="sec-label">${t('stats.sec_median_top')}</p>${foldRows(medianTop)}
           <p class="sec-label" style="margin-top:14px;">${t('stats.sec_popular')}</p>` : '';

    // 編成ランキング (使用率順)。median は採用5人未満だと null (プライバシー下限)。
    // 編成は「同じ5人」で1つ (並び順は評価に無関係なので内訳は出さない — 2026-08-01 運営判断)
    const compRows = (ins.comps || []).map((cp, i) => {
        const stats = Number.isFinite(cp.median)
            ? `<span>${t('stats.median_strong', { v: Number(cp.median).toFixed(2) })}</span>`
            : `<span style="color:var(--faint);">${t('stats.score_needs_5')}</span>`;

        const row = `
        <span class="rank">${i + 1}</span>
        <span class="comp-meta">
            <span>${t('stats.used_strong', { n: count(cp.n) })}</span>
            ${stats}
        </span>
        <span class="comp-faces">${sortForDisplay(Array.isArray(cp.chars) ? cp.chars : [], infoOf).map(img => charTileTag(img)).join('')}</span>`;
        return `<div class="comp-row">${row}</div>`;
    });
    $('compsArea').innerHTML = medianTopHtml +
        (compRows.length ? foldRows(compRows) : `<p class="hint">${t('stats.comps_empty')}</p>`);
}

// ランキングの折りたたみ: TOP3 は常時表示、4位以下は <details> に格納 (両ランキング共通)。
// rows は行HTMLの配列 (順位順)。開閉に JS は不要 — 再描画 (属性切替) で自然に畳まれる
function foldRows(rows) {
    if (!Array.isArray(rows)) rows = [rows];
    const head = rows.slice(0, 3).join('');
    const rest = rows.slice(3);
    if (rest.length === 0) return head;
    return head + `
    <details class="rank-fold">
        <summary>${t('stats.show_rest', { last: rows.length })}</summary>
        ${rest.join('')}
    </details>`;
}

init().catch(e => {
    console.error(e);
    $('distArea').innerHTML = `<p class="err">${t('stats.load_failed')}</p>`;
});
