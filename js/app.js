// しりすこPAD GB — ふるり値チェッカー UIロジック
// 3凸まとめ入力 + サーバー集計の分布表示 (しきい値ゲート付き)
// ふるり値の計算はサーバー側のみ (SLv補正テーブル秘匿のため) — 送信の返事で score を受け取る
import { ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput } from './calc.js';
import { backendConfigured, submitSet, fetchDistribution, fetchSiteState } from './backend.js';
import { escapeHtml, THRESHOLDS, ATTR_INFO, SITE_URL } from './shared.js';
import { buildShareCard } from './sharecard.js';
import { BURST_COLORS, BURST_DARK_TEXT, makeCharResolver, burstsOf, tileHTML } from './tiles.js';

// 解禁しきい値は shared.js の THRESHOLDS に一元化 (実ゲートはサーバーが強制)
const MAX_ATTACKS = 3;
const LAST_KEY = 'spg_last_result';   // 前回の測定 (localStorage) — 再訪時に分布だけ見直せる

const $ = (id) => document.getElementById(id);

let base = null, presets = null, characters = null, raid = null, site = null, siteConf = null;
let season = null;       // 送信・open時表示のシーズン (= base.version)
let viewSeason = null;   // 分布を見るシーズン (open→season / between・maintenance→display_season)
let mode = 'open';       // 'open' | 'between' | 'maintenance'
let attacks = [newAttack()];
let results = null;        // シェア用の測定結果
let shareBlob = null;

// 属性パネルの表示順 (raid.order があればそれ、なければ既定)
function orderedAttrs() {
    const o = raid?.order;
    if (Array.isArray(o) && o.length === 5 && new Set(o).size === 5 && o.every(a => ATTRS.includes(a))) return o;
    return ATTRS;
}

function newAttack() {
    return {
        attribute: null, damage: '',
        slots: [null, null, null, null, null],   // バースト枠ごとの選択キャラ (画像ファイル名)
        template: 'standard', activeSlot: 0,
        compOpen: false,
    };
}

const selChars = (a) => a.slots.filter(Boolean);
// ID → キャラ情報 (characters.json 読み込み後に差し替わる)
let infoOf = () => null;
const nameOf = (id) => infoOf(id)?.name ?? '';
const burstsOfId = (id) => burstsOf(infoOf(id));
// 同一キャラ判定キー (旧アイコン違いのIDも代表IDに解決される)
const charKeyOf = (id) => infoOf(id)?.id ?? id;
// 編成機能が使えるか (characters.json v2 が読めていること)
const compReady = () => characters?._format === 2;

// ---------- 初期化 ----------
async function init() {
    const [b, p, c, rd, st, sc] = await Promise.all([
        fetch('./data/base.json').then(x => x.json()),
        fetch('./data/presets.json').then(x => x.json()).catch(() => null),
        fetch('./data/characters.json').then(x => x.json()).catch(() => null),
        fetch('./data/raid.json').then(x => x.json()).catch(() => null),
        fetchSiteState().catch(() => null),
        fetch('./data/site.json').then(x => x.json()).catch(() => null),
    ]);
    base = b; presets = p; characters = c; raid = rd; site = st; siteConf = sc;
    infoOf = makeCharResolver(characters);
    season = base.version;
    mode = site?.status ?? 'open';   // site_state が読めない (05未適用/未設定) 時は open 扱い
    viewSeason = (mode === 'open') ? season : (site?.display_season ?? null);
    $('baseVersionLabel').textContent = `${base.version} (基準者${base.basePlayer} SLv ${base.baseSlv})`;
    $('thresholdAllLabel').textContent = THRESHOLDS.dist;
    $('thresholdCompLabel').textContent = THRESHOLDS.comp;
    $('slvMinus').addEventListener('click', () => stepSlv(-1));
    $('slvPlus').addEventListener('click', () => stepSlv(1));
    $('slv').addEventListener('input', onSlvChanged);
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
    applyMode();            // open 以外は測定UIを隠して告知を出す
    renderRecallBanner();   // 前回測定があれば「最新の分布を見る」を出す
    applySiteConf();        // ユニオン募集カード + 連絡先X (data/site.json)
}

// data/site.json (運用設定): 募集カードの出し入れと連絡先Xの埋め込み。
// X の ID は英数字とアンダースコアのみ許可 (リンク先の安全確保)。
function applySiteConf() {
    const xid = /^[A-Za-z0-9_]{1,15}$/.test(siteConf?.xAccount ?? '') ? siteConf.xAccount : null;
    if (xid) {
        document.querySelectorAll('.contact-x').forEach(el => {
            el.innerHTML = `<a href="https://x.com/${xid}" target="_blank" rel="noopener">X @${xid}</a>`;
        });
    }
    const r = siteConf?.recruit;
    const host = $('recruitArea');
    if (!host || !r?.enabled || !xid) return;
    host.innerHTML = `
    <section class="card recruit-card">
        <h2>📣 ${escapeHtml(r.title || 'メンバー募集中')}</h2>
        <p class="recruit-note">${escapeHtml(r.note || '')}</p>
        <a class="x-btn" href="https://x.com/${xid}" target="_blank" rel="noopener">𝕏 @${xid} を見る →</a>
    </section>`;
    host.style.display = 'block';
}

// 運用モードで測定UIを出し分け (between/maintenance は送信不可)
function applyMode() {
    const notice = $('siteNotice');
    if (mode === 'open') {
        notice.style.display = 'none';
        $('measureArea').style.display = '';
        return;
    }
    $('measureArea').style.display = 'none';
    if (mode === 'maintenance') {
        notice.innerHTML = `<div class="notice"><h2>🚧 工事中です</h2>
            <p>${escapeHtml(site?.message || 'メンテナンス中です。しばらくお待ちください。')}</p></div>`;
    } else {   // between
        const canView = !!viewSeason;
        notice.innerHTML = `<div class="notice"><h2>⏳ 次シーズン準備中</h2>
            <p>${escapeHtml(site?.message || '次のレイドのふるり基準を準備中です。しばらくお待ちください。')}${
                canView ? '<br>前シーズンの結果は <a href="./stats.html">📊 みんなのデータ</a> で見られます。' : ''}</p></div>`;
    }
    notice.style.display = 'block';
}

// ---------- 前回結果の記憶・再確認 ----------
// 送信ごとに測定内容を localStorage に保存 → 再訪時に、新しい行を挿入せず
// 保存済みスコアで分布だけ取り直して確認できる (解禁後に見に来た人向け・重複投稿を防ぐ)
function saveLastResult(items) {
    try {
        localStorage.setItem(LAST_KEY, JSON.stringify({
            savedAt: season,
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
        // 今見ているシーズン (viewSeason) と一致する保存だけ復元 (シーズンが変わったら出さない)
        if (!v || v.savedAt !== viewSeason || !Array.isArray(v.items) || v.items.length === 0) return null;
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
                fetchDistribution({ attribute: it.attribute, season: viewSeason, score: it.score }),
                compKey
                    ? fetchDistribution({ attribute: it.attribute, season: viewSeason, score: it.score, compKey })
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
    showShareCardPreview();
    $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (btn) { btn.disabled = false; btn.textContent = '最新の分布を見る'; }
}

function stepSlv(d) {
    const el = $('slv');
    const v = parseInt(el.value) || 0;
    el.value = Math.max(1, Math.min(1000, v + d));
    onSlvChanged();
}

const slvValid = () => { const v = parseInt($('slv').value); return v >= 1 && v <= 1000; };

// SLv の入力状態が変わったら、凸入力の出し入れを判定してから状態更新
// (「測定が押せない」の原因第1位が SLv 未入力だったため、SLv を入れるまで凸カードを出さない)
let slvWasValid = null;
function onSlvChanged() {
    const ok = slvValid();
    if (ok !== slvWasValid) { slvWasValid = ok; renderAttacks(); }
    else updateSubmitState();
}

function updateSubmitState() {
    const ok = slvValid() &&
        attacks.every(a => a.attribute && parseDamageInput(a.damage) > 0);
    $('submitBtn').disabled = !ok;
    $('addAtkBtn').disabled = attacks.length >= MAX_ATTACKS;
}

// ---------- 凸カードの描画 ----------
function renderAttacks() {
    const area = $('attacksArea');
    if (!slvValid()) {
        // STEP1 が済むまで凸入力は出さない (ガイドだけ表示)
        area.innerHTML = `
        <section class="card slv-gate">
            <p class="slv-gate-txt">⬆️ まず <strong>STEP 1 の SLv (シンクロレベル)</strong> を入力してください。<br>
            入力すると凸の入力があらわれます。</p>
        </section>`;
        $('addAtkBtn').style.display = 'none';
        $('submitBtn').disabled = true;
        return;
    }
    $('addAtkBtn').style.display = '';
    area.innerHTML = attacks.map((a, i) => attackCardHTML(a, i)).join('');
    area.querySelectorAll('.atk-card').forEach(card => bindAttackCard(card));
    updateSubmitState();
}

function attackCardHTML(a, i) {
    const info = a.attribute ? ATTR_INFO[a.attribute] : null;
    const title = attacks.length > 1 ? `凸${i + 1}` : '今回の凸';
    const delBtn = attacks.length > 1 ? `<button type="button" class="atk-del">✕ 削除</button>` : '';
    const attrBtns = orderedAttrs().map(attr => {
        const ai = ATTR_INFO[attr];
        return `
        <button type="button" class="attr-btn${a.attribute === attr ? ' active' : ''}" data-attr="${attr}"
                style="--ac:${ai.color};">
            <span class="ico">${ai.jp[0]}</span>
            <span class="name">${ai.jp}PT</span>
        </button>`;
    }).join('');
    const dmg = a.damage ? ` value="${escapeHtml(a.damage)}"` : '';
    return `
    <section class="card atk-card" data-i="${i}">
        <h2><span class="step-num">2</span>${title}${delBtn}</h2>
        <div class="attr-grid">${attrBtns}</div>
        <p class="vs-note">${info && raid?.bosses?.[a.attribute]
            ? `⚔ 相手は <strong style="color:${ATTR_INFO[info.enemy].color};">${ATTR_INFO[info.enemy].jp}</strong>属性ボス「<strong>${escapeHtml(raid.bosses[a.attribute])}</strong>」 (${escapeHtml(raid.season || '')} シーズン)`
            : `PT属性を選択してください (そのPTで殴った相手ボスが表示されます)`}</p>
        <div style="margin-top:12px;">
            <p class="hint" style="margin-bottom:6px;">与えたダメージを <strong>B (10億) 単位</strong>で (例: 13.18)。フル桁の貼り付けもOK</p>
            <div class="dmg-field">
                <input class="atk-damage" type="text" inputmode="decimal" placeholder="例: 13.18"${dmg}>
                <span class="dmg-unit">B</span>
            </div>
            <p class="preview">${damagePreviewText(a.damage)}</p>
        </div>
        <details class="comp"${a.compOpen ? ' open' : ''}>
            <summary><span class="sum-label">キャラ編成</span><span class="pill">任意</span><span class="sum-faces">${summaryFacesHTML(a)}</span><span class="chev">▼</span></summary>
            <div class="comp-body">${compBodyHTML(a)}</div>
        </details>
    </section>`;
}

function compBodyHTML(a) {
    if (!a.attribute) return `<p class="hint" style="margin-top:8px;">先にPT属性を選ぶと編成を選択できます</p>`;
    if (!compReady()) return `<p class="hint" style="margin-top:8px;">キャラデータを読み込めなかったため、今回は編成なしで送信できます</p>`;
    const ap = presets?.attributes?.[a.attribute] ?? { topChars: [], topComps: [] };
    const sel = selChars(a);
    const presetRows = (ap.topComps || []).map((c, pi) => {
        const isSel = sel.length === 5 && c.chars.every(x => sel.includes(x));
        const arrs = (Array.isArray(c.arr) ? c.arr : []).filter(x => Array.isArray(x.chars) && x.chars.length === 5);
        // 押すと配置 (並び順) を選ぶ。配置が1種類しかなければ選択肢は出さず即適用
        const arrPicker = a.arrPick === pi && arrs.length > 1 ? `
        <div class="arr-pick">
            <p class="hint" style="margin:2px 0 4px;">どの並び (配置) で使いますか? — 左から配置スロット順</p>
            ${arrs.map((x, xi) => `
            <button type="button" class="arr-opt" data-preset="${pi}" data-arr="${xi}">
                <span class="preset-faces">${x.chars.map(img => tileHTML(infoOf(img), { xs: true })).join('')}</span>
                <span class="arr-n">${x.n}回</span>
            </button>`).join('')}
        </div>` : '';
        return `
        <button type="button" class="preset-row${isSel ? ' active' : ''}" data-preset="${pi}">
            <span class="preset-faces">${c.chars.map(img => tileHTML(infoOf(img), { xs: true })).join('')}</span>
            <span class="preset-meta">
                <span class="pill">使用率TOP${pi + 1}</span>
                <span class="hint">使用 ${c.count}回 (〜${c.lastMonth})</span>
            </span>
        </button>${arrPicker}`;
    }).join('');
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
                <span class="slot-b${sb && BURST_DARK_TEXT.has(sb) ? ' dark' : ''}">${sb || '自由'}</span>
                ${img ? tileHTML(infoOf(img), { strip: false }) : `<span class="slot-plus">＋</span>`}
            </button>`;
        }).join('')}</div>
        <div class="comp-status">${compStatusText(a)}</div>
        ${pickerGridHTML(a, ap)}`;
}

// アクティブ枠のバーストに合う候補を表示 (Λ・未分類はどの枠にも出す)。
// 全キャラが対象。ユニオンでの使用実績が多い順 → 名前順に並べる。
function pickerGridHTML(a, ap) {
    const slotBurst = templateById(a.template).slots[a.activeSlot];
    // 使用実績 (presets の topChars) を代表IDに集計して並び順に使う
    const usage = new Map();
    for (const { img, count } of (ap.topChars || [])) {
        const cid = charKeyOf(img);
        usage.set(cid, (usage.get(cid) || 0) + count);
    }
    const all = Object.keys(characters.chars)
        .sort((x, y) => (usage.get(y) || 0) - (usage.get(x) || 0) ||
            String(nameOf(x)).localeCompare(String(nameOf(y)), 'ja'));
    const groups = { match: [], lambda: [], unknown: [] };
    for (const id of all) {
        const info = infoOf(id);
        const bs = burstsOf(info);
        if (!burstMatchesSlot(bs, slotBurst)) continue;
        (info.burst === 'BΛ' ? groups.lambda : !info.burst ? groups.unknown : groups.match).push(id);
    }
    const ordered = [...groups.match, ...groups.lambda, ...groups.unknown];
    if (ordered.length === 0) return `<p class="hint" style="margin-top:8px;">この枠に合う候補がありません</p>`;
    const btn = (id) => {
        const si = a.slots.indexOf(id);
        return `
        <button type="button" data-img="${id}"${si >= 0 ? ` class="sel" data-n="${si + 1}"` : ''}>
            ${tileHTML(infoOf(id))}
        </button>`;
    };
    // ⭐ クイック選択: この枠に入るキャラのうち、ユニオン使用実績トップ8を大きめに常時表示
    // (文字タイル化で一覧の視認性が下がったため — 大多数が選ぶキャラへの最短経路を作る)
    const quick = ordered.filter(id => (usage.get(id) || 0) > 0).slice(0, 8);
    const rest = quick.length >= 4 ? ordered.filter(id => !quick.includes(id)) : ordered;
    const quickHtml = quick.length >= 4 ? `
        <p class="hint picker-label">⭐ よく使われるキャラ</p>
        <div class="picker-grid picker-quick">${quick.map(btn).join('')}</div>` : '';
    const label = slotBurst
        ? `<strong style="color:${BURST_COLORS[slotBurst]};">${slotBurst}</strong> の枠に入れる全キャラ${groups.lambda.length ? ' (Λ含む)' : ''}${groups.unknown.length ? ' + 未分類' : ''}`
        : `すべてのキャラ`;
    return `${quickHtml}<p class="hint picker-label">${label} — タップで枠にセット (よく使われる順)</p><div class="picker-grid named">${rest.map(id => btn(id)).join('')}</div>`;
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
            a.arrPick = null;   // 配置候補の開閉状態も属性ごとにリセット (Codex指摘)
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

// 折りたたみ見出しに出す選択済み編成のミニタイル (畳んでいても選択が見える — 実機FB)
function summaryFacesHTML(a) {
    const sel = selChars(a);
    if (sel.length === 0) return '';
    return sel.map(id => tileHTML(infoOf(id), { xs: true, strip: false })).join('') +
        `<span class="sum-count">${sel.length}/5</span>`;
}

// 編成エリアだけ再描画 (ダメージ入力のフォーカスを壊さない)。見出しのミニタイルも追随させる
function renderCompBody(card, a) {
    card.querySelector('.comp-body').innerHTML = compBodyHTML(a);
    const faces = card.querySelector('details.comp > summary .sum-faces');
    if (faces) faces.innerHTML = summaryFacesHTML(a);
    bindCompBody(card, a);
}

function bindCompBody(card, a) {
    const ap = presets?.attributes?.[a.attribute];
    // 指定の並び (配置) をそのまま枠に入れる。並び順がテンプレに順番どおり合うなら
    // そのテンプレで、合わなければ「自由」で順序を保存する (並びの情報を壊さない)
    const applyArrangement = (chars) => {
        const tmpl = BURST_TEMPLATES.find(t => t.id !== 'free' &&
            chars.every((id, k) => burstMatchesSlot(burstsOfId(id), t.slots[k])));
        a.template = tmpl ? tmpl.id : 'free';
        a.slots = [...chars];
        a.activeSlot = 0;
        a.arrPick = null;
    };
    // プリセット: 押すと配置 (並び順) の選択肢を開く。1種類なら即適用。再タップで解除
    card.querySelectorAll('.preset-row').forEach(row => {
        row.addEventListener('click', () => {
            const pi = Number(row.dataset.preset);
            const c = ap.topComps[pi];
            const sel = selChars(a);
            if (sel.length === 5 && c.chars.every(x => sel.includes(x))) {
                a.slots = [null, null, null, null, null];
                a.arrPick = null;
            } else {
                const arrs = (Array.isArray(c.arr) ? c.arr : []).filter(x => Array.isArray(x.chars) && x.chars.length === 5);
                if (arrs.length > 1) {
                    a.arrPick = a.arrPick === pi ? null : pi;   // 配置の選択肢を開閉
                } else {
                    applyArrangement(arrs[0]?.chars ?? c.chars);
                }
            }
            renderCompBody(card, a);
        });
    });
    // 配置 (並び順) の選択
    card.querySelectorAll('.arr-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = ap.topComps[Number(btn.dataset.preset)];
            const x = c.arr[Number(btn.dataset.arr)];
            applyArrangement(x.chars);
            renderCompBody(card, a);
        });
    });
    // バースト構成テンプレート切替 (選択済みキャラは合う枠に詰め直す)
    card.querySelectorAll('.tmpl-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            if (a.template === chip.dataset.tmpl) return;
            a.template = chip.dataset.tmpl;
            const { slots, dropped } = reslotChars(selChars(a), burstsOfId, templateById(a.template).slots);
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
            } else {
                a.slots[a.activeSlot] = img;
                // 次の空き枠へ (後ろ優先 → 無ければ前の空き枠 → 全部埋まっていれば据え置き)
                const next = a.slots.findIndex((s, k) => s === null && k > a.activeSlot);
                const wrap = a.slots.indexOf(null);
                a.activeSlot = next >= 0 ? next : (wrap >= 0 ? wrap : a.activeSlot);
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
        returned = await submitSet(items, season);
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
                fetchDistribution({ attribute: it.attribute, season, score }),
                compKey
                    ? fetchDistribution({ attribute: it.attribute, season, score, compKey })
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

    showShareCardPreview();
    $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });

    btn.textContent = '送信して測定する';
    updateSubmitState();
}

function renderResults() {
    const area = $('resultsArea');
    const multi = results.length > 1;
    let html = results.map((r, i) => resultCardHTML(r, i, multi)).join('');
    if (multi) {
        // 総合 = 各凸の中央値比の平均。ふるり値は属性ごとに基準ボスが違うため、
        // 属性をまたいだ「ふるり値の合算」はしない (運営判断 2026-07-30)。
        // 全凸の分布が解禁されているときだけ出せる
        const ratios = results.map(r =>
            (r.dist && !r.dist.gated && Array.isArray(r.dist.bins) && r.dist.median > 0)
                ? r.score / r.dist.median : null);
        const totalPct = ratios.every(x => x != null)
            ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) : null;
        html += `
        <section class="card set-card">
            <div class="score-label">🏅 ${results.length}凸の総合</div>
            <div class="score-big">${totalPct != null ? `${totalPct}<span style="font-size:26px;">%</span>` : '—'}</div>
            <div class="pill-row">
                <span class="pill">各凸の中央値比の平均</span>
                ${results.map((r, ri) => `<span class="pill" style="color:${ATTR_INFO[r.attribute].color};">${ATTR_INFO[r.attribute].jp} ${ratios[ri] != null ? `${Math.round(ratios[ri] * 100)}%` : r.score.toFixed(2)}</span>`).join('')}
            </div>
            <p class="dist-note">${totalPct != null
                ? `総合 ${totalPct}% = みんなの真ん中 (100%) と比べた${results.length}凸の総合力。ボスごとのダメージの通りやすさは各属性の中央値で補正済みです。`
                : `※ 総合 (各凸の中央値比の平均) は、凸した全属性の分布が解禁されると表示されます`}</p>
        </section>`;
    }
    area.innerHTML = html;
}

function resultCardHTML(r, i, multi) {
    const info = ATTR_INFO[r.attribute];
    const title = multi ? `凸${i + 1} の測定結果` : 'の測定結果';

    let distHtml = '';
    if (r.fetchError) {
        distHtml = `<p class="dist-note">分布データを取得できませんでした (スコアは正常です)</p>`;
    } else if (r.dist) {
        distHtml = distSectionHTML(r, info);
    }

    // 分布本体はサーバーが閾値以上のときだけ返す (gated / bins欠如なら未解禁)。
    // フィードバックは順位ではなく「中央値=100%としたときの%」(運営方針 2026-07-30)
    const distReady = r.dist && !r.dist.gated && Array.isArray(r.dist.bins);
    const medianPct = distReady && r.dist.median > 0 ? Math.round((r.score / r.dist.median) * 100) : null;
    const pill = medianPct != null
        ? `<span class="rank-pill">中央値比 ${medianPct}% / ${r.dist.n}人</span>` : '';

    return `
    <section class="card result-card">
        <div class="score-label"><strong style="color:${info.color};">${info.jp}PT</strong> ${title}${pill}</div>
        <div class="score-big">${r.score.toFixed(2)}</div>
        <div class="pill-row">
            <span class="pill">SLv ${r.slv}</span>
            <span class="pill">${(r.damage / 1e9).toFixed(3)} B</span>
            <span class="pill">基準 ${(base.bases[r.attribute].damage / 1e9).toFixed(2)} B @ SLv ${base.baseSlv}</span>
        </div>
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
        // 自分のビンの中心位置に黒吹き出しを立てる (端に寄りすぎたらクランプ)
        const tipPos = Math.min(92, Math.max(8, ((d.my_bin - 0.5) / d.bins.length) * 100));
        html += `
        <div class="hist"><div class="tooltip" style="left:${tipPos}%;">あなた ${r.score.toFixed(2)}</div>${bars}</div>
        <div class="hist-axis"><span>${d.lo.toFixed(2)}</span><span>中央値 ${d.median.toFixed(2)}</span><span>${d.hi.toFixed(2)}</span></div>
        <p class="dist-note">${info.jp}PT の提出 ${d.n}人 (1人1票・今シーズン) の分布。
            真ん中の人はふるり値 <strong>${d.median.toFixed(2)}</strong> です。</p>`;
    }
    // 同一編成 (サーバー閾値未満は gated)。こちらも中央値比で返す
    if (r.characters && r.compDist) {
        const cd = r.compDist;
        if (!cd.gated && Number.isFinite(cd.median) && cd.median > 0) {
            const cp = Math.round((r.score / cd.median) * 100);
            html += `<div class="comp-pos">🧩 同じ編成 ${cd.n}人の中央値と比べて <strong>${cp}%</strong> です</div>`;
        } else {
            html += `<div class="comp-pos">🧩 同じ編成の提出は ${cd.n}人 (${cd.need ?? THRESHOLDS.comp}人で編成内比較が解禁)</div>`;
        }
    }
    return html;
}

// ---------- シェアカード ----------
// 描画は sharecard.js。ここは結果ごとに1度だけ生成してキャッシュする薄いラッパ
async function getShareCard() {
    if (shareBlob) return shareBlob;
    shareBlob = await buildShareCard(results, $('shareCanvas'), { infoOf });
    return shareBlob;
}

// シェアカードを「まず見せる」: 生成してその場にプレビュー表示する
// (保存は 長押し/右クリック または ボタン — 見えてから保存できるのが正)。
// 世代トークンで連続送信の競合を防ぐ (遅れて完了した古い生成は捨てる — Codex指摘)。
let previewUrl = null;
let previewGen = 0;
function setPreviewImage(blob) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    const img = $('cardPreview');
    img.src = previewUrl;
    img.style.display = 'block';
    const hint = $('saveHint');
    if (hint) hint.style.display = 'block';
}
async function showShareCardPreview() {
    const gen = ++previewGen;
    shareBlob = null;
    $('shareCard').style.display = 'block';
    // 生成中は古いカードを見せない (前回結果の保存事故を防ぐ)
    $('cardPreview').style.display = 'none';
    const hint = $('saveHint');
    if (hint) hint.style.display = 'none';
    try {
        await document.fonts.ready;
        const blob = await buildShareCard(results, $('shareCanvas'), { infoOf });
        if (gen !== previewGen) return;   // その間に新しい測定が始まった → この結果は破棄
        shareBlob = blob;
        setPreviewImage(blob);
    } catch (e) {
        console.warn('シェアカード生成失敗:', e);
    }
}

function shareText() {
    if (results.length > 1) {
        const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
        const parts = results.map(r => `${ATTR_INFO[r.attribute].jp}${r.score.toFixed(2)}`).join('/');
        return `ふるり値 平均${avg.toFixed(2)} (${parts}) #ふるり値チェッカー #NIKKE`;
    }
    const r = results[0];
    const mp = (r.dist && !r.dist.gated && Array.isArray(r.dist.bins) && r.dist.median > 0)
        ? Math.round((r.score / r.dist.median) * 100) : null;
    return `ふるり値 ${r.score.toFixed(2)} (${ATTR_INFO[r.attribute].jp}PT)${mp != null ? ` — 中央値比${mp}%!` : ''} #ふるり値チェッカー #NIKKE`;
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
    setPreviewImage(blob);   // Object URL は setPreviewImage が一元管理 (漏れ防止 — Codex指摘)
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
