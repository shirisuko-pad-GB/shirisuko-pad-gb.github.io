// しりすこPAD GB — ふるり値チェッカー UIロジック
// 3凸まとめ入力 + サーバー集計の分布表示 (しきい値ゲート付き)
// ふるり値の計算はサーバー側のみ (SLv補正テーブル秘匿のため) — 送信の返事で score を受け取る
import { topPercentFromCounts, ATTRS } from './calc.js';
import { backendConfigured, submitSet, fetchDistribution, compKeyOf } from './backend.js';

// PT属性の表示情報。enemy = そのPTで殴る相手ボスの属性
const ATTR_INFO = {
    FIRE:     { jp: '灼熱', color: '#FF3D44', icon: './assets/attr/fire.png',     enemyJp: '風圧', enemyIcon: './assets/attr/wind.png' },
    WATER:    { jp: '水冷', color: '#2E8BFF', icon: './assets/attr/water.png',    enemyJp: '灼熱', enemyIcon: './assets/attr/fire.png' },
    ELECTRIC: { jp: '電撃', color: '#9B4DFF', icon: './assets/attr/electric.png', enemyJp: '水冷', enemyIcon: './assets/attr/water.png' },
    IRON:     { jp: '鉄甲', color: '#FF8A2B', icon: './assets/attr/iron.png',     enemyJp: '電撃', enemyIcon: './assets/attr/electric.png' },
    WIND:     { jp: '風圧', color: '#18C26B', icon: './assets/attr/wind.png',     enemyJp: '鉄甲', enemyIcon: './assets/attr/iron.png' },
};
const SITE_URL = 'https://shirisuko-pad-gb.github.io/';

// 分布の解禁しきい値 (信頼性重視)。変えるときはここだけ
const MIN_N_ALL = 100;   // 属性別分布
const MIN_N_COMP = 30;   // 同一編成分布
const MAX_ATTACKS = 3;

const $ = (id) => document.getElementById(id);

let base = null, presets = null;
let attacks = [newAttack()];
let results = null;        // シェア用の測定結果
let shareBlob = null;

function newAttack() {
    return { attribute: null, damage: '', chars: [], compOpen: false };
}

// ---------- 初期化 ----------
async function init() {
    const [b, p] = await Promise.all([
        fetch('./data/base.json').then(x => x.json()),
        fetch('./data/presets.json').then(x => x.json()).catch(() => null),
    ]);
    base = b; presets = p;
    $('baseVersionLabel').textContent = `${base.version} (基準者${base.basePlayer} SLv ${base.baseSlv})`;
    $('thresholdAllLabel').textContent = MIN_N_ALL;
    $('thresholdCompLabel').textContent = MIN_N_COMP;
    $('slvMinus').addEventListener('click', () => stepSlv(-1));
    $('slvPlus').addEventListener('click', () => stepSlv(1));
    $('slv').addEventListener('input', updateSubmitState);
    $('addAtkBtn').addEventListener('click', () => {
        if (attacks.length >= MAX_ATTACKS) return;
        attacks.push(newAttack());
        renderAttacks();
        updateSubmitState();
    });
    $('submitBtn').addEventListener('click', onSubmit);
    $('shareBtn').addEventListener('click', onShare);
    $('saveBtn').addEventListener('click', onSave);
    renderAttacks();
    updateSubmitState();
}

function stepSlv(d) {
    const el = $('slv');
    const v = parseInt(el.value) || 0;
    el.value = Math.max(1, Math.min(1000, v + d));
    updateSubmitState();
}

function updateSubmitState() {
    const slv = parseInt($('slv').value);
    const ok = slv >= 1 && slv <= 1000 &&
        attacks.every(a => a.attribute && parseFloat(a.damage) > 0);
    $('submitBtn').disabled = !ok;
    $('addAtkBtn').disabled = attacks.length >= MAX_ATTACKS;
}

// ---------- 凸カードの描画 ----------
function renderAttacks() {
    const area = $('attacksArea');
    area.innerHTML = attacks.map((a, i) => attackCardHTML(a, i)).join('');
    area.querySelectorAll('.atk-card').forEach(card => bindAttackCard(card));
    updateSubmitState();
}

function attackCardHTML(a, i) {
    const info = a.attribute ? ATTR_INFO[a.attribute] : null;
    const title = attacks.length > 1 ? `凸${i + 1}` : '今回の凸';
    const delBtn = attacks.length > 1 ? `<button type="button" class="atk-del">✕ 削除</button>` : '';
    const attrBtns = ATTRS.map(attr => {
        const ai = ATTR_INFO[attr];
        return `
        <button type="button" class="attr-btn${a.attribute === attr ? ' active' : ''}" data-attr="${attr}"
                style="--fa:${ai.color};--fa-soft:${ai.color}14;">
            <img class="ico" src="${ai.icon}" alt="${ai.jp}">
            <span class="name">${ai.jp}PT</span>
            <span class="vs">⚔ <img src="${ai.enemyIcon}" alt="">${ai.enemyJp}ボス</span>
        </button>`;
    }).join('');
    const dmg = a.damage ? ` value="${a.damage}"` : '';
    return `
    <section class="card atk-card" data-i="${i}" style="${info ? `--ac:${info.color};` : ''}">
        <h2><span class="step-num">2</span>${title}${delBtn}</h2>
        <p class="hint" style="margin-bottom:8px;">PT属性を選択。⚔ の後ろは<strong>そのPTで殴る相手ボス</strong>です</p>
        <div class="attr-grid">${attrBtns}</div>
        <div style="margin-top:12px;">
            <p class="hint" style="margin-bottom:6px;">与えたダメージ (凸結果画面の TOTAL DAMAGE をそのまま。カンマ不要)</p>
            <input class="atk-damage" type="number" min="0" inputmode="numeric" placeholder="例: 30000000000"${dmg}>
            <p class="preview">${damagePreviewText(a.damage)}</p>
        </div>
        <details class="comp"${a.compOpen ? ' open' : ''}>
            <summary>キャラ編成 <span class="pill">任意</span><span class="chev">▼</span></summary>
            <div class="comp-body">${compBodyHTML(a)}</div>
        </details>
    </section>`;
}

function compBodyHTML(a) {
    if (!a.attribute) return `<p class="hint" style="margin-top:8px;">先にPT属性を選ぶと編成を選択できます</p>`;
    const ap = presets?.attributes?.[a.attribute];
    if (!ap) return `<p class="hint" style="margin-top:8px;">編成データを読み込めませんでした</p>`;
    const presetRows = (ap.topComps || []).map((c, pi) => `
        <button type="button" class="preset-row" data-preset="${pi}">
            <span class="preset-faces">${c.chars.map(img => `<img loading="lazy" src="./character-images/${img}" alt="">`).join('')}</span>
            <span class="preset-meta">
                <span class="pill">使用率TOP${pi + 1}</span>
                <span class="hint">ユニオン実績 ${c.count}回 (〜${c.lastMonth})</span>
            </span>
        </button>`).join('');
    const pickerBtns = (ap.topChars || []).map(({ img }) =>
        `<button type="button" data-img="${img}"><img loading="lazy" src="./character-images/${img}" alt=""></button>`).join('');
    return `
        <p class="hint" style="margin-top:8px;">編成を登録すると「同じ編成の人たちの中での位置」の集計対象になります</p>
        ${presetRows}
        <div class="comp-status"></div>
        <div class="picker-grid">${pickerBtns}</div>`;
}

function damagePreviewText(v) {
    const n = parseFloat(v);
    return (n > 0) ? `≈ ${(n / 1e9).toFixed(3)} B (${n.toLocaleString('ja-JP')})` : ' ';
}

function bindAttackCard(card) {
    const i = Number(card.dataset.i);
    const a = attacks[i];
    // 属性選択 → カード再描画 (編成は属性ごとに別物なのでリセット)
    card.querySelectorAll('.attr-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            a.attribute = btn.dataset.attr;
            a.chars = [];
            renderAttacks();
        });
    });
    // ダメージ入力 (再描画せず state とプレビューだけ更新 — フォーカス維持)
    const dmgInput = card.querySelector('.atk-damage');
    dmgInput.addEventListener('input', () => {
        a.damage = dmgInput.value;
        card.querySelector('.preview').innerHTML = damagePreviewText(a.damage);
        updateSubmitState();
    });
    // 削除
    const del = card.querySelector('.atk-del');
    if (del) del.addEventListener('click', () => { attacks.splice(i, 1); renderAttacks(); });
    // 編成の開閉状態を保持
    const details = card.querySelector('details.comp');
    details.addEventListener('toggle', () => { a.compOpen = details.open; });
    // プリセット
    const ap = presets?.attributes?.[a.attribute];
    card.querySelectorAll('.preset-row').forEach(row => {
        row.addEventListener('click', () => {
            const c = ap.topComps[Number(row.dataset.preset)];
            const same = a.chars.length === 5 && c.chars.every(x => a.chars.includes(x));
            a.chars = same ? [] : [...c.chars];   // 再タップで解除
            syncCompUI(card, a);
        });
    });
    // 顔写真ピッカー
    card.querySelectorAll('.picker-grid button').forEach(btn => {
        btn.addEventListener('click', () => {
            const img = btn.dataset.img;
            const idx = a.chars.indexOf(img);
            if (idx >= 0) a.chars.splice(idx, 1);
            else if (a.chars.length < 5) a.chars.push(img);
            else { toast('編成は5体までです'); return; }
            syncCompUI(card, a);
        });
    });
    syncCompUI(card, a);
}

function syncCompUI(card, a) {
    const ap = presets?.attributes?.[a.attribute];
    card.querySelectorAll('.picker-grid button').forEach(btn => {
        const idx = a.chars.indexOf(btn.dataset.img);
        btn.classList.toggle('sel', idx >= 0);
        if (idx >= 0) btn.setAttribute('data-n', idx + 1);
    });
    card.querySelectorAll('.preset-row').forEach(row => {
        const c = ap?.topComps?.[Number(row.dataset.preset)];
        row.classList.toggle('active',
            !!c && a.chars.length === 5 && c.chars.every(x => a.chars.includes(x)));
    });
    const st = card.querySelector('.comp-status');
    if (st) {
        const n = a.chars.length;
        st.textContent =
            n === 0 ? '未選択 (編成なしで送信できます)' :
            n === 5 ? '✓ 5体選択済み — この編成で送信されます' :
            `${n} / 5 体選択中 (5体そろうと編成つきで送信)`;
    }
}

// ---------- 送信・測定 ----------
async function onSubmit() {
    const slv = parseInt($('slv').value);
    const items = attacks.map(a => ({
        attribute: a.attribute, slv,
        damage: parseFloat(a.damage),
        characters: a.chars.length === 5 ? [...a.chars].sort() : null,
    }));
    if (items.some(it => !ATTRS.includes(it.attribute) || !(it.damage > 0)) || !(slv >= 1 && slv <= 1000)) {
        toast('入力内容を確認してください');
        return;
    }

    const btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = '送信中…';

    // 計算はサーバー側 — 送信が通らないとスコアも出ない
    let returned = null;
    try {
        returned = await submitSet(items, base.version);
        if (returned.some(r => !Number.isFinite(r.score))) throw new Error('score missing in response');
    } catch (e) {
        console.warn('送信失敗:', e);
        $('resultsArea').innerHTML = `
        <section class="card">
            <h2>⚠️ 測定できませんでした</h2>
            <p class="score-detail">サーバーに接続できませんでした。ふるり値の計算はサーバー側で行うため、
            通信が復活してから再度お試しください。入力内容はそのまま残っています。</p>
        </section>`;
        $('shareCard').style.display = 'none';
        $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
        btn.textContent = '送信して測定する';
        updateSubmitState();
        return;
    }

    // 分布取得 (凸ごとに並列)
    const dists = await Promise.all(items.map(async (it, i) => {
        try {
            const { score, compKey } = returned[i];
            const [dist, compDist] = await Promise.all([
                fetchDistribution({ attribute: it.attribute, score, baseVersion: base.version }),
                compKey
                    ? fetchDistribution({ attribute: it.attribute, score, baseVersion: base.version, compKey })
                    : Promise.resolve(null),
            ]);
            return { dist, compDist, fetchError: false };
        } catch (e) {
            console.warn('分布取得失敗:', e);
            return { dist: null, compDist: null, fetchError: true };
        }
    }));

    results = items.map((it, i) => ({ ...it, score: returned[i].score, ...dists[i] }));
    renderResults();

    shareBlob = null;
    $('cardPreview').style.display = 'none';
    $('shareCard').style.display = 'block';
    $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });

    btn.textContent = '送信して測定する';
    updateSubmitState();
}

function renderResults() {
    const area = $('resultsArea');
    const multi = results.length > 1;
    let html = results.map((r, i) => resultCardHTML(r, i, multi)).join('');
    if (multi) {
        const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
        html += `
        <section class="card set-card">
            <h2>🏅 ${results.length}凸 平均ふるり値</h2>
            <div class="score-line"><span class="score-big" style="--ra:#14161A;">${avg.toFixed(2)}</span></div>
            <p class="score-detail">${results.map(r => `${ATTR_INFO[r.attribute].jp} ${r.score.toFixed(2)}`).join(' / ')}</p>
            <p class="dist-note">※ 属性間の重み付けをした総合指標は、全属性の分布が解禁されると使えるようになります</p>
        </section>`;
    }
    area.innerHTML = html;
}

function resultCardHTML(r, i, multi) {
    const info = ATTR_INFO[r.attribute];
    const title = multi ? `📊 凸${i + 1} の結果` : '📊 測定結果';

    let distHtml = '';
    if (r.fetchError) {
        distHtml = `<p class="dist-note">分布データを取得できませんでした (スコアは正常です)</p>`;
    } else if (r.dist) {
        distHtml = distSectionHTML(r, info);
    }

    const pct = (r.dist && r.dist.n >= MIN_N_ALL) ? topPercentFromCounts(r.dist.above, r.dist.n) : null;
    const pill = pct != null
        ? `<span class="rank-pill" style="--ra:${info.color};">上位 ${pct}% / ${r.dist.n}人</span>` : '';

    return `
    <section class="card result-card" style="--ra:${info.color};">
        <h2><img src="${info.icon}" alt="" style="width:18px;height:18px;">${title}</h2>
        <div class="score-line">
            <span class="score-big">${r.score.toFixed(2)}</span>
            ${pill}
        </div>
        <p class="score-detail">${info.jp}PT / SLv ${r.slv} / ${(r.damage / 1e9).toFixed(3)} B
            (基準: ${(base.bases[r.attribute].damage / 1e9).toFixed(2)} B @ SLv ${base.baseSlv})</p>
        ${distHtml}
    </section>`;
}

function distSectionHTML(r, info) {
    const d = r.dist;
    let html = '';
    if (d.n < MIN_N_ALL) {
        // 解禁前: 進捗を見せて送信を促す
        const pctBar = Math.min(100, Math.round((d.n / MIN_N_ALL) * 100));
        html += `
        <div class="gate-note">
            <span>🔒</span>
            <span>みんなの分布は <strong>${MIN_N_ALL}人</strong> で解禁 — 現在 <strong>${d.n}人</strong>。シェアして仲間を増やそう!</span>
            <span class="gate-bar"><span style="width:${pctBar}%"></span></span>
        </div>`;
    } else {
        const maxBin = Math.max(...d.bins, 1);
        const bars = d.bins.map((v, bi) =>
            `<div class="bar${bi === d.my_bin - 1 ? ' me' : ''}" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('');
        html += `
        <div class="hist">${bars}</div>
        <div class="hist-axis"><span>ふるり値 ${d.lo.toFixed(2)}</span><span>${d.hi.toFixed(2)}</span></div>
        <p class="dist-note">${info.jp}PT の提出 ${d.n}人 (1人1票・直近120日) の分布。色付きがあなた。
            真ん中の人はふるり値 <strong>${d.median.toFixed(2)}</strong> です。</p>`;
    }
    // 同一編成
    if (r.characters && r.compDist) {
        const cd = r.compDist;
        if (cd.n >= MIN_N_COMP) {
            const cp = topPercentFromCounts(cd.above, cd.n);
            html += `<p class="dist-note">🧩 同じ編成 ${cd.n}人の中では <strong>上位 ${cp}%</strong> です。</p>`;
        } else {
            html += `<p class="dist-note">🧩 同じ編成の提出は ${cd.n}人 (${MIN_N_COMP}人で編成内比較が解禁)</p>`;
        }
    }
    return html;
}

// ---------- シェアカード ----------
async function buildShareCard() {
    if (!results || results.length === 0) return null;
    if (shareBlob) return shareBlob;
    const cv = $('shareCanvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const multi = results.length > 1;
    const mainInfo = ATTR_INFO[results[0].attribute];
    const mainColor = multi ? '#46A0FF' : mainInfo.color;
    const mainScore = multi
        ? results.reduce((s, r) => s + r.score, 0) / results.length
        : results[0].score;

    // 背景
    ctx.fillStyle = '#14161A';
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, mainColor);
    grad.addColorStop(1, mainColor + '55');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 14);
    const rg = ctx.createRadialGradient(W - 140, 130, 0, W - 140, 130, 320);
    rg.addColorStop(0, mainColor + '40');
    rg.addColorStop(1, mainColor + '00');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);

    const F = "'Noto Sans JP', sans-serif";
    ctx.fillStyle = '#8A9097';
    ctx.font = `900 30px ${F}`;
    ctx.fillText('SHIRISUKO PAD GB', 70, 92);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `900 56px ${F}`;
    ctx.fillText(multi ? `ふるり値 (${results.length}凸平均)` : 'ふるり値', 70, 210);
    ctx.fillStyle = mainColor;
    ctx.font = `900 190px ${F}`;
    ctx.fillText(mainScore.toFixed(2), 70, 400);

    if (multi) {
        // 凸ごとの内訳
        let x = 74;
        for (const r of results) {
            const inf = ATTR_INFO[r.attribute];
            try {
                const icon = await loadImage(inf.icon);
                ctx.drawImage(icon, x, 440, 48, 48);
            } catch { /* アイコンなしでも続行 */ }
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `900 40px ${F}`;
            const t = ` ${r.score.toFixed(2)}`;
            ctx.fillText(t, x + 50, 478);
            x += 50 + ctx.measureText(t).width + 40;
        }
        ctx.fillStyle = '#A4AAB0';
        ctx.font = `700 30px ${F}`;
        ctx.fillText(`SLv ${results[0].slv}`, 70, 570);
    } else {
        const r = results[0];
        try {
            const icon = await loadImage(mainInfo.icon);
            ctx.drawImage(icon, 74, 440, 56, 56);
        } catch { /* アイコンなしでも続行 */ }
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `900 44px ${F}`;
        ctx.fillText(`${mainInfo.jp}PT`, 146, 484);
        ctx.fillStyle = '#A4AAB0';
        ctx.font = `700 32px ${F}`;
        ctx.fillText(`SLv ${r.slv} / ${(r.damage / 1e9).toFixed(2)} B`, 340, 484);
        const pct = (r.dist && r.dist.n >= MIN_N_ALL) ? topPercentFromCounts(r.dist.above, r.dist.n) : null;
        if (pct != null) {
            ctx.fillStyle = mainColor;
            ctx.font = `900 46px ${F}`;
            const pctText = `上位 ${pct}%`;
            const pctW = ctx.measureText(pctText).width;
            ctx.fillText(pctText, 70, 580);
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 30px ${F}`;
            ctx.fillText(`(${r.dist.n}人中)`, 70 + pctW + 24, 578);
        }
    }

    ctx.fillStyle = '#6B7178';
    ctx.font = `700 28px ${F}`;
    ctx.textAlign = 'right';
    ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W - 60, H - 44);
    ctx.textAlign = 'left';

    shareBlob = await new Promise(res => cv.toBlob(res, 'image/png'));
    return shareBlob;
}

async function loadImage(src) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });
}

function shareText() {
    if (results.length > 1) {
        const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
        const parts = results.map(r => `${ATTR_INFO[r.attribute].jp}${r.score.toFixed(2)}`).join('/');
        return `ふるり値 平均${avg.toFixed(2)} (${parts}) #ふるり値チェッカー #NIKKE`;
    }
    const r = results[0];
    const pct = (r.dist && r.dist.n >= MIN_N_ALL) ? topPercentFromCounts(r.dist.above, r.dist.n) : null;
    return `ふるり値 ${r.score.toFixed(2)} (${ATTR_INFO[r.attribute].jp}PT)${pct != null ? ` — 上位${pct}%!` : ''} #ふるり値チェッカー #NIKKE`;
}

async function onShare() {
    if (!results) return;
    try {
        await document.fonts.ready;   // Canvas に Noto Sans JP を確実に効かせる
        const blob = await buildShareCard();
        const file = new File([blob], 'fururi-score.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], text: `${shareText()}\n${SITE_URL}` });
            return;
        }
    } catch (e) {
        if (e.name === 'AbortError') return;   // ユーザーがキャンセル
        console.warn('share失敗:', e);
    }
    // フォールバック: X インテント (画像はプレビュー表示して手動添付を促す)
    await previewCard();
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText())}&url=${encodeURIComponent(SITE_URL)}`, '_blank');
    toast('画像は下のプレビューを長押し保存して添付してください');
}

async function onSave() {
    if (!results) return;
    await document.fonts.ready;
    const blob = await buildShareCard();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fururi-score.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    await previewCard();
}

async function previewCard() {
    const blob = await buildShareCard();
    const img = $('cardPreview');
    img.src = URL.createObjectURL(blob);
    img.style.display = 'block';
}

// ---------- misc ----------
let toastTimer = null;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

init().catch(e => {
    console.error(e);
    toast('データの読み込みに失敗しました。再読み込みしてください。');
});
