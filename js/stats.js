// みんなのデータページ (閲覧専用)。集計はすべてサーバー側RPC。
import { fetchDistribution, fetchCompInsights, fetchSiteState, backendConfigured } from './backend.js';
import { escapeHtml, CHAR_IMG_RE, THRESHOLDS, ATTR_INFO } from './shared.js';

// DB由来の画像名を描画する共通タグ。CHECK済みだが二重防御で形式を再検証し、
// 不正なら描画しない (XSS遮断)。名前は characters.json 由来だがエスケープする。
function charImgTag(img, { lazy = true } = {}) {
    if (typeof img !== 'string' || !CHAR_IMG_RE.test(img)) return '';
    const name = escapeHtml(characters?.[img]?.name ?? '');
    return `<img ${lazy ? 'loading="lazy" ' : ''}src="./character-images/${img}" alt="${name}" title="${name}">`;
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
    // 表示するシーズン: open なら現行 (base.version)、between/maintenance なら display_season
    const status = site?.status ?? 'open';
    viewSeason = (status === 'open') ? base.version : (site?.display_season ?? null);
    if (status !== 'open' && viewSeason) {
        const el = document.querySelector('header');
        if (el) el.insertAdjacentHTML('beforeend',
            `<p class="hint" style="margin-top:6px;color:var(--sub2);">${status === 'between' ? '⏳ 次シーズン準備中' : '🚧 工事中'} — 表示中: ${escapeHtml(viewSeason)} シーズン (確定分)</p>`);
    }
    current = orderedAttrs()[0];
    renderTabs();
    if (!viewSeason) {
        $('distArea').innerHTML = $('charsArea').innerHTML = $('compsArea').innerHTML = '<p class="err">表示できるシーズンがありません。</p>';
        return;
    }
    load();
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
                style="--fa:${i.color};--fa-soft:${i.color}14;">
            <img src="${i.icon}" alt=""><span class="name">${i.jp}PT</span>
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
    <div class="hist" style="--ba:${info.color}55;">${d.bins.map(v =>
        `<div class="bar" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('')}</div>
    <div class="hist-axis"><span>ふるり値 ${d.lo.toFixed(2)}</span><span>${d.hi.toFixed(2)}</span></div>
    <p class="dist-note">${info.jp}PT の提出 <strong>${d.n}人</strong>。中央値はふるり値 <strong>${d.median.toFixed(2)}</strong> です。</p>`;
}

function renderInsights(ins, info) {
    const n = ins?.n ?? 0;
    if (!ins || ins.gated || !ins.chars) {   // サーバー閾値未満は本体なし
        $('charsArea').innerHTML = gateHTML(n, ins?.need ?? THRESHOLDS.insights, `${info.jp}PT の編成データ`);
        $('compsArea').innerHTML = `<p class="hint">編成を登録した提出が増えると表示されます</p>`;
        return;
    }
    // キャラ採用率 (img は charImgTag が形式検証 + 名前エスケープ)
    $('charsArea').innerHTML = `<div class="char-grid">${(ins.chars || []).slice(0, 18).map(c => `
        <div class="char-cell">
            ${charImgTag(c.img)}
            <div class="pct">${Math.round((c.count / n) * 100)}%</div>
        </div>`).join('')}</div>
    <p class="dist-note">対象: 編成つき提出 ${n}人</p>`;
    // 編成ランキング (best/median は採用5人未満だと null で返る = プライバシー下限)
    $('compsArea').innerHTML = (ins.comps || []).map((cp, i) => {
        const hasStats = Number.isFinite(cp.median) && Number.isFinite(cp.best);
        const stats = hasStats
            ? `中央値 <strong>${Number(cp.median).toFixed(2)}</strong> / 最高 <strong>${Number(cp.best).toFixed(2)}</strong>`
            : `<span style="color:var(--faint);">スコアは5人以上で表示</span>`;
        return `
    <div class="comp-row">
        <span style="font-size:12px;font-weight:900;color:${info.color};min-width:20px;">${i + 1}</span>
        <span class="comp-faces">${(Array.isArray(cp.chars) ? cp.chars : []).map(img => charImgTag(img)).join('')}</span>
        <span class="comp-meta">
            <span>採用 <strong>${cp.n}人</strong></span>
            <span>${stats}</span>
        </span>
    </div>`;
    }).join('') || '<p class="hint">まだ編成つきの提出がありません</p>';
}

init().catch(e => {
    console.error(e);
    $('distArea').innerHTML = '<p class="err">読み込みに失敗しました</p>';
});
