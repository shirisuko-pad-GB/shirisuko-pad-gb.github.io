// しりすこPAD GB — ふるり値チェッカー UIロジック
// 3凸まとめ入力 + サーバー集計の分布表示 (しきい値ゲート付き)
// ふるり値の計算はサーバー側のみ (SLv補正テーブル秘匿のため) — 送信の返事で score を受け取る
import { ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput } from './calc.js';
import { backendConfigured, submitSet, fetchDistribution, fetchSiteState, fetchCompInsights, markOwnFinish, correctOwnMeasurement } from './backend.js';
import { escapeHtml, THRESHOLDS, ATTR_INFO, SITE_URL, enablePullToRefresh } from './shared.js';
import { buildShareCard } from './sharecard.js';
import { BURST_COLORS, BURST_DARK_TEXT, makeCharResolver, burstsOf, tileHTML, sortForDisplay } from './tiles.js';

// 解禁しきい値は shared.js の THRESHOLDS に一元化 (実ゲートはサーバーが強制)
const MAX_ATTACKS = 3;
const LAST_KEY = 'spg_last_result';   // 前回の測定 (localStorage) — 再訪時に分布だけ見直せる

const $ = (id) => document.getElementById(id);

let base = null, presets = null, characters = null, raid = null, site = null, siteConf = null;
// 使用率・編成ランキングは **今シーズンの提出データ** (get_comp_insights) から作る。
// 属性ごとに1回だけ取得してキャッシュ (null=未取得 / {chars,comps}=取得済み / 'none'=データ不足)
const insightsCache = new Map();
let season = null;       // 送信・open時表示のシーズン (= base.version)
let viewSeason = null;   // 分布を見るシーズン (open→season / between・maintenance→display_season)
let mode = 'open';       // 'open' | 'between' | 'maintenance'
let attacks = [newAttack()];
let results = null;        // シェア用の測定結果
let shareBlob = null;
let correcting = null;     // 修正モード: {attribute} — 自分の過去提出をその属性ごと置き換える

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
        isFinish: false,   // 締め凸 (ボス撃破で戦闘が途中終了) — 分布・編成集計に入れない
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
        Promise.resolve(null),   // presets.json (過去シーズンのユニオン実績) は使わない — 今シーズンの提出データを使う
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
    renderBaseTeams();
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
    renderSlvNote();
    renderAttacks();
    updateSubmitState();
    applyMode();            // open 以外は測定UIを隠して告知を出す
    renderRecallBanner();   // 前回測定があれば「最新の分布を見る」を出す
    applySiteConf();        // ユニオン募集カード + 連絡先X (data/site.json)
    setTimeout(preloadLoadingGif, 2000);   // 送信前にキャッシュされるよう裏で読んでおく
    registerServiceWorker();               // ホーム画面に置けるように (PWA)
    enablePullToRefresh();                 // standalone だとブラウザの更新操作が無いので自前で
}

// Service Worker 登録 (PWA インストール用)。失敗しても機能は落ちないので静かに無視する。
// SW はアセット (画像) しかキャッシュしない — HTML/JS/data は常に最新を取りに行く設計
function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW登録失敗:', e));
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
    renderPartners();   // 掲載枠は募集カードの設定と独立 (募集を消しても掲載は残る)
    const r = siteConf?.recruit;
    const host = $('recruitArea');
    if (!host || !r?.enabled || !xid) return;
    host.innerHTML = `
    <section class="card recruit-card">
        <h2>📣 ${escapeHtml(r.title || 'メンバー募集中')}</h2>
        <img class="recruit-banner" src="./assets/recruit-banner.jpg"
             alt="ユニオン「推しりをすこれ部」メンバー募集バナー" loading="lazy">
        <p class="recruit-note">${escapeHtml(r.note || '')}</p>
        <a class="x-btn" href="https://x.com/${xid}" target="_blank" rel="noopener">𝕏 @${xid} を見る →</a>
    </section>`;
    // 画像が読めない環境では静かに消す (inline onerror は XSS 回帰検査で禁止のためリスナーで)
    const banner = host.querySelector('.recruit-banner');
    if (banner) banner.addEventListener('error', () => { banner.style.display = 'none'; });
    host.style.display = 'block';
}

// 提携ユニオン掲載枠 (site.json の partners)。他ユニオンさんへの配慮枠 —
// 募集カードの下に「素晴らしいユニオンさんたちが掲載中!」として並べる。
// url は https のみ許可・banner はリポジトリ内 (./assets/) の画像のみ (外部URLの画像は不可)
function renderPartners() {
    const host = $('partnerArea');
    const list = (Array.isArray(siteConf?.partners) ? siteConf.partners : [])
        .filter(p => typeof p?.url === 'string' && /^https:\/\//.test(p.url) && p?.name);
    if (!host || list.length === 0) return;
    host.innerHTML = `
    <section class="card partner-card">
        <h2>✨ 素晴らしいユニオンさんたちが掲載中!</h2>
        ${list.map(p => {
            const url = escapeHtml(p.url);
            const bannerOk = typeof p.banner === 'string' && !p.banner.includes('..')
                && /^\.\/assets\/[\w./-]+\.(png|webp|jpg|jpeg)$/.test(p.banner);
            // 遷移先ホストを併記する (短縮URLでも「どこへ飛ぶか」が事前に分かるように)
            let host = '';
            try { host = new URL(p.url).host; } catch { /* 検証済みなので通常来ない */ }
            // 画像は width/height を持たせて読み込み前から場所を確保 (レイアウトシフト防止)
            const w = Number.isFinite(p.bannerW) ? p.bannerW : 800;
            const h = Number.isFinite(p.bannerH) ? p.bannerH : 624;
            // 導線はロゴのクリックに一本化 (バナーが無いときだけ名前ボタンで代替)
            return `
        <div class="partner-row">
            ${bannerOk ? `
            <a class="partner-link" href="${url}" target="_blank" rel="noopener noreferrer">
                <img class="partner-banner" src="${escapeHtml(p.banner)}" alt="${escapeHtml(p.name)}" width="${w}" height="${h}" loading="lazy">
                <span class="partner-tap">👆 ロゴをタップでサイトへ${host ? ` (${escapeHtml(host)})` : ''}</span>
            </a>`
                : `<a class="partner-btn" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.name)} を見る →</a>
                   ${host ? `<p class="partner-host">遷移先: ${escapeHtml(host)}</p>` : ''}`}
            ${p.note ? `<p class="partner-note">${escapeHtml(p.note)}</p>` : ''}
        </div>`;
        }).join('')}
    </section>`;
    // バナーが読めない環境ではロゴ導線が消えるので、名前ボタンに置き換える
    host.querySelectorAll('.partner-banner').forEach(img => img.addEventListener('error', () => {
        const link = img.closest('.partner-link');
        if (!link) { img.style.display = 'none'; return; }
        link.className = 'partner-btn';
        link.innerHTML = `${escapeHtml(img.alt)} を見る →`;
    }));
    host.style.display = 'block';
}

// 今シーズンの提出データから「使用率TOP編成・よく使われるキャラ」を取得する。
// サーバー側でしきい値ゲート (10人未満は gated) がかかるので、少数データは自然に出ない
async function ensureInsights(attribute, onLoaded) {
    if (!attribute || insightsCache.has(attribute)) return;
    insightsCache.set(attribute, 'loading');
    try {
        const ins = await fetchCompInsights({ attribute, season: viewSeason ?? season });
        insightsCache.set(attribute, (ins && !ins.gated && ins.chars) ? ins : 'none');
    } catch { insightsCache.set(attribute, 'none'); }
    onLoaded?.();
}

// 属性の insights を「presets 互換の形」に変換 (topChars/topComps) — 未取得・不足なら空
function insightsOf(attribute) {
    const ins = insightsCache.get(attribute);
    if (!ins || ins === 'loading' || ins === 'none') return { topChars: [], topComps: [], n: 0, loading: ins === 'loading' };
    // DB は別名IDのまま保存されていることがあるので代表IDへ正規化してから使う
    // (未知IDは解決できないのでそのまま = 「？」タイル表示になる)
    const canon = (id) => infoOf(id)?.id ?? id;
    return {
        topChars: (ins.chars || []).map(c => ({ img: canon(c.img), count: c.count })),
        topComps: (ins.comps || []).map(c => ({
            chars: (c.chars || []).map(canon),
            count: c.n,
            median: c.median,
            // 並び順の内訳 (どの配置が多いか) も RPC が返すので引き継ぐ
            arr: (Array.isArray(c.arr) ? c.arr : [])
                .filter(x => Array.isArray(x.chars) && x.chars.length === 5)
                .map(x => ({ chars: x.chars.map(canon), n: x.n })),
        })),
        n: ins.n ?? 0,
    };
}

// 基準記録の開示: 属性ごとに「基準ダメージ + 基準編成 (5体タイル)」を小さく出す。
// 「何を基準に測られているか」を隠さないための説明パネル (data/base.json の bases[].team)
function renderBaseTeams() {
    const host = $('baseTeams');
    if (!host || !base?.bases) return;
    host.innerHTML = orderedAttrs().map(attr => {
        const b = base.bases[attr];
        if (!b) return '';
        const info = ATTR_INFO[attr];
        const boss = raid?.bosses?.[attr];
        const team = (compReady() && Array.isArray(b.team) && b.team.length === 5)
            ? `<span class="base-team">${sortForDisplay(b.team, infoOf).map(id => tileHTML(infoOf(id))).join('')}</span>` : '';
        return `
        <div class="base-row" style="--ac:${info.color};">
            <span class="base-attr">${info.jp}PT</span>
            <span class="base-dmg">${(b.damage / 1e9).toFixed(2)} B</span>
            <span class="hint">${b.source === 'actual' ? '実凸' : '模擬'}${boss ? ` · vs ${escapeHtml(boss)}` : ''}</span>
            ${team}
        </div>`;
    }).join('');
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
            items: items.map(it => ({ attribute: it.attribute, slv: it.slv, damage: it.damage, score: it.score, characters: it.characters, isFinish: it.isFinish === true })),
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
        // 対応範囲外の SLv を含む保存 (旧版・改変) は復元しない — 誤った結果を再表示しないため
        if (v.items.some(it => !Number.isInteger(it.slv) || it.slv < 1 || it.slv > SLV_MAX)) return null;
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
        isFinish: it.isFinish === true,
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
    const v = parseInt(el.value);
    if (Number.isNaN(v) && d < 0) return;   // 空欄で「−」はゲート解除しない (Codex指摘)
    el.value = Math.max(1, Math.min(SLV_MAX, (Number.isNaN(v) ? 0 : v) + d));
    onSlvChanged();
}

// 対応SLvの上限。SLv補正テーブル (めいでん+ふるりの実測) が 1〜1000 までのため。
// ⚠ 1000超に対応するときは、この定数・input[max]・サーバー側 (01_schema の CHECK と
//    slv_ratio の行) を揃えて広げること
const SLV_MAX = 1000;
// 「1000.5」「1e3」を parseInt で拾うと実際と違う SLv で測定してしまうため、整数表記のみ受理する
function slvOf() {
    const raw = String($('slv').value ?? '').trim();
    return /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
}
const slvValid = () => { const v = slvOf(); return Number.isInteger(v) && v >= 1 && v <= SLV_MAX; };
// 上限超 (未入力・不正入力と区別して案内するため)
const slvOver = () => { const v = slvOf(); return Number.isInteger(v) && v > SLV_MAX; };
// 整数でない入力 (小数・指数・記号) — 何が問題か分かるよう専用の案内を出す
const slvMalformed = () => {
    const raw = String($('slv').value ?? '').trim();
    return raw !== '' && !/^\d+$/.test(raw);
};

// SLv の入力状態が変わったら、凸入力の出し入れを判定してから状態更新
// (「測定が押せない」の原因第1位が SLv 未入力だったため、SLv を入れるまで凸カードを出さない)
let slvWasValid = null;
function onSlvChanged() {
    const ok = slvValid();
    renderSlvNote();
    if (ok !== slvWasValid) { slvWasValid = ok; renderAttacks(); }
    else updateSubmitState();
}

// SLv 欄の直下の注記。上限超のときだけ理由を出す (入力中に気づけるように)
function renderSlvNote() {
    const el = $('slvNote');
    if (!el) return;
    el.textContent = slvOver() ? `🙏 現在は SLv ${SLV_MAX} まで対応しています (補正データを検証中です)`
        : slvMalformed() ? 'SLv は整数で入力してください (例: 558)'
        : '';
    el.style.color = (slvOver() || slvMalformed()) ? 'var(--warn)' : '';
}

function updateSubmitState() {
    const ok = slvValid() &&
        attacks.every(a => a.attribute && parseDamageInput(a.damage) > 0);
    $('submitBtn').disabled = submitting || !ok;   // 送信中は入力イベントでも再有効化しない
    $('addAtkBtn').disabled = attacks.length >= MAX_ATTACKS;
}

// ---------- 凸カードの描画 ----------
function renderAttacks() {
    const area = $('attacksArea');
    if (!slvValid()) {
        // STEP1 が済むまで凸入力は出さない (ガイドだけ表示)
        area.innerHTML = slvOver() ? `
        <section class="card slv-gate">
            <p class="slv-gate-txt">🙏 <strong>SLv ${SLV_MAX} を超える方はもう少しお待ちください</strong><br>
            現在の SLv 補正データが <strong>SLv ${SLV_MAX} まで</strong>のため、それより上は正確に測れません。
            超上位帯の補正値を検証中で、揃い次第対応します。</p>
        </section>` : `
        <section class="card slv-gate">
            <p class="slv-gate-txt">⬆️ まず <strong>STEP 1 の SLv (シンクロレベル)</strong> を入力してください。<br>
            入力すると凸の入力があらわれます。</p>
        </section>`;
        $('addAtkBtn').style.display = 'none';
        $('submitBtn').disabled = true;
        return;
    }
    $('addAtkBtn').style.display = correcting ? 'none' : '';   // 修正は1属性ずつ
    area.innerHTML = attacks.map((a, i) => attackCardHTML(a, i)).join('');
    area.querySelectorAll('.atk-card').forEach(card => bindAttackCard(card));
    updateSubmitState();
}

function attackCardHTML(a, i) {
    const info = a.attribute ? ATTR_INFO[a.attribute] : null;
    // 修正モード: 属性は置き換え先を固定 (変えると別属性の行を消してしまうため)
    const title = correcting ? `✏️ ${info ? info.jp + 'PT' : ''} の提出を修正`
        : attacks.length > 1 ? `凸${i + 1}` : '今回の凸';
    const delBtn = correcting
        ? `<button type="button" class="atk-del corr-cancel">✕ 修正をやめる</button>`
        : attacks.length > 1 ? `<button type="button" class="atk-del">✕ 削除</button>` : '';
    const attrBtns = orderedAttrs().map(attr => {
        const ai = ATTR_INFO[attr];
        return `
        <button type="button" class="attr-btn${a.attribute === attr ? ' active' : ''}" data-attr="${attr}"
                style="--ac:${ai.color};"${correcting ? ' disabled' : ''}>
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
            <label class="finish-check">
                <input type="checkbox" class="atk-finish"${a.isFinish ? ' checked' : ''}>
                <span>🏁 締め凸だった <span class="finish-sub">(ボス撃破で戦闘が途中終了した凸)</span></span>
            </label>
            ${a.isFinish ? `<p class="hint finish-note">締め凸はダメージが途中で打ち切られるため、
                みんなの分布・編成集計には入りません (測定と記録は普通にできます)</p>` : ''}
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
    const ap = insightsOf(a.attribute);
    const sel = selChars(a);
    // 使用率TOP: 一覧は小タイルでコンパクトに (TOP3 + もっと見る)。
    // 行をタップすると「行内展開 (案A)」— 行がクリームになりそのまま下に膨らんで
    // 配置候補 (大タイル・名前全文) が出る。同じクリームの塊 = その行の中身、と構造で示す
    const allComps = (ap.topComps || []);
    const visComps = a.presetMore ? allComps : allComps.slice(0, 3);
    const moreCount = allComps.length - 3;
    const presetRows = visComps.map((c, pi) => {
        const isSel = sel.length === 5 && c.chars.every(x => sel.includes(x));
        return `
        <button type="button" class="preset-row${isSel ? ' active' : ''}" data-preset="${pi}">
            <span class="preset-faces">${sortForDisplay(c.chars, infoOf).map(img => tileHTML(infoOf(img), { xs: true })).join('')}</span>
            <span class="preset-meta">
                <span class="pill">今シーズンTOP${pi + 1}</span>
                <span class="hint">${c.count}人が使用${Number.isFinite(c.median) ? ` · 中央値 ${Number(c.median).toFixed(2)}` : ''}</span>
            </span>
        </button>`;
    }).join('') + (moreCount > 0 && !a.presetMore ? `
        <button type="button" class="preset-more">▼ もっと見る (使用率TOP4〜${3 + moreCount})</button>` : '');
    const presetHead = ap.topComps.length
        ? `<p class="hint" style="margin-top:8px;">👥 今シーズンの提出データから、よく使われている編成です (タップで選択)</p>`
        : `<p class="hint" style="margin-top:8px;">編成を登録すると「同じ編成の人たちの中での位置」の集計対象になります${ap.loading ? '' : '。今シーズンの提出が集まると「よく使われる編成」もここに出ます'}</p>`;
    return `
        ${presetHead}
        ${presetRows}
        <div class="tmpl-chips">${BURST_TEMPLATES.map(t =>
            `<button type="button" class="tmpl-chip${a.template === t.id ? ' active' : ''}" data-tmpl="${t.id}">${t.label}</button>`).join('')}
            ${selChars(a).length >= 2 ? `<button type="button" class="sort-chip">⇅ バースト順に整える</button>` : ''}
        </div>
        <p class="hint" style="margin-top:6px;">並び順は評価に影響しません (同じ5人なら同じ編成として集計されます)</p>
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
// 全キャラが対象。今シーズンの採用数が多い順 → 名前順 (提出が無いうちは名前順)。
function pickerGridHTML(a, ap) {
    const slotBurst = templateById(a.template).slots[a.activeSlot];
    // 今シーズンの採用数 (get_comp_insights の chars) を代表IDに集計して並び順に使う
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
            a.presetMore = false;  // 「もっと見る」もTOP3表示に戻す (Codex指摘)
            renderAttacks();
            // 今シーズンの提出データ (使用率・編成TOP) は属性ごとに遅延取得 → 届いたら編成欄だけ差し替え
            ensureInsights(a.attribute, () => {
                // 添字ではなく state の同一性で対象カードを探す (途中で凸カードを消しても追随する)
                const idx = attacks.indexOf(a);
                if (idx < 0 || a.attribute !== btn.dataset.attr) return;
                const cardNow = document.querySelector(`.atk-card[data-i="${idx}"]`);
                if (cardNow) renderCompBody(cardNow, a);
            });
        });
    });
    // ダメージ入力 (再描画せず state とプレビューだけ更新 — フォーカス維持)
    const dmgInput = card.querySelector('.atk-damage');
    dmgInput.addEventListener('input', () => {
        a.damage = dmgInput.value;
        card.querySelector('.preview').innerHTML = damagePreviewText(a.damage);
        updateSubmitState();
    });
    // 締め凸チェック (再描画して説明文を出し入れする — 離散操作なのでフォーカス問題なし)
    const finishCb = card.querySelector('.atk-finish');
    if (finishCb) finishCb.addEventListener('change', () => { a.isFinish = finishCb.checked; renderAttacks(); });
    // 削除 (修正モードでは「修正をやめる」として通常フォームへ戻す)
    const del = card.querySelector('.atk-del');
    if (del) del.addEventListener('click', () => {
        if (correcting) { cancelCorrection(); return; }
        attacks.splice(i, 1); renderAttacks();
    });
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
    const ap = insightsOf(a.attribute);   // 描画と同じ供給元 (今シーズンの提出データ)
    // 編成の並び順は評価に一切影響しない (集計は順不同の comp_key)。
    // 「どの順で入れるか」を悩ませないため、5人が決まったら常にバースト順 (B1→B2→B3→Λ)
    // に自動整列して枠へ入れる (2026-08-01 運営判断: 編成順は考慮しない)
    const applyComp = (chars) => {
        const ordered = sortForDisplay(chars, infoOf);
        const tmpl = BURST_TEMPLATES.find(t => t.id !== 'free' &&
            reslotChars(ordered, burstsOfId, t.slots).dropped.length === 0);
        a.template = tmpl ? tmpl.id : 'free';
        a.slots = tmpl ? reslotChars(ordered, burstsOfId, tmpl.slots).slots : [...ordered];
        a.activeSlot = 0;
    };
    // プリセット: 押すとその5人をそのまま採用 (並びは自動)。再タップで解除
    card.querySelectorAll('.preset-row').forEach(row => {
        row.addEventListener('click', () => {
            const pi = Number(row.dataset.preset);
            const c = ap.topComps?.[pi];
            if (!c) return;   // 再描画で行が入れ替わった直後などの保険
            const sel = selChars(a);
            if (sel.length === 5 && c.chars.every(x => sel.includes(x))) a.slots = [null, null, null, null, null];
            else applyComp(c.chars);
            renderCompBody(card, a);
        });
    });
    // ⇅ バースト順に整える (自由枠でも使える。並び順は評価に影響しないが見やすさのため)
    card.querySelectorAll('.sort-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            const ordered = sortForDisplay(selChars(a), infoOf);
            const fit = reslotChars(ordered, burstsOfId, templateById(a.template).slots);
            if (fit.dropped.length === 0) {
                a.slots = fit.slots;
            } else {
                // 今のテンプレ枠に収まらない構成 → 枠ラベルと中身が食い違うので「自由」に切り替える
                a.template = 'free';
                a.slots = [...ordered, null, null, null, null, null].slice(0, 5);
            }
            a.activeSlot = Math.max(0, a.slots.indexOf(null));
            renderCompBody(card, a);
        });
    });
    // もっと見る (使用率TOP4〜)
    card.querySelectorAll('.preset-more').forEach(btn => {
        btn.addEventListener('click', () => { a.presetMore = true; renderCompBody(card, a); });
    });
    // バースト構成テンプレート切替 (選択済みキャラは合う枠に詰め直す)
    card.querySelectorAll('.tmpl-chip[data-tmpl]').forEach(chip => {
        chip.addEventListener('click', () => {
            if (!chip.dataset.tmpl || a.template === chip.dataset.tmpl) return;
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
// ---------- 送信中オーバーレイ (ユニオンメンバー作の Now Loading GIF) ----------
// GIF (約700KB) は初回表示を邪魔しないよう遅延ロード。表示は最低 MIN_LOADING_MS
// キープしてチラつき (一瞬で消える) を防ぐ。
const MIN_LOADING_MS = 1000;   // 最低1秒は見せる (それ以降は実際の読み込み完了まで)
let loadingShownAt = 0;

function preloadLoadingGif() {
    const img = $('loadingGifImg');
    if (img && !img.getAttribute('src')) img.src = './assets/loading.gif';
}

function showLoading() {
    const el = $('loadingOverlay');
    if (!el) return;
    preloadLoadingGif();   // 未ロードならここから読み始める (表示しつつ流れてくる)
    loadingShownAt = Date.now();
    el.style.display = 'flex';
    // 表示中は背面を触れなくする (キーボードフォーカス = inert / スクロール = overflow)
    document.querySelector('.wrap')?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
}

// 即時クローズ (finally の保険用・待たない)。二重呼び出しは無害。
// ⚠ .wrap の inert / body の overflow はこのオーバーレイが唯一の管理者という前提
// (他機能で inert やスクロールロックを導入するときは所有権の整理が必要)
function forceCloseLoading() {
    const el = $('loadingOverlay');
    if (el) el.style.display = 'none';
    document.querySelector('.wrap')?.removeAttribute('inert');
    document.body.style.overflow = '';
}

async function hideLoading() {
    const el = $('loadingOverlay');
    if (!el) return;
    const rest = MIN_LOADING_MS - (Date.now() - loadingShownAt);
    if (rest > 0) await new Promise(r => setTimeout(r, rest));
    forceCloseLoading();
}

let submitting = false;   // 多重送信ガード (updateSubmitState がボタンを再有効化しないように)

// 修正モードの送信: 新規INSERTではなく「その属性の自分の行を置き換える」RPC。
// 成功したら localStorage の前回結果も差し替え、再確認フローで結果を出し直す
async function onSubmitCorrection() {
    const slv = slvOf();
    const a = attacks[0];
    const item = {
        attribute: a.attribute, slv,
        damage: parseDamageInput(a.damage),
        characters: selChars(a).length === 5 ? selChars(a).sort() : null,
        isFinish: a.isFinish === true,
    };
    if (!ATTRS.includes(item.attribute) || !(item.damage > 0) || !Number.isInteger(slv) || slv < 1 || slv > SLV_MAX) {
        toast('入力内容を確認してください');
        return;
    }
    const btn = $('submitBtn');
    try {
        submitting = true;
        btn.disabled = true;
        btn.textContent = '送信中…';
        showLoading();
        const { score } = await correctOwnMeasurement(item, season);
        // 前回結果の該当属性を置き換え (保存が無い・別シーズンなら単品で作り直す)
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { saved = null; }
        const newItem = { attribute: item.attribute, slv, damage: item.damage, score,
                          characters: item.characters, isFinish: item.isFinish };
        if (saved?.savedAt === season && Array.isArray(saved.items)) {
            const idx = saved.items.findIndex(it => it.attribute === item.attribute);
            if (idx >= 0) saved.items[idx] = newItem; else saved.items.push(newItem);
        } else {
            saved = { savedAt: season, items: [newItem] };
        }
        try { localStorage.setItem(LAST_KEY, JSON.stringify(saved)); } catch { /* 非致命 */ }
        await hideLoading();
        correcting = null;
        attacks = [newAttack()];
        renderAttacks();
        btn.textContent = '送信して測定する';
        toast('修正を保存しました (前の提出は置き換えられました)');
        renderRecallBanner();
        const last = loadLastResult();
        if (last) await showRecalledDistribution(last);
    } catch (e) {
        console.warn('修正失敗:', e);
        await hideLoading();
        toast('修正を保存できませんでした。通信環境を確認して再度お試しください');
    } finally {
        forceCloseLoading();
        submitting = false;
        btn.disabled = false;
        if (correcting) btn.textContent = '修正して送り直す';   // 失敗時は修正モードのまま再試行できる
        updateSubmitState();
    }
}

async function onSubmit() {
    if (submitting) return;
    if (correcting) return onSubmitCorrection();   // 修正モードは置き換えRPCへ
    const slv = slvOf();   // 整数表記のみ (小数・指数は NaN → 下のガードで弾く)
    const items = attacks.map(a => ({
        attribute: a.attribute, slv,
        damage: parseDamageInput(a.damage),
        characters: selChars(a).length === 5 ? selChars(a).sort() : null,
        isFinish: a.isFinish === true,
    }));
    if (items.some(it => !ATTRS.includes(it.attribute) || !(it.damage > 0)) || !Number.isInteger(slv) || slv < 1 || slv > SLV_MAX) {
        toast('入力内容を確認してください');
        return;
    }

    const btn = $('submitBtn');
    try {
        submitting = true;
        btn.disabled = true;
        btn.textContent = '送信中…';
        showLoading();

        // 計算はサーバー側 — 送信が通らないとスコアも出ない
        let returned = null;
        try {
            returned = await submitSet(items, season);
            // 件数・中身を検証してから展開する (不正レスポンスでこの後の参照が落ちないように)
            if (!Array.isArray(returned) || returned.length !== items.length ||
                returned.some(r => !Number.isFinite(r?.score))) {
                throw new Error('bad response shape');
            }
        } catch (e) {
            console.warn('送信失敗:', e);
            await hideLoading();
            // サーバーが理由つきで拒否した場合は、通信障害と混同させない案内にする
            const msg = String(e?.message ?? '');
            const reason = /unknown slv/.test(msg)
                ? `現在の SLv 補正データは SLv ${SLV_MAX} までです。超上位帯の補正値が揃い次第、対応します。`
                : /closed|season not open/.test(msg)
                    ? '現在この期間の測定は受け付けていません (シーズン切替中の可能性があります)。'
                    : 'サーバーに接続できませんでした。ふるり値の計算はサーバー側で行うため、通信が復活してから再度お試しください。';
            $('resultsArea').innerHTML = `
            <section class="card">
                <h2>⚠️ 測定できませんでした</h2>
                <p class="score-detail">${escapeHtml(reason)} 入力内容はそのまま残っています。</p>
            </section>`;
            $('shareCard').style.display = 'none';
            $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        await hideLoading();
        renderResults();
        saveLastResult(results);   // 再訪時に分布だけ見直せるよう保存
        renderRecallBanner();

        showShareCardPreview();
        $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        // 想定外の例外 (描画等)。送信自体は成功していることがあるので静かに落とさず知らせる
        console.error('onSubmit 想定外エラー:', e);
        toast('結果の表示に失敗しました。再読み込みしてお試しください');
    } finally {
        // どの経路 (想定外の例外含む) でも: オーバーレイを閉じ、ボタンを復帰させる
        forceCloseLoading();
        submitting = false;
        btn.textContent = '送信して測定する';
        updateSubmitState();
    }
}

// 中央値比 (分布解禁時のみ)。カード・総合・同一編成・シェア文の全部がこれを使う単一源泉
function ratioAgainst(dist, score) {
    return (dist && !dist.gated && Array.isArray(dist.bins) && dist.median > 0)
        ? score / dist.median : null;
}
function medianRatioOf(r) { return ratioAgainst(r.dist, r.score); }

function renderResults() {
    const area = $('resultsArea');
    const multi = results.length > 1;
    let html = results.map((r, i) => resultCardHTML(r, i, multi)).join('');
    if (multi) {
        // 総合 = 各凸の中央値比の平均。ふるり値は属性ごとに基準ボスが違うため、
        // 属性をまたいだ「ふるり値の合算」はしない (運営判断 2026-07-30)。
        // 締め凸はダメージが打ち切られていて中央値比が構造的に低い → 総合から除外
        // (分布からも除外済み)。全「対象凸」の分布が解禁されているときだけ出せる
        const scored = results.filter(r => !r.isFinish);
        const ratios = scored.map(medianRatioOf);
        const totalPct = scored.length > 0 && ratios.every(x => x != null)
            ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) : null;
        const finishNote = scored.length < results.length
            ? ` 締め凸 ${results.length - scored.length}凸は打ち切りダメージのため総合に含めていません。` : '';
        html += `
        <section class="card set-card">
            <div class="score-label">🏅 ${scored.length}凸の総合</div>
            <div class="score-big">${totalPct != null ? `${totalPct}<span style="font-size:26px;">%</span>` : '—'}</div>
            <div class="pill-row">
                <span class="pill">各凸の中央値比の平均</span>
                ${results.map((r, ri) => r.isFinish
                    ? `<span class="pill" style="color:var(--faint);">${ATTR_INFO[r.attribute].jp} 締め凸</span>`
                    : `<span class="pill" style="color:${ATTR_INFO[r.attribute].color};">${ATTR_INFO[r.attribute].jp} ${medianRatioOf(r) != null ? `${Math.round(medianRatioOf(r) * 100)}%` : r.score.toFixed(2)}</span>`).join('')}
            </div>
            <p class="dist-note">${totalPct != null
                ? `総合 ${totalPct}% = 各凸を「その属性のみんなの中央値 = 100%」と比べ、${scored.length}凸を同じ重みで平均した到達度です (合計ダメージの比ではありません)。ボスの通りやすさは各属性の中央値で補正済み。${finishNote}`
                : scored.length === 0
                    ? `※ 全て締め凸のため総合はありません (締め凸は打ち切りダメージなので比較対象にしません)`
                    : `※ 総合 (各凸の中央値比の平均) は、凸した全属性の分布が解禁されると表示されます${finishNote}`}</p>
        </section>`;
    }
    // ❓ 数字の出し方 tips (突っ込まれやすい計算方法を先回りで開示 — 実機FB)
    html += `
    <details class="card tips">
        <summary>❓ この%はどう計算している?<span class="chev">▼</span></summary>
        <div class="tips-body">
            <p><strong>イメージ:</strong> 縦軸ダメージ・横軸SLvの散布図に今シーズンの各人のベスト提出を置き、
            「真ん中の人の曲線」を引く。その曲線上 = 100% で、あなたの%は曲線からどれだけ上か、です。</p>
            <p>曲線は直線の当てはめではなく <strong>SLv補正の実測カーブ × みんなの中央値</strong>で
            引いています。SLvの伸びが直線でないことを正確に扱え、平均と違って極端な値に引っ張られません。</p>
            <p><strong>属性の%</strong> = 同じ属性に凸した人の真ん中との比較。ボスの通りやすさは
            この割り算で消えます (出やすいボスは分母も大きいため)。</p>
            <p><strong>同じ編成の%</strong> = 同じ5人編成 (並び順は不問) の真ん中との比較
            (同一編成${THRESHOLDS.comp}人で解禁)。強力なサポーターの有無など編成の差はこちらで公平に比べられます。</p>
            <p><strong>総合</strong> = 各凸の%を同じ重みで平均した到達度で、合計ダメージの比では
            ありません。編成の差は総合では補正しません (どの編成もどこか1凸では使えるため)。</p>
            <p><strong>締め凸</strong> = ボス撃破で戦闘が途中終了した凸。ダメージが打ち切られて
            低く出るため、みんなの分布・編成集計・総合には入れません (%は参考値として表示)。</p>
        </div>
    </details>`;
    area.innerHTML = html;
    area.querySelectorAll('.res-finish-toggle').forEach(b =>
        b.addEventListener('click', () => onToggleFinish(parseInt(b.dataset.i, 10))));
    area.querySelectorAll('.res-correct').forEach(b =>
        b.addEventListener('click', () => startCorrection(parseInt(b.dataset.i, 10))));
}

// 提出後の締め凸トグル: 自分の行のフラグだけサーバーで書き換え、分布を取り直す
let editBusy = false;
async function onToggleFinish(i) {
    const r = results?.[i];
    if (!r || editBusy) return;
    editBusy = true;
    try {
        const next = !r.isFinish;
        await markOwnFinish({ attribute: r.attribute, season, isFinish: next });
        r.isFinish = next;
        updateSavedItem(r.attribute, { isFinish: next });
        // 自分の票の出入りで n・中央値が動くので分布は取り直す
        try {
            const compKey = r.characters ? [...r.characters].sort().join('|') : null;
            const [dist, compDist] = await Promise.all([
                fetchDistribution({ attribute: r.attribute, season, score: r.score }),
                compKey ? fetchDistribution({ attribute: r.attribute, season, score: r.score, compKey })
                        : Promise.resolve(null),
            ]);
            r.dist = dist; r.compDist = compDist; r.fetchError = false;
        } catch { /* 分布だけ失敗してもフラグ自体は反映済み */ }
        renderResults();
        showShareCardPreview();
        toast(next ? '締め凸として集計から外しました' : '締め凸を取り消しました (集計に戻ります)');
    } catch (e) {
        console.warn('締め凸トグル失敗:', e);
        toast('変更できませんでした。通信環境を確認して再度お試しください');
    } finally {
        editBusy = false;
    }
}

// ✏️ 修正モード: 前回の内容をフォームへ再充填し、送信を「置き換え」に切り替える
function startCorrection(i) {
    const r = results?.[i];
    if (!r) return;
    correcting = { attribute: r.attribute };
    const a = newAttack();
    a.attribute = r.attribute;
    a.damage = Number.isFinite(r.damage) ? String(+(r.damage / 1e9).toFixed(4)) : '';
    a.isFinish = r.isFinish === true;
    if (Array.isArray(r.characters) && r.characters.length === 5 && compReady()) {
        a.template = detectTemplate(r.characters, burstsOfId);
        a.slots = reslotChars(r.characters, burstsOfId, templateById(a.template).slots).slots;
        a.compOpen = true;
    }
    attacks = [a];
    if (Number.isFinite(r.slv)) { $('slv').value = r.slv; onSlvChanged(); }
    renderAttacks();
    updateSubmitState();
    $('submitBtn').textContent = '修正して送り直す';
    toast(`${ATTR_INFO[r.attribute].jp}PT の提出を修正します (送信で置き換え)`);
    $('attacksArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelCorrection() {
    correcting = null;
    attacks = [newAttack()];
    renderAttacks();
    updateSubmitState();
    $('submitBtn').textContent = '送信して測定する';
}

// localStorage の前回結果を部分更新 (属性単位)。保存が無ければ何もしない
function updateSavedItem(attribute, patch) {
    try {
        const raw = localStorage.getItem(LAST_KEY);
        if (!raw) return;
        const v = JSON.parse(raw);
        if (!Array.isArray(v?.items)) return;
        v.items = v.items.map(it => it.attribute === attribute ? { ...it, ...patch } : it);
        localStorage.setItem(LAST_KEY, JSON.stringify(v));
    } catch { /* localStorage 不可でも致命ではない */ }
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

    // フィードバックは順位ではなく「中央値=100%としたときの%」(運営方針 2026-07-30)。
    // シェアカードと同じ構図に統一: 主役 = 中央値比% / サブ = ふるり値 (導入のまき餌)。
    // 分布未解禁の導入期だけは中央値比が無いので、ふるり値が主役のまま
    const ratio = medianRatioOf(r);
    const medianPct = ratio != null ? Math.round(ratio * 100) : null;
    const pill = medianPct != null
        ? `<span class="rank-pill">ふるり値 ${r.score.toFixed(2)}</span>` : '';
    const big = medianPct != null
        ? `${medianPct}<span style="font-size:26px;">%</span>`
        : r.score.toFixed(2);
    const mainPill = medianPct != null
        ? `<span class="pill">中央値 = 100% ・ ${r.dist.n}人中</span>` : '';

    // 使った編成 (5人・順不同保存なのでバースト順で表示)。編成未入力の提出では出さない
    const compRow = (r.characters?.length && compReady())
        ? `<div class="result-comp"><span class="result-comp-label">編成</span>` +
          sortForDisplay(r.characters, infoOf).map(id => tileHTML(infoOf(id), { xs: true })).join('') +
          `</div>`
        : '';

    // 締め凸: %は出すが「参考値」であることを明示 (分布・編成集計・総合には不参加)
    const finishPill = r.isFinish ? `<span class="pill finish-pill">🏁 締め凸</span>` : '';
    const finishNote = r.isFinish
        ? `<p class="dist-note">🏁 締め凸 (ボス撃破で戦闘が途中終了) のため、この凸はみんなの分布・
           編成集計・総合には入れていません。%は「打ち切られたダメージでもここまで出た」という参考値です。</p>`
        : '';
    // 提出の後編集 (シーズン開催中のみ): 締め凸トグルは自分の行のフラグだけ書き換え、
    // ✏️修正はフォームに再充填して「その属性の自分の行を置き換える」送信になる
    const actions = (mode === 'open' && backendConfigured())
        ? `<div class="res-actions">
            <button type="button" class="res-act res-finish-toggle" data-i="${i}">${r.isFinish ? '↩️ 締め凸を取り消す' : '🏁 締め凸として除外'}</button>
            <button type="button" class="res-act res-correct" data-i="${i}">✏️ ダメージ/編成を修正</button>
        </div>`
        : '';

    return `
    <section class="card result-card${r.isFinish ? ' finish-card' : ''}">
        <div class="score-label"><strong style="color:${info.color};">${info.jp}PT</strong> ${title}${finishPill}${pill}</div>
        <div class="score-big">${big}${r.isFinish ? `<span class="finish-ref">参考</span>` : ''}</div>
        <div class="pill-row">
            ${mainPill}
            <span class="pill">SLv ${r.slv}</span>
            <span class="pill">${(r.damage / 1e9).toFixed(3)} B</span>
        </div>
        ${finishNote}
        ${compRow}
        ${distHtml}
        ${actions}
    </section>`;
}

function distSectionHTML(r, info) {
    const d = r.dist;
    let html = '';
    // 編成内% — シェアカードと同じ序列 (編成タイル直下・分布の上) と同じ格 (数字を主役に)。
    // 属性%が「編成を問わない到達度」、こちらが「同じ5人 (並び不問) 同士の公平比較」
    if (r.characters && r.compDist) {
        const cd = r.compDist;
        const cratio = ratioAgainst(cd, r.score);
        if (cratio != null) {
            html += `
            <div class="comp-pct">
                <span class="lbl">編成内</span>
                <span class="val">${Math.round(cratio * 100)}<small>%</small></span>
                <span class="lbl">同じ編成 ${cd.n}人の中央値 = 100%</span>
            </div>`;
        } else {
            html += `<div class="comp-pct gated">🧩 編成内%は同じ編成 ${cd.need ?? THRESHOLDS.comp}人で解禁 (現在 ${cd.n}人)</div>`;
        }
    }
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
        // 自分のビンは色が変わるだけ (バッジ・高さ盛りは無し — スタイリッシュ優先の運営判断)
        const bars = d.bins.map((v, bi) =>
            `<div class="bar${bi === d.my_bin - 1 ? ' me' : ''}" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('');
        html += `
        <div class="hist">${bars}</div>
        <div class="hist-axis"><span>${d.lo.toFixed(2)}</span><span>中央値 ${d.median.toFixed(2)}</span><span>${d.hi.toFixed(2)}</span></div>
        <p class="dist-note">${info.jp}PT の提出 ${d.n}人 (1人1票・今シーズン) の分布。色の違うバーがあなたの位置。
            真ん中の人 (=100%) はふるり値 <strong>${d.median.toFixed(2)}</strong> です。</p>`;
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

// シェア文もカードと同じ主従: 中央値比%が主役、ふるり値はサブ (未解禁時のみふるり値が主役)。
// 総合は締め凸を除いて平均 (画面・カードと同じ数字になること — Codex指摘)
function shareText() {
    if (results.length > 1) {
        const scored = results.filter(r => !r.isFinish);
        const ratios = scored.map(medianRatioOf);
        const partOf = (r) => r.isFinish
            ? `${ATTR_INFO[r.attribute].jp}締め凸`
            : (medianRatioOf(r) != null ? `${ATTR_INFO[r.attribute].jp}${Math.round(medianRatioOf(r) * 100)}%`
                                        : `${ATTR_INFO[r.attribute].jp}${r.score.toFixed(2)}`);
        if (scored.length > 0 && ratios.every(x => x != null)) {
            const totalPct = Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100);
            return `総合 ${totalPct}% (${results.map(partOf).join('/')}) — みんなの中央値=100% #しりすこPADグローバル #NIKKE`;
        }
        return `ふるり値 ${results.map(partOf).join('/')} を測定! #しりすこPADグローバル #NIKKE`;
    }
    const r = results[0];
    const ratio = medianRatioOf(r);
    const finishTag = r.isFinish ? '・締め凸につき参考' : '';
    if (ratio != null) {
        return `中央値比 ${Math.round(ratio * 100)}% (${ATTR_INFO[r.attribute].jp}PT・みんなの真ん中=100%${finishTag}) — ふるり値 ${r.score.toFixed(2)} #しりすこPADグローバル #NIKKE`;
    }
    return `ふるり値 ${r.score.toFixed(2)} (${ATTR_INFO[r.attribute].jp}PT${finishTag}) を測定! #しりすこPADグローバル #NIKKE`;
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
