// みんなのデータページ (閲覧専用)。集計はすべてサーバー側RPC。
import { fetchDistribution, fetchCompInsights, backendConfigured } from './backend.js';
import { escapeHtml, CHAR_IMG_RE } from './shared.js';

// DB由来の画像名を描画する共通タグ。CHECK済みだが二重防御で形式を再検証し、
// 不正なら描画しない (XSS遮断)。名前は characters.json 由来だがエスケープする。
function charImgTag(img, { lazy = true } = {}) {
    if (typeof img !== 'string' || !CHAR_IMG_RE.test(img)) return '';
    const name = escapeHtml(characters?.[img]?.name ?? '');
    return `<img ${lazy ? 'loading="lazy" ' : ''}src="./character-images/${img}" alt="${name}" title="${name}">`;
}

const ATTR_INFO = {
    FIRE:     { jp: '灼熱', color: '#FF3D44', icon: './assets/attr/fire.png' },
    WATER:    { jp: '水冷', color: '#2E8BFF', icon: './assets/attr/water.png' },
    ELECTRIC: { jp: '電撃', color: '#9B4DFF', icon: './assets/attr/electric.png' },
    IRON:     { jp: '鉄甲', color: '#FF8A2B', icon: './assets/attr/iron.png' },
    WIND:     { jp: '風圧', color: '#18C26B', icon: './assets/attr/wind.png' },
};
const ATTRS = Object.keys(ATTR_INFO);

// 解禁しきい値 (app.js と同じ思想。分布は厳しめ、採用率/編成は参考値として早めに見せる)
const MIN_N_DIST = 100;
const MIN_N_INSIGHTS = 10;

const $ = (id) => document.getElementById(id);
let base = null, characters = null, current = 'FIRE';

async function init() {
    [base, characters] = await Promise.all([
        fetch('./data/base.json').then(x => x.json()),
        fetch('./data/characters.json').then(x => x.json()).catch(() => null),
    ]);
    renderTabs();
    load();
}

function renderTabs() {
    $('attrTabs').innerHTML = ATTRS.map(a => {
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
            fetchDistribution({ attribute: current, score: 0, baseVersion: base.version }),
            fetchCompInsights({ attribute: current, baseVersion: base.version }),
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
        $('distArea').innerHTML = gateHTML(d?.n ?? 0, MIN_N_DIST, `${info.jp}PT の分布`);
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
    if (!ins || ins.gated || !ins.chars) {   // サーバー閾値 (編成データ=10) 未満は本体なし
        $('charsArea').innerHTML = gateHTML(n, MIN_N_INSIGHTS, `${info.jp}PT の編成データ`);
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
    // 編成ランキング
    $('compsArea').innerHTML = (ins.comps || []).map((cp, i) => `
    <div class="comp-row">
        <span style="font-size:12px;font-weight:900;color:${info.color};min-width:20px;">${i + 1}</span>
        <span class="comp-faces">${(Array.isArray(cp.chars) ? cp.chars : []).map(img => charImgTag(img)).join('')}</span>
        <span class="comp-meta">
            <span>採用 <strong>${cp.n}人</strong></span>
            <span>中央値 <strong>${Number(cp.median).toFixed(2)}</strong> / 最高 <strong>${Number(cp.best).toFixed(2)}</strong></span>
        </span>
    </div>`).join('') || '<p class="hint">まだ編成つきの提出がありません</p>';
}

init().catch(e => {
    console.error(e);
    $('distArea').innerHTML = '<p class="err">読み込みに失敗しました</p>';
});
