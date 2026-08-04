// みんなのデータページ (閲覧専用)。集計はすべてサーバー側RPC。
import { fetchDistribution, fetchCompInsights, fetchSiteState, backendConfigured } from './backend.js';
import { escapeHtml, CHAR_IMG_RE, THRESHOLDS, ATTR_INFO, enablePullToRefresh } from './shared.js';
import { makeCharResolver, tileHTML, sortForDisplay } from './tiles.js';

let infoOf = () => null;

// DB由来のキャラID → 自作タイル。CHECK済みだが二重防御で形式を再検証し、
// 不正なら描画しない (XSS遮断)。名前・属性は tiles.js がエスケープして描画する。
// 未知のID (旧シーズンの未登録キャラ等) はグレーの「？」タイルになる。
function charTileTag(img, { xs = false } = {}) {
    if (typeof img !== 'string' || !CHAR_IMG_RE.test(img)) return '';
    return tileHTML(infoOf(img), { xs });
}

const ATTRS = Object.keys(ATTR_INFO);

const $ = (id) => document.getElementById(id);
let base = null, characters = null, raid = null, site = null;
let viewSeason = null, current = null;

async function init() {
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
            `<p class="hint" style="margin-top:6px;color:var(--sub2);">${status === 'between' ? '⏳ 次シーズン準備中' : '🚧 工事中'} — 表示中: ${escapeHtml(viewSeason)} シーズン (確定分)</p>`);
    }
    enablePullToRefresh();   // PWA standalone にはブラウザの更新ボタンが無いので自前で
    current = orderedAttrs()[0];
    renderTabs();
    if (!viewSeason) {
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = '<p class="err">表示できるシーズンがありません。</p>';
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
                <span class="e-name" style="color:${info.color};">${info.jp}</span>
                <span class="e-val" style="color:var(--faint);">—</span>
                <span class="e-med">集計待ち</span>
            </div>`;
            const v = median / center;
            return `
            <div class="ease-cell${Math.abs(v - 1) < 1e-9 ? ' center' : ''}">
                <span class="e-name" style="color:${info.color};">${info.jp}</span>
                <span class="e-val">×${v.toFixed(2)}</span>
                <span class="e-med">中央値 ${median.toFixed(2)}</span>
            </div>`;
        }).join('');
        $('easeCard').style.display = 'block';
    } catch (e) { console.warn('通りやすさの算出失敗:', e); }
}

// 属性タブの順 (raid.order があればそれ)
function orderedAttrs() {
    const o = raid?.order;
    if (Array.isArray(o) && o.length === 5 && new Set(o).size === 5 && o.every(a => ATTRS.includes(a))) return o;
    return ATTRS;
}

function renderTabs() {
    $('attrTabs').innerHTML = orderedAttrs().map(a => {
        const i = ATTR_INFO[a];
        return `
        <button type="button" class="attr-tab${a === current ? ' active' : ''}" data-attr="${a}"
                style="--ac:${i.color};">
            <span class="ico">${i.jp[0]}</span><span class="name">${i.jp}PT</span>
        </button>`;
    }).join('');
    $('attrTabs').querySelectorAll('.attr-tab').forEach(b =>
        b.addEventListener('click', () => { current = b.dataset.attr; renderTabs(); load(); }));
}

async function load() {
    const info = ATTR_INFO[current];
    $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = '<p class="err">読み込み中…</p>';
    if (!backendConfigured()) {
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = '<p class="err">データ機能は準備中です</p>';
        return;
    }
    try {
        const [dist, ins] = await Promise.all([
            // p_score=0 で呼ぶ (自分の位置は不要・分布だけ使う)
            fetchDistribution({ attribute: current, season: viewSeason, score: 0 }),
            fetchCompInsights({ attribute: current, season: viewSeason }),
        ]);
        renderDist(dist, info);
        renderInsights(ins, info);
    } catch (e) {
        console.warn(e);
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = '<p class="err">データを取得できませんでした。時間をおいて再読み込みしてください。</p>';
    }
}

function gateHTML(n, min, what) {
    const pct = Math.min(100, Math.round((n / min) * 100));
    return `
    <div class="gate-note">
        <span>🔒</span>
        <span>${what}は <strong>${min}人</strong> で解禁 — 現在 <strong>${n}人</strong></span>
        <span class="gate-bar"><span style="width:${pct}%"></span></span>
    </div>`;
}

function renderDist(d, info) {
    // 分布本体はサーバーが閾値以上のときだけ返す (gated / bins欠如なら未解禁)
    if (!d || d.gated || !Array.isArray(d.bins)) {
        $('distArea').innerHTML = gateHTML(d?.n ?? 0, d?.need ?? THRESHOLDS.dist, `${info.jp}PT の分布`);
        return;
    }
    const maxBin = Math.max(...d.bins, 1);
    $('distArea').innerHTML = `
    <div class="hist">${d.bins.map(v =>
        `<div class="bar" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('')}</div>
    <div class="hist-axis"><span>${d.lo.toFixed(2)}</span><span>中央値 ${d.median.toFixed(2)}</span><span>${d.hi.toFixed(2)}</span></div>
    <p class="dist-note">${info.jp}PT の提出 <strong>${d.n}人</strong>。中央値はふるり値 <strong>${d.median.toFixed(2)}</strong> です。</p>`;
}

function renderInsights(ins, info) {
    const n = ins?.n ?? 0;
    if (!ins || ins.gated || !ins.chars) {   // サーバー閾値未満は本体なし
        $('charsArea').innerHTML = gateHTML(n, ins?.need ?? THRESHOLDS.insights, `${info.jp}PT の編成データ`);
        $('compsArea').innerHTML = `<p class="hint">編成を登録した提出が増えると表示されます</p>`;
        return;
    }
    // キャラ採用率 (img は charTileTag が形式検証 + 名前エスケープ)
    $('charsArea').innerHTML = `<div class="char-grid">${(ins.chars || []).slice(0, 18).map(c => `
        <div class="char-cell">
            ${charTileTag(c.img)}
            <div class="pct">${Math.round((c.count / n) * 100)}%</div>
        </div>`).join('')}</div>
    <p class="dist-note">対象: 編成つき提出 ${n}人</p>`;
    // 💪 中央値が高い編成 (採用5人以上のみ・サーバーが選抜)。08未適用の旧サーバーでは
    // medianTop が無いので、そのときはセクションごと出さない (静かに劣化)
    const medianTop = (Array.isArray(ins.medianTop) ? ins.medianTop : []).map((cp, i) => `
    <div class="comp-row strong-comp">
        <span class="rank">${i + 1}</span>
        <span class="comp-meta">
            <span>中央値 <strong>${Number(cp.median).toFixed(2)}</strong></span>
            <span>採用 <strong>${cp.n}人</strong></span>
        </span>
        <span class="comp-faces">${sortForDisplay(Array.isArray(cp.chars) ? cp.chars : [], infoOf).map(img => charTileTag(img)).join('')}</span>
    </div>`);
    const medianTopHtml = medianTop.length
        ? `<p class="sec-label">💪 中央値が高い編成 (採用5人以上)</p>${foldRows(medianTop)}
           <p class="sec-label" style="margin-top:14px;">📊 よく使われる編成 (使用率順)</p>` : '';

    // 編成ランキング (使用率順)。median は採用5人未満だと null (プライバシー下限)。
    // 編成は「同じ5人」で1つ (並び順は評価に無関係なので内訳は出さない — 2026-08-01 運営判断)
    const compRows = (ins.comps || []).map((cp, i) => {
        const stats = Number.isFinite(cp.median)
            ? `<span>中央値 <strong>${Number(cp.median).toFixed(2)}</strong></span>`
            : `<span style="color:var(--faint);">スコアは5人以上で表示</span>`;

        const row = `
        <span class="rank">${i + 1}</span>
        <span class="comp-meta">
            <span>採用 <strong>${cp.n}人</strong></span>
            ${stats}
        </span>
        <span class="comp-faces">${sortForDisplay(Array.isArray(cp.chars) ? cp.chars : [], infoOf).map(img => charTileTag(img)).join('')}</span>`;
        return `<div class="comp-row">${row}</div>`;
    });
    $('compsArea').innerHTML = medianTopHtml +
        (compRows.length ? foldRows(compRows) : '<p class="hint">まだ編成つきの提出がありません</p>');
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
        <summary><span class="chev">▼</span> 4〜${rows.length}位も見る</summary>
        ${rest.join('')}
    </details>`;
}

init().catch(e => {
    console.error(e);
    $('distArea').innerHTML = '<p class="err">読み込みに失敗しました</p>';
});
