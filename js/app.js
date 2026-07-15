// しりすこPAD GB — ふるり値チェッカー UIロジック
// 3凸まとめ入力 + サーバー集計の分布表示 (しきい値ゲート付き)
// ふるり値の計算はサーバー側のみ (SLv補正テーブル秘匿のため) — 送信の返事で score を受け取る
import { topPercentFromCounts, ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput } from './calc.js';
import { backendConfigured, submitSet, fetchDistribution } from './backend.js';
import { escapeHtml, THRESHOLDS, ATTR_INFO, SITE_URL } from './shared.js';
import { buildShareCard } from './sharecard.js';

// バースト区分の表示色 (枠ラベル・バッジ)
const BURST_COLORS = { B1: '#1E78F0', B2: '#F59E0B', B3: '#FF3D44', 'BΛ': '#9B4DFF' };

// 解禁しきい値は shared.js の THRESHOLDS に一元化 (実ゲートはサーバーが強制)
const MAX_ATTACKS = 3;
const LAST_KEY = 'spg_last_result';   // 前回の測定 (localStorage) — 再訪時に分布だけ見直せる

const $ = (id) => document.getElementById(id);

let base = null, presets = null, characters = null, raid = null;
let attacks = [newAttack()];
let results = null;        // シェア用の測定結果
let shareBlob = null;

function newAttack() {
    return {
        attribute: null, damage: '',
        slots: [null, null, null, null, null],   // バースト枠ごとの選択キャラ (画像ファイル名)
        template: 'standard', activeSlot: 0,
        compOpen: false,
    };
}

const selChars = (a) => a.slots.filter(Boolean);
const burstOf = (img) => characters?.[img]?.burst ?? null;
const nameOf = (img) => characters?.[img]?.name ?? '';
// 同一キャラ判定キー (アイコン違いを同じキャラとして扱う。名前不明なら画像単位)
const charKeyOf = (img) => nameOf(img) || img;

// ---------- 初期化 ----------
async function init() {
    const [b, p, c, rd] = await Promise.all([
        fetch('./data/base.json').then(x => x.json()),
        fetch('./data/presets.json').then(x => x.json()).catch(() => null),
        fetch('./data/characters.json').then(x => x.json()).catch(() => null),
        fetch('./data/raid.json').then(x => x.json()).catch(() => null),
    ]);
    base = b; presets = p; characters = c; raid = rd;
    $('baseVersionLabel').textContent = `${base.version} (基準者${base.basePlayer} SLv ${base.baseSlv})`;
    $('thresholdAllLabel').textContent = THRESHOLDS.dist;
    $('thresholdCompLabel').textContent = THRESHOLDS.comp;
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
    renderRecallBanner();   // 前回測定があれば「最新の分布を見る」を出す
}

// ---------- 前回結果の記憶・再確認 ----------
// 送信ごとに測定内容を localStorage に保存 → 再訪時に、新しい行を挿入せず
// 保存済みスコアで分布だけ取り直して確認できる (解禁後に見に来た人向け・重複投稿を防ぐ)
function saveLastResult(items) {
    try {
        localStorage.setItem(LAST_KEY, JSON.stringify({
            savedAt: base.version,
            items: items.map(it => ({ attribute: it.attribute, slv: it.slv, damage: it.damage, score: it.score, characters: it.characters })),
        }));
    } catch { /* localStorage 不可でも致命ではない */ }
}

function loadLastResult() {
    try {
        const raw = localStorage.getItem(LAST_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        // 基準版が変わった (月次更新) 前回結果は比較できないので出さない
        if (!v || v.savedAt !== base.version || !Array.isArray(v.items) || v.items.length === 0) return null;
        return v;
    } catch { return null; }
}

function renderRecallBanner() {
    const host = $('recallBanner');
    if (!host) return;
    const last = loadLastResult();
    if (!last || !backendConfigured()) { host.style.display = 'none'; return; }
    const label = last.items.map(it => `${ATTR_INFO[it.attribute].jp} ${Number(it.score).toFixed(2)}`).join(' / ');
    host.innerHTML = `
        <div class="recall">
            <div class="recall-txt">前回の測定: <strong>${escapeHtml(label)}</strong></div>
            <button type="button" id="recallBtn" class="recall-btn">最新の分布を見る</button>
        </div>`;
    host.style.display = 'block';
    $('recallBtn').addEventListener('click', () => showRecalledDistribution(last));
}

// 保存済みスコアで分布だけ取り直す (送信=INSERT はしない)
async function showRecalledDistribution(last) {
    const btn = $('recallBtn');
    if (btn) { btn.disabled = true; btn.textContent = '確認中…'; }
    const items = last.items.map(it => ({
        attribute: it.attribute, slv: it.slv, damage: it.damage,
        characters: it.characters ?? null, score: Number(it.score),
    }));
    const dists = await Promise.all(items.map(async (it) => {
        try {
            const compKey = it.characters ? [...it.characters].sort().join('|') : null;
            const [dist, compDist] = await Promise.all([
                fetchDistribution({ attribute: it.attribute, score: it.score, baseVersion: base.version }),
                compKey
                    ? fetchDistribution({ attribute: it.attribute, score: it.score, baseVersion: base.version, compKey })
                    : Promise.resolve(null),
            ]);
            return { dist, compDist, fetchError: false };
        } catch (e) {
            console.warn('分布取得失敗:', e);
            return { dist: null, compDist: null, fetchError: true };
        }
    }));
    results = items.map((it, i) => ({ ...it, ...dists[i] }));
    renderResults();
    shareBlob = null;
    $('cardPreview').style.display = 'none';
    $('shareCard').style.display = 'block';
    $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (btn) { btn.disabled = false; btn.textContent = '最新の分布を見る'; }
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
        attacks.every(a => a.attribute && parseDamageInput(a.damage) > 0);
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
    const dmg = a.damage ? ` value="${escapeHtml(a.damage)}"` : '';
    return `
    <section class="card atk-card" data-i="${i}" style="${info ? `--ac:${info.color};` : ''}">
        <h2><span class="step-num">2</span>${title}${delBtn}</h2>
        <p class="hint" style="margin-bottom:8px;">PT属性を選択。⚔ の後ろは<strong>そのPTで殴る相手ボス</strong>です</p>
        <div class="attr-grid">${attrBtns}</div>
        ${info && raid?.bosses?.[a.attribute] ? `
        <p class="hint" style="margin-top:8px;">⚔ 相手は ${info.enemyJp}属性ボス「<strong style="color:${info.color};">${raid.bosses[a.attribute]}</strong>」 (${raid.raidKey} レイド)</p>` : ''}
        <div style="margin-top:12px;">
            <p class="hint" style="margin-bottom:6px;">与えたダメージを <strong>B (10億) 単位</strong>で (例: 13.18)。フル桁の貼り付けもOK</p>
            <div class="dmg-field">
                <input class="atk-damage" type="text" inputmode="decimal" placeholder="例: 13.18"${dmg}>
                <span class="dmg-unit">B</span>
            </div>
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
    const sel = selChars(a);
    const presetRows = (ap.topComps || []).map((c, pi) => `
        <button type="button" class="preset-row${sel.length === 5 && c.chars.every(x => sel.includes(x)) ? ' active' : ''}" data-preset="${pi}">
            <span class="preset-faces">${c.chars.map(img => `<img loading="lazy" src="./character-images/${img}" alt="">`).join('')}</span>
            <span class="preset-meta">
                <span class="pill">使用率TOP${pi + 1}</span>
                <span class="hint">ユニオン実績 ${c.count}回 (〜${c.lastMonth})</span>
            </span>
        </button>`).join('');
    // characters.json が読めない環境では旧来のフラットなグリッドに落とす
    if (!characters) {
        const pickerBtns = (ap.topChars || []).map(({ img }) =>
            `<button type="button" data-img="${img}"${sel.includes(img) ? ` class="sel" data-n="${sel.indexOf(img) + 1}"` : ''}>
                <img loading="lazy" src="./character-images/${img}" alt=""></button>`).join('');
        return `
        <p class="hint" style="margin-top:8px;">編成を登録すると「同じ編成の人たちの中での位置」の集計対象になります</p>
        ${presetRows}
        <div class="comp-status">${compStatusText(a)}</div>
        <div class="picker-grid">${pickerBtns}</div>`;
    }
    return `
        <p class="hint" style="margin-top:8px;">編成を登録すると「同じ編成の人たちの中での位置」の集計対象になります</p>
        ${presetRows}
        <div class="tmpl-chips">${BURST_TEMPLATES.map(t =>
            `<button type="button" class="tmpl-chip${a.template === t.id ? ' active' : ''}" data-tmpl="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div class="slot-row">${templateById(a.template).slots.map((sb, si) => {
            const img = a.slots[si];
            const color = sb ? BURST_COLORS[sb] : '#8A9097';
            return `
            <button type="button" class="slot${si === a.activeSlot ? ' active' : ''}" data-slot="${si}" style="--sb:${color};">
                <span class="slot-b">${sb || '自由'}</span>
                ${img ? `<img src="./character-images/${img}" alt="${escapeHtml(nameOf(img))}">` : `<span class="slot-plus">＋</span>`}
            </button>`;
        }).join('')}</div>
        <div class="comp-status">${compStatusText(a)}</div>
        ${pickerGridHTML(a, ap)}`;
}

// アクティブ枠のバーストに合う候補だけを表示 (Λ・未分類はどの枠にも出す)。
// 同一キャラのアイコン違いは1つにまとめる (選択中の変種があればそれを代表にする)
function pickerGridHTML(a, ap) {
    const slotBurst = templateById(a.template).slots[a.activeSlot];
    const groups = { match: [], lambda: [], unknown: [] };
    const seen = new Map();   // charKey → ordered内のindex参照用 {group, idx}
    for (const { img } of (ap.topChars || [])) {
        const b = burstOf(img);
        if (!burstMatchesSlot(b, slotBurst)) continue;
        const group = b === 'BΛ' ? groups.lambda : !b ? groups.unknown : groups.match;
        const key = charKeyOf(img);
        const prev = seen.get(key);
        if (prev) {
            // 選択中の変種を代表にする (使用率は先勝ち = 高い方)
            if (a.slots.includes(img)) prev.group[prev.idx] = img;
            continue;
        }
        seen.set(key, { group, idx: group.length });
        group.push(img);
    }
    const ordered = [...groups.match, ...groups.lambda, ...groups.unknown];
    if (ordered.length === 0) return `<p class="hint" style="margin-top:8px;">この枠に合う候補がありません</p>`;
    const btns = ordered.map(img => {
        const b = burstOf(img);
        const si = a.slots.indexOf(img);
        return `
        <button type="button" data-img="${img}"${si >= 0 ? ` class="sel" data-n="${si + 1}"` : ''}>
            <img loading="lazy" src="./character-images/${img}" alt="${escapeHtml(nameOf(img))}">
            ${b === 'BΛ' ? `<span class="lam-badge">Λ</span>` : ''}
            <span class="cname">${escapeHtml(nameOf(img) || '？')}</span>
        </button>`;
    }).join('');
    const label = slotBurst
        ? `<strong style="color:${BURST_COLORS[slotBurst]};">${slotBurst}</strong> の枠に入れるキャラ${groups.lambda.length ? ' (Λ含む)' : ''}${groups.unknown.length ? ' + 未分類' : ''}`
        : `すべてのキャラ`;
    return `<p class="hint picker-label">${label} — タップで枠にセット</p><div class="picker-grid named">${btns}</div>`;
}

function compStatusText(a) {
    const n = selChars(a).length;
    return n === 0 ? '未選択 (編成なしで送信できます)' :
        n === 5 ? '✓ 5体選択済み — この編成で送信されます' :
        `${n} / 5 体選択中 (5体そろうと編成つきで送信)`;
}

function damagePreviewText(v) {
    if (!String(v ?? '').trim()) return ' ';
    const raw = parseDamageInput(v);
    if (!(raw > 0)) return '数値を確認してください';
    return `${(raw / 1e9).toFixed(2)} B = ${Math.round(raw).toLocaleString('ja-JP')}`;
}

function bindAttackCard(card) {
    const i = Number(card.dataset.i);
    const a = attacks[i];
    // 属性選択 → カード再描画 (編成は属性ごとに別物なのでリセット)
    card.querySelectorAll('.attr-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            a.attribute = btn.dataset.attr;
            a.slots = [null, null, null, null, null];
            a.activeSlot = 0;
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
    bindCompBody(card, a);
}

// 編成エリアだけ再描画 (ダメージ入力のフォーカスを壊さない)
function renderCompBody(card, a) {
    card.querySelector('.comp-body').innerHTML = compBodyHTML(a);
    bindCompBody(card, a);
}

function bindCompBody(card, a) {
    const ap = presets?.attributes?.[a.attribute];
    // プリセット: バースト構成を自動判定して枠に詰める。再タップで解除
    card.querySelectorAll('.preset-row').forEach(row => {
        row.addEventListener('click', () => {
            const c = ap.topComps[Number(row.dataset.preset)];
            const sel = selChars(a);
            if (sel.length === 5 && c.chars.every(x => sel.includes(x))) {
                a.slots = [null, null, null, null, null];
            } else {
                a.template = detectTemplate(c.chars, burstOf);
                a.slots = reslotChars(c.chars, burstOf, templateById(a.template).slots).slots;
            }
            a.activeSlot = 0;
            renderCompBody(card, a);
        });
    });
    // バースト構成テンプレート切替 (選択済みキャラは合う枠に詰め直す)
    card.querySelectorAll('.tmpl-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            if (a.template === chip.dataset.tmpl) return;
            a.template = chip.dataset.tmpl;
            const { slots, dropped } = reslotChars(selChars(a), burstOf, templateById(a.template).slots);
            a.slots = slots;
            a.activeSlot = Math.max(0, slots.indexOf(null));
            if (dropped.length) toast(`${dropped.map(x => nameOf(x) || '1体').join('・')} は枠が合わないため外れました`);
            renderCompBody(card, a);
        });
    });
    // 枠: タップで選択、選択中の枠を再タップで空にする
    card.querySelectorAll('.slot-row .slot').forEach(slotBtn => {
        slotBtn.addEventListener('click', () => {
            const si = Number(slotBtn.dataset.slot);
            if (a.activeSlot === si && a.slots[si]) a.slots[si] = null;
            else a.activeSlot = si;
            renderCompBody(card, a);
        });
    });
    // 候補ピッカー: アクティブ枠にセット / 選択済みキャラは再タップで外す
    // (アイコン違いも同一キャラとして扱い、二重編成を防ぐ)
    card.querySelectorAll('.picker-grid button').forEach(btn => {
        btn.addEventListener('click', () => {
            const img = btn.dataset.img;
            const existing = a.slots.findIndex(s => s && charKeyOf(s) === charKeyOf(img));
            if (existing >= 0) {
                a.slots[existing] = null;
                a.activeSlot = existing;
            } else if (characters) {
                a.slots[a.activeSlot] = img;
                // 次の空き枠へ (後ろ優先 → 無ければ前の空き枠 → 全部埋まっていれば据え置き)
                const next = a.slots.findIndex((s, k) => s === null && k > a.activeSlot);
                const wrap = a.slots.indexOf(null);
                a.activeSlot = next >= 0 ? next : (wrap >= 0 ? wrap : a.activeSlot);
            } else {
                // フォールバック (characters.json なし): 空き枠に順に詰める
                const empty = a.slots.indexOf(null);
                if (empty < 0) { toast('編成は5体までです'); return; }
                a.slots[empty] = img;
            }
            renderCompBody(card, a);
        });
    });
}

// ---------- 送信・測定 ----------
async function onSubmit() {
    const slv = parseInt($('slv').value);
    const items = attacks.map(a => ({
        attribute: a.attribute, slv,
        damage: parseDamageInput(a.damage),
        characters: selChars(a).length === 5 ? selChars(a).sort() : null,
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
        returned = await submitSet(items, base.version, raid?.raidKey ?? null);
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
    saveLastResult(results);   // 再訪時に分布だけ見直せるよう保存
    renderRecallBanner();

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

    // 分布本体はサーバーが閾値以上のときだけ返す (gated / bins欠如なら未解禁)
    const distReady = r.dist && !r.dist.gated && Array.isArray(r.dist.bins);
    const pct = distReady ? topPercentFromCounts(r.dist.above, r.dist.n) : null;
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
    const distReady = !d.gated && Array.isArray(d.bins);
    if (!distReady) {
        // 解禁前: 進捗を見せて送信を促す (必要人数はサーバーの need を優先)
        const need = d.need ?? THRESHOLDS.dist;
        const pctBar = Math.min(100, Math.round((d.n / need) * 100));
        html += `
        <div class="gate-note">
            <span>🔒</span>
            <span>みんなの分布は <strong>${need}人</strong> で解禁 — 現在 <strong>${d.n}人</strong>。シェアして仲間を増やそう!</span>
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
    // 同一編成 (サーバー閾値未満は gated)
    if (r.characters && r.compDist) {
        const cd = r.compDist;
        if (!cd.gated && Number.isFinite(cd.above)) {
            const cp = topPercentFromCounts(cd.above, cd.n);
            html += `<p class="dist-note">🧩 同じ編成 ${cd.n}人の中では <strong>上位 ${cp}%</strong> です。</p>`;
        } else {
            html += `<p class="dist-note">🧩 同じ編成の提出は ${cd.n}人 (${cd.need ?? THRESHOLDS.comp}人で編成内比較が解禁)</p>`;
        }
    }
    return html;
}

// ---------- シェアカード ----------
// 描画は sharecard.js。ここは結果ごとに1度だけ生成してキャッシュする薄いラッパ
async function getShareCard() {
    if (shareBlob) return shareBlob;
    shareBlob = await buildShareCard(results, $('shareCanvas'));
    return shareBlob;
}

function shareText() {
    if (results.length > 1) {
        const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
        const parts = results.map(r => `${ATTR_INFO[r.attribute].jp}${r.score.toFixed(2)}`).join('/');
        return `ふるり値 平均${avg.toFixed(2)} (${parts}) #ふるり値チェッカー #NIKKE`;
    }
    const r = results[0];
    const pct = (r.dist && !r.dist.gated && Array.isArray(r.dist.bins)) ? topPercentFromCounts(r.dist.above, r.dist.n) : null;
    return `ふるり値 ${r.score.toFixed(2)} (${ATTR_INFO[r.attribute].jp}PT)${pct != null ? ` — 上位${pct}%!` : ''} #ふるり値チェッカー #NIKKE`;
}

async function onShare() {
    if (!results) return;
    try {
        await document.fonts.ready;   // Canvas に Noto Sans JP を確実に効かせる
        const blob = await getShareCard();
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
    const blob = await getShareCard();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fururi-score.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    await previewCard();
}

async function previewCard() {
    const blob = await getShareCard();
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
