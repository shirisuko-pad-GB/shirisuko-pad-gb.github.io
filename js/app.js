// しりすこPAD GB — ふるり値チェッカー UIロジック
// 3凸まとめ入力 + サーバー集計の分布表示 (しきい値ゲート付き)
// ふるり値の計算はサーバー側のみ (SLv補正テーブル秘匿のため) — 送信の返事で score を受け取る
import { ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput, damageToBString } from './calc.js';
import { backendConfigured, submitSet, fetchDistribution, fetchSiteState, fetchCompInsights, markOwnFinish, correctOwnMeasurement, fetchTotalDistribution } from './backend.js';
import { escapeHtml, THRESHOLDS, ATTR_INFO, SITE_URL, enablePullToRefresh, isInAppBrowser, attrName } from './shared.js';
import { buildShareCard } from './sharecard.js';
import { BURST_COLORS, BURST_DARK_TEXT, makeCharResolver, burstsOf, tileHTML, sortForDisplay } from './tiles.js';
import { t, currentLang, initLang, applyStaticI18n, mountLangToggle } from './i18n.js';

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
let totalDist = null;      // 総合の全体分布 (3凸完走勢) + ユニーク利用者数 (11未適用なら null)

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
    // 表示言語をまず確定 (この後の描画は全部これを見る — 静的文言はここで差し替え済みになる)
    initLang();
    applyStaticI18n();
    mountLangToggle();
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
    // 基準の開示は「今表示しているシーズン」の分だけ。between/maintenance 中は base.json が
    // 先に次シーズンへ差し替わる (シーズン切替ランブックの順序: seed → push → open) ので、
    // 分布は前シーズンなのに基準だけ次シーズン、というチグハグを出さない。
    const baseMatchesView = base.version === viewSeason;
    $('baseVersionLabel').textContent = baseMatchesView
        ? t('ui.base_version', { v: base.version, player: base.basePlayer, slv: base.baseSlv })
        : (viewSeason ? t('ui.season_prep_view', { season: viewSeason }) : t('ui.season_prep'));
    const fold = $('baseFold');
    if (fold) {
        fold.open = false;
        fold.style.display = baseMatchesView ? '' : 'none';
    }
    if (baseMatchesView) renderBaseTeams();
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
        <h2>📣 ${escapeHtml(r.title || t('ui.recruit_title'))}</h2>
        <img class="recruit-banner" src="./assets/recruit-banner.jpg"
             alt="${escapeHtml(t('ui.recruit_banner_alt'))}" loading="lazy">
        <p class="recruit-note">${escapeHtml(r.note || '')}</p>
        <a class="x-btn" href="https://x.com/${xid}" target="_blank" rel="noopener">${escapeHtml(t('ui.view_x', { id: xid }))}</a>
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
        <h2>${t('ui.partners_h')}</h2>
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
                <span class="partner-tap">${t('ui.partner_tap')}${host ? ` (${escapeHtml(host)})` : ''}</span>
            </a>`
                : `<a class="partner-btn" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('ui.view_site', { name: p.name }))}</a>
                   ${host ? `<p class="partner-host">${t('ui.partner_dest')}${escapeHtml(host)}</p>` : ''}`}
            ${p.note ? `<p class="partner-note">${escapeHtml(p.note)}</p>` : ''}
        </div>`;
        }).join('')}
    </section>`;
    // バナーが読めない環境ではロゴ導線が消えるので、名前ボタンに置き換える
    host.querySelectorAll('.partner-banner').forEach(img => img.addEventListener('error', () => {
        const link = img.closest('.partner-link');
        if (!link) { img.style.display = 'none'; return; }
        link.className = 'partner-btn';
        link.innerHTML = escapeHtml(t('ui.view_site', { name: img.alt }));
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
            <span class="base-attr">${t('ui.team_of', { code: attrName(attr) })}</span>
            <span class="base-dmg">${(b.damage / 1e9).toFixed(2)} B</span>
            <span class="hint">${b.source === 'actual' ? t('ui.src_actual') : t('ui.src_mock')}${boss ? ` · vs ${escapeHtml(boss)}` : ''}</span>
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
        notice.innerHTML = `<div class="notice"><h2>${t('ui.maint_h')}</h2>
            <p>${escapeHtml(site?.message || t('ui.maint_msg'))}</p></div>`;
    } else {   // between
        const canView = !!viewSeason;
        notice.innerHTML = `<div class="notice"><h2>${t('ui.between_h')}</h2>
            <p>${escapeHtml(site?.message || t('ui.between_msg'))}${
                canView ? t('ui.between_link') : ''}</p></div>`;
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
    const label = last.items.map(it => `${attrName(it.attribute)} ${Number(it.score).toFixed(2)}`).join(' / ');
    host.innerHTML = `
        <div class="recall">
            <div class="recall-txt">${escapeHtml(t('ui.recall_label'))}<strong>${escapeHtml(label)}</strong></div>
            <button type="button" id="recallBtn" class="recall-btn">${escapeHtml(t('ui.recall_btn'))}</button>
        </div>`;
    host.style.display = 'block';
    $('recallBtn').addEventListener('click', () => showRecalledDistribution(last));
}

// 保存済みスコアで分布だけ取り直す (送信=INSERT はしない)
async function showRecalledDistribution(last) {
    const btn = $('recallBtn');
    if (btn) { btn.disabled = true; btn.textContent = t('ui.checking'); }
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
    await refreshTotalDist();
    renderResults();
    showShareCardPreview();
    $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (btn) { btn.disabled = false; btn.textContent = t('ui.recall_btn'); }
}

function stepSlv(d) {
    const el = $('slv');
    const v = parseInt(el.value);
    if (Number.isNaN(v) && d < 0) return;   // 空欄で「−」はゲート解除しない (Codex指摘)
    el.value = Math.max(1, Math.min(SLV_MAX, (Number.isNaN(v) ? 0 : v) + d));
    onSlvChanged();
}

// 対応SLvの上限。SLv補正テーブル (めいでん+ふるりの実測) が 1〜1183 までのため。
// ⚠ 1000超に対応するときは、この定数・input[max]・サーバー側 (01_schema の CHECK と
//    slv_ratio の行) を揃えて広げること
const SLV_MAX = 1183;   // 2026-08-23 拡張 (シートの既存1〜1000と全件一致を検証してから取り込み)
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
    el.textContent = slvOver() ? t('ui.slv_over_note', { max: SLV_MAX })
        : slvMalformed() ? t('ui.slv_malformed')
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
            <p class="slv-gate-txt">${t('ui.gate_over', { max: SLV_MAX })}</p>
        </section>` : `
        <section class="card slv-gate">
            <p class="slv-gate-txt">${t('ui.gate_need_slv')}</p>
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
    const title = correcting ? t('ui.correct_title', { team: info ? t('ui.team_of', { code: attrName(a.attribute) }) : '' })
        : attacks.length > 1 ? t('ui.attack_n', { n: i + 1 }) : t('ui.this_attack');
    const delBtn = correcting
        ? `<button type="button" class="atk-del corr-cancel">${t('ui.cancel_correct')}</button>`
        : attacks.length > 1 ? `<button type="button" class="atk-del">${t('ui.delete')}</button>` : '';
    const attrBtns = orderedAttrs().map(attr => {
        const ai = ATTR_INFO[attr];
        return `
        <button type="button" class="attr-btn${a.attribute === attr ? ' active' : ''}" data-attr="${attr}"
                style="--ac:${ai.color};"${correcting ? ' disabled' : ''}>
            <span class="ico">${escapeHtml(t(`attr.short.${attr}`))}</span>
            <span class="name">${escapeHtml(t('ui.team_of', { code: attrName(attr) }))}</span>
        </button>`;
    }).join('');
    const dmg = a.damage ? ` value="${escapeHtml(a.damage)}"` : '';
    return `
    <section class="card atk-card" data-i="${i}">
        <h2><span class="step-num">2</span>${title}${delBtn}</h2>
        <div class="attr-grid">${attrBtns}</div>
        <p class="vs-note">${info && raid?.bosses?.[a.attribute]
            ? t('ui.vs_boss', { color: ATTR_INFO[info.enemy].color, code: attrName(info.enemy), boss: escapeHtml(raid.bosses[a.attribute]), season: escapeHtml(raid.season || '') })
            : t('ui.pick_attr')}</p>
        <div style="margin-top:12px;">
            <p class="hint" style="margin-bottom:6px;">${t('ui.damage_hint')}</p>
            <div class="dmg-field">
                <input class="atk-damage" type="text" inputmode="decimal" placeholder="${escapeHtml(t('ui.damage_ph'))}"${dmg}>
                <span class="dmg-unit">B</span>
            </div>
            <p class="preview">${damagePreviewText(a.damage)}</p>
            <label class="finish-check">
                <input type="checkbox" class="atk-finish"${a.isFinish ? ' checked' : ''}>
                <span>${t('ui.finish_check')}<span class="finish-sub">${t('ui.finish_check_sub')}</span></span>
            </label>
            ${a.isFinish ? `<p class="hint finish-note">${t('ui.finish_note')}</p>` : ''}
        </div>
        <details class="comp"${a.compOpen ? ' open' : ''}>
            <summary><span class="sum-label">${t('ui.comp_label')}</span><span class="pill">${t('ui.optional')}</span><span class="sum-faces">${summaryFacesHTML(a)}</span><span class="chev">▼</span></summary>
            <div class="comp-body">${compBodyHTML(a)}</div>
        </details>
    </section>`;
}

function compBodyHTML(a) {
    if (!a.attribute) return `<p class="hint" style="margin-top:8px;">${t('ui.comp_need_attr')}</p>`;
    if (!compReady()) return `<p class="hint" style="margin-top:8px;">${t('ui.comp_no_data')}</p>`;
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
                <span class="pill">${t('ui.season_top_n', { n: pi + 1 })}</span>
                <span class="hint">${t('ui.used_by_n', { n: c.count })}${Number.isFinite(c.median) ? t('ui.median_inline', { v: Number(c.median).toFixed(2) }) : ''}</span>
            </span>
        </button>`;
    }).join('') + (moreCount > 0 && !a.presetMore ? `
        <button type="button" class="preset-more">${t('ui.more_presets', { last: 3 + moreCount })}</button>` : '');
    const presetHead = ap.topComps.length
        ? `<p class="hint" style="margin-top:8px;">${t('ui.presets_hint')}</p>`
        : `<p class="hint" style="margin-top:8px;">${t('ui.comp_hint')}${ap.loading ? '' : t('ui.comp_hint_more')}</p>`;
    return `
        ${presetHead}
        ${presetRows}
        <div class="tmpl-chips">${BURST_TEMPLATES.map(tp =>
            `<button type="button" class="tmpl-chip${a.template === tp.id ? ' active' : ''}" data-tmpl="${tp.id}">${t(`ui.tmpl_${tp.id}`)}</button>`).join('')}
            ${selChars(a).length >= 2 ? `<button type="button" class="sort-chip">${t('ui.sort_burst')}</button>` : ''}
        </div>
        <p class="hint" style="margin-top:6px;">${t('ui.order_note')}</p>
        <div class="slot-row">${templateById(a.template).slots.map((sb, si) => {
            const img = a.slots[si];
            const color = sb ? BURST_COLORS[sb] : '#8A9097';
            return `
            <button type="button" class="slot${si === a.activeSlot ? ' active' : ''}" data-slot="${si}" style="--sb:${color};">
                <span class="slot-b${sb && BURST_DARK_TEXT.has(sb) ? ' dark' : ''}">${sb || t('ui.slot_free')}</span>
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
    if (ordered.length === 0) return `<p class="hint" style="margin-top:8px;">${t('ui.no_candidates')}</p>`;
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
        <p class="hint picker-label">${t('ui.popular_chars')}</p>
        <div class="picker-grid picker-quick">${quick.map(btn).join('')}</div>` : '';
    const label = slotBurst
        ? `${t('ui.picker_burst', { color: BURST_COLORS[slotBurst], burst: slotBurst })}${groups.lambda.length ? t('ui.picker_lambda') : ''}${groups.unknown.length ? t('ui.picker_unknown') : ''}`
        : t('ui.picker_all');
    return `${quickHtml}<p class="hint picker-label">${t('ui.picker_tap', { label })}</p><div class="picker-grid named">${rest.map(id => btn(id)).join('')}</div>`;
}

function compStatusText(a) {
    const n = selChars(a).length;
    return n === 0 ? t('ui.comp_none') :
        n === 5 ? t('ui.comp_full') :
        t('ui.comp_partial', { n });
}

function damagePreviewText(v) {
    if (!String(v ?? '').trim()) return ' ';
    const raw = parseDamageInput(v);
    if (!(raw > 0)) return t('ui.check_number');
    return `${(raw / 1e9).toFixed(2)} B = ${Math.round(raw).toLocaleString(currentLang() === 'en' ? 'en-US' : 'ja-JP')}`;
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
        const tmpl = BURST_TEMPLATES.find(tp => tp.id !== 'free' &&
            reslotChars(ordered, burstsOfId, tp.slots).dropped.length === 0);
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
            if (dropped.length) toast(t('ui.dropped_chars', { names: dropped.map(x => nameOf(x) || t('ui.one_char')).join('・') }));
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
        toast(t('ui.check_input'));
        return;
    }
    const btn = $('submitBtn');
    try {
        submitting = true;
        btn.disabled = true;
        btn.textContent = t('ui.sending');
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
        btn.textContent = t('ui.submit');
        toast(t('ui.correction_saved'));
        renderRecallBanner();
        const last = loadLastResult();
        if (last) await showRecalledDistribution(last);
    } catch (e) {
        console.warn('修正失敗:', e);
        await hideLoading();
        toast(t('ui.correction_failed'));
    } finally {
        forceCloseLoading();
        submitting = false;
        btn.disabled = false;
        if (correcting) btn.textContent = t('ui.resubmit');   // 失敗時は修正モードのまま再試行できる
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
        toast(t('ui.check_input'));
        return;
    }

    const btn = $('submitBtn');
    try {
        submitting = true;
        btn.disabled = true;
        btn.textContent = t('ui.sending');
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
                ? t('ui.err_slv_range', { max: SLV_MAX })
                : /closed|season not open/.test(msg)
                    ? t('ui.err_closed')
                    : t('ui.err_network');
            $('resultsArea').innerHTML = `
            <section class="card">
                <h2>${t('ui.err_h')}</h2>
                <p class="score-detail">${t('ui.err_kept', { reason: escapeHtml(reason) })}</p>
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
        await refreshTotalDist();
        await hideLoading();
        renderResults();
        saveLastResult(results);   // 再訪時に分布だけ見直せるよう保存
        renderRecallBanner();

        showShareCardPreview();
        $('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        // 想定外の例外 (描画等)。送信自体は成功していることがあるので静かに落とさず知らせる
        console.error('onSubmit 想定外エラー:', e);
        toast(t('ui.err_render'));
    } finally {
        // どの経路 (想定外の例外含む) でも: オーバーレイを閉じ、ボタンを復帰させる
        forceCloseLoading();
        submitting = false;
        btn.textContent = t('ui.submit');
        updateSubmitState();
    }
}

// 総合の全体分布を取り直す (renderResults の前に呼ぶ)。本人の位置 (my_total/my_atk/
// my_bin) はサーバーが client_id から「属性ごとのシーズンベスト」で計算して返す —
// 表示中セット由来の値だと再提出・同属性重複でズレる (Codex指摘)。
// 11未適用・通信失敗は null で静かに劣化
async function refreshTotalDist() {
    totalDist = null;
    if (!results?.length) return;
    try {
        totalDist = await fetchTotalDistribution({ season: viewSeason ?? season });
    } catch (e) {
        console.warn('総合分布の取得失敗:', e);
        totalDist = null;
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
            ? t('ui.total_finish_note', { n: results.length - scored.length }) : '';
        // 総合の全体分布 (3凸完走勢)。有効3凸未満の人は数えられず「参考位置」だけ見せる
        let totalHist = '';
        const td = totalDist;
        if (td && !td.gated && Array.isArray(td.bins) && Number.isFinite(td.median) && td.median > 0) {
            const maxBin = Math.max(...td.bins, 1);
            const bars = td.bins.map((v, bi) =>
                `<div class="bar${td.my_bin != null && bi === td.my_bin - 1 ? ' me' : ''}" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('');
            // 位置の説明: サーバーの正 (属性ごとシーズンベスト) 基準。有効3凸未満は参考扱い
            const myNote = td.my_bin == null ? ''
                : Number.isFinite(td.my_atk) && td.my_atk < 3
                    ? t('ui.total_my_note_ref', { n: td.my_atk, pct: Math.round(td.my_total * 100) })
                    : t('ui.total_my_note', { pct: Math.round(td.my_total * 100) });
            totalHist = `
            <div class="hist">${bars}</div>
            <div class="hist-axis"><span>${Math.round(td.lo * 100)}%</span><span>${t('ui.axis_median_pct', { pct: Math.round(td.median * 100) })}</span><span>${Math.round(td.hi * 100)}%</span></div>
            <p class="dist-note">${t('ui.total_dist_note', { n: td.n, myNote, users: td.users })}</p>`;
        } else if (td) {
            totalHist = `<p class="dist-note">${t('ui.total_dist_locked', { need: td.need ?? 50, n: td.n ?? 0, users: td.users ?? 0 })}</p>`;
        }
        html += `
        <section class="card set-card">
            <div class="score-label">${t('ui.total_label', { n: scored.length })}</div>
            <div class="score-big">${totalPct != null ? `${totalPct}<span style="font-size:26px;">%</span>` : '—'}</div>
            <div class="pill-row">
                <span class="pill">${t('ui.total_pill')}</span>
                ${results.map((r, ri) => r.isFinish
                    ? `<span class="pill" style="color:var(--faint);">${t('ui.finish_pill_attr', { code: attrName(r.attribute) })}</span>`
                    : `<span class="pill" style="color:${ATTR_INFO[r.attribute].color};">${attrName(r.attribute)} ${medianRatioOf(r) != null ? `${Math.round(medianRatioOf(r) * 100)}%` : r.score.toFixed(2)}</span>`).join('')}
            </div>
            ${totalHist}
            <p class="dist-note">${totalPct != null
                ? t('ui.total_explain', { pct: totalPct, n: scored.length, finishNote })
                : scored.length === 0
                    ? t('ui.total_all_finish')
                    : t('ui.total_pending', { finishNote })}</p>
        </section>`;
    }
    // ❓ 数字の出し方 tips (突っ込まれやすい計算方法を先回りで開示 — 実機FB)
    html += `
    <details class="card tips">
        <summary>${t('ui.how_h')}<span class="chev">▼</span></summary>
        <div class="tips-body">
            <p>${t('ui.how_p1')}</p>
            <p>${t('ui.how_p2')}</p>
            <p>${t('ui.how_p3')}</p>
            <p>${t('ui.how_p4', { n: THRESHOLDS.comp })}</p>
            <p>${t('ui.how_p5')}</p>
            <p>${t('ui.how_p6')}</p>
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
    if (!r || editBusy || submitting) return;   // 修正送信中の古いカードから操作させない (Codex指摘)
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
        await refreshTotalDist();   // 自分の締め凸の出入りで完走人数・総合も動く
        renderResults();
        showShareCardPreview();
        toast(next ? t('ui.finish_on') : t('ui.finish_off'));
    } catch (e) {
        console.warn('締め凸トグル失敗:', e);
        toast(t('ui.change_failed'));
    } finally {
        editBusy = false;
    }
}

// ✏️ 修正モード: 前回の内容をフォームへ再充填し、送信を「置き換え」に切り替える
function startCorrection(i) {
    const r = results?.[i];
    if (!r || editBusy || submitting) return;
    correcting = { attribute: r.attribute };
    const a = newAttack();
    a.attribute = r.attribute;
    // B 単位で再充填する (生の桁のままだと「20000000000 B」に見える — 実機FB)。
    // 変換は damageToBString (指数表記を出さない・丸め損失なし・テストあり)
    a.damage = damageToBString(r.damage);
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
    $('submitBtn').textContent = t('ui.resubmit');
    toast(t('ui.correct_toast', { team: t('ui.team_of', { code: attrName(r.attribute) }) }));
    $('attacksArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelCorrection() {
    correcting = null;
    attacks = [newAttack()];
    renderAttacks();
    updateSubmitState();
    $('submitBtn').textContent = t('ui.submit');
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
    const title = multi ? t('ui.result_title_n', { n: i + 1 }) : t('ui.result_title');

    let distHtml = '';
    if (r.fetchError) {
        distHtml = `<p class="dist-note">${t('ui.dist_failed')}</p>`;
    } else if (r.dist) {
        distHtml = distSectionHTML(r, info);
    }

    // フィードバックは順位ではなく「中央値=100%としたときの%」(運営方針 2026-07-30)。
    // シェアカードと同じ構図に統一: 主役 = 中央値比% / サブ = ふるり値 (導入のまき餌)。
    // 分布未解禁の導入期だけは中央値比が無いので、ふるり値が主役のまま
    const ratio = medianRatioOf(r);
    const medianPct = ratio != null ? Math.round(ratio * 100) : null;
    const pill = medianPct != null
        ? `<span class="rank-pill">${t('ui.fururi_val', { v: r.score.toFixed(2) })}</span>` : '';
    const big = medianPct != null
        ? `${medianPct}<span style="font-size:26px;">%</span>`
        : r.score.toFixed(2);
    const mainPill = medianPct != null
        ? `<span class="pill">${t('ui.median_100_of_n', { n: r.dist.n })}</span>` : '';

    // 使った編成 (5人・順不同保存なのでバースト順で表示)。編成未入力の提出では出さない
    const compRow = (r.characters?.length && compReady())
        ? `<div class="result-comp"><span class="result-comp-label">${t('ui.comp')}</span>` +
          sortForDisplay(r.characters, infoOf).map(id => tileHTML(infoOf(id), { xs: true })).join('') +
          `</div>`
        : '';

    // 締め凸: %は出すが「参考値」であることを明示 (分布・編成集計・総合には不参加)
    const finishPill = r.isFinish ? `<span class="pill finish-pill">${t('ui.finish_pill')}</span>` : '';
    const finishNote = r.isFinish
        ? `<p class="dist-note">${t('ui.finish_result_note')}</p>`
        : '';
    // 提出の後編集 (シーズン開催中のみ): 締め凸トグルは自分の行のフラグだけ書き換え、
    // ✏️修正はフォームに再充填して「その属性の自分の行を置き換える」送信になる
    const actions = (mode === 'open' && backendConfigured())
        ? `<div class="res-actions">
            <button type="button" class="res-act res-finish-toggle" data-i="${i}">${r.isFinish ? t('ui.finish_undo') : t('ui.finish_mark')}</button>
            <button type="button" class="res-act res-correct" data-i="${i}">${t('ui.edit_dmg_comp')}</button>
        </div>`
        : '';

    return `
    <section class="card result-card${r.isFinish ? ' finish-card' : ''}">
        <div class="score-label"><strong style="color:${info.color};">${t('ui.team_of', { code: attrName(r.attribute) })}</strong> ${title}${finishPill}${pill}</div>
        <div class="score-big">${big}${r.isFinish ? `<span class="finish-ref">${t('ui.ref')}</span>` : ''}</div>
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
                <span class="lbl">${t('ui.in_comp')}</span>
                <span class="val">${Math.round(cratio * 100)}<small>%</small></span>
                <span class="lbl">${t('ui.in_comp_median', { n: cd.n })}</span>
            </div>`;
        } else {
            html += `<div class="comp-pct gated">${t('ui.in_comp_locked', { need: cd.need ?? THRESHOLDS.comp, n: cd.n })}</div>`;
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
            <span>${t('ui.dist_locked', { need, n: d.n })}</span>
            <span class="gate-bar"><span style="width:${pctBar}%"></span></span>
        </div>`;
    } else {
        const maxBin = Math.max(...d.bins, 1);
        // 自分のビンは色が変わるだけ (バッジ・高さ盛りは無し — スタイリッシュ優先の運営判断)
        const bars = d.bins.map((v, bi) =>
            `<div class="bar${bi === d.my_bin - 1 ? ' me' : ''}" style="height:${Math.max(3, (v / maxBin) * 100)}%"></div>`).join('');
        html += `
        <div class="hist">${bars}</div>
        <div class="hist-axis"><span>${d.lo.toFixed(2)}</span><span>${t('ui.axis_median', { v: d.median.toFixed(2) })}</span><span>${d.hi.toFixed(2)}</span></div>
        <p class="dist-note">${t('ui.attr_dist_note', { team: t('ui.team_of', { code: attrName(r.attribute) }), n: d.n, v: d.median.toFixed(2) })}</p>`;
    }
    return html;
}

// ---------- シェアカード ----------
// 描画は sharecard.js。生成は showShareCardPreview に一本化してある
//   (押す前に必ず生成済み = 共有経路に await を入れないため)。

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
// カードが出来るまで共有・保存ボタンは押させない。
// ⚠ これが「準備前に押された」経路をまとめて塞ぐ: その経路は await を挟むため iOS で
//   activation が切れ (= 画像なしXインテント)、アプリ内ブラウザでは効かない a[download] に
//   落ちていた (Codex指摘)。押せない状態にすれば、その分岐自体が起きない。
let cardFailed = false;
function setShareButtons(state) {   // 'busy' | 'ready' | 'failed'
    cardFailed = state === 'failed';
    const busy = state === 'busy';
    for (const [id, label] of [['shareBtn', t('ui.share')], ['saveBtn', t('ui.save_img')]]) {
        const b = $(id);
        if (!b) continue;
        b.disabled = busy;
        b.style.opacity = busy ? '0.55' : '';
        if (id === 'shareBtn') b.textContent = busy ? t('ui.preparing_img') : (cardFailed ? t('ui.share_text_only') : label);
        else { b.textContent = label; b.style.display = cardFailed ? 'none' : ''; }   // 画像が無ければ保存は出さない
    }
}
async function showShareCardPreview() {
    const gen = ++previewGen;
    shareBlob = null;
    $('shareCard').style.display = 'block';
    setShareButtons('busy');
    // 生成中は古いカードを見せない (前回結果の保存事故を防ぐ)
    $('cardPreview').style.display = 'none';
    const hint = $('saveHint');
    if (hint) hint.style.display = 'none';
    try {
        await document.fonts.ready;
        const blob = await buildShareCard(results, $('shareCanvas'), { infoOf, totalDist });
        if (gen !== previewGen) return;   // その間に新しい測定が始まった → この結果は破棄
        if (!blob) throw new Error('toBlob が null を返しました');
        shareBlob = blob;
        setPreviewImage(blob);
        setShareButtons('ready');
        // «このカードは今見ている言語で作られている» ことを明示 (ユーザー確認済みの方針)
        const note = $('cardLangNote');
        if (note) note.textContent = t('ui.card_lang_note', { lang: t('common.lang_name') });
    } catch (e) {
        if (gen !== previewGen) return;
        // 無言で「画像だけ出ない」状態にしない (実機からの「画像が表示されない」報告の温床だった)
        console.warn('シェアカード生成失敗:', e);
        setShareButtons('failed');
        toast(t('ui.card_failed'));
    }
}

// シェア文もカードと同じ主従: 中央値比%が主役、ふるり値はサブ (未解禁時のみふるり値が主役)。
// 総合は締め凸を除いて平均 (画面・カードと同じ数字になること — Codex指摘)
function shareText() {
    const tags = t('ui.tags');
    if (results.length > 1) {
        const scored = results.filter(r => !r.isFinish);
        const ratios = scored.map(medianRatioOf);
        const partOf = (r) => r.isFinish
            ? t('ui.share_part_finish', { code: attrName(r.attribute) })
            : (medianRatioOf(r) != null ? `${attrName(r.attribute)}${Math.round(medianRatioOf(r) * 100)}%`
                                        : `${attrName(r.attribute)}${r.score.toFixed(2)}`);
        if (scored.length > 0 && ratios.every(x => x != null)) {
            const totalPct = Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100);
            return t('ui.share_total', { pct: totalPct, parts: results.map(partOf).join('/'), tags });
        }
        return t('ui.share_scores', { parts: results.map(partOf).join('/'), tags });
    }
    const r = results[0];
    const ratio = medianRatioOf(r);
    const finishTag = r.isFinish ? t('ui.share_finish_tag') : '';
    if (ratio != null) {
        return t('ui.share_one_dist', { pct: Math.round(ratio * 100), team: t('ui.team_of', { code: attrName(r.attribute) }), finishTag, v: r.score.toFixed(2), tags });
    }
    return t('ui.share_one', { v: r.score.toFixed(2), team: t('ui.team_of', { code: attrName(r.attribute) }), finishTag, tags });
}

// ⚠ navigator.share() は「ユーザー操作中」でないと呼べない (transient user activation)。
// await を1つでも挟むと iOS では activation が切れて NotAllowedError になり、
// 画像を運べない X インテント (テキストとURLのみ) に落ちる = 実機で報告された
// 「共有しても画像が付かない」の原因。ボタンは準備完了まで disabled なので、
// ここに来る時点で shareBlob は用意できている (async にしないこと)。
let shareBusy = false;
function onShare() {
    if (!results || shareBusy) return;
    if (cardFailed || !shareBlob) { shareFallback(true); return; }   // 画像なしで文章だけ
    if (!shareWithFile(shareBlob)) shareFallback();
}

// 画像つきでOS標準の共有シートを開く。開始できたら true (結果は非同期)。
// ⚠ 呼び出し元はここへ来るまでに await を挟まないこと (上のコメント参照)。
// opts.onAbort / opts.onFail で「共有」と「保存」の文脈を出し分ける。
function shareWithFile(blob, opts = {}) {
    if (!blob || typeof File !== 'function' || !navigator.canShare || !navigator.share) return false;
    let file = null;
    try { file = new File([blob], 'fururi-score.png', { type: 'image/png' }); } catch { return false; }
    try {
        if (!navigator.canShare({ files: [file] })) return false;
        shareBusy = true;   // 連打で2つ目の share を投げない (2つ目が拒否されて誤ってXに飛ぶのを防ぐ)
        // Promise を解決しない実装に当たってもボタンが永久に効かなくならないようにする
        const unstick = setTimeout(() => { shareBusy = false; }, 30000);
        navigator.share({ files: [file], text: `${shareText()}\n${SITE_URL}` }).then(() => {
            clearTimeout(unstick); shareBusy = false;
        }, (e) => {
            clearTimeout(unstick); shareBusy = false;
            if (e && e.name === 'AbortError') { (opts.onAbort ?? (() => {}))(); return; }   // ユーザーがキャンセル
            console.warn('share失敗:', e);
            (opts.onFail ?? shareFallback)();
        });
    } catch (e) {
        // canShare/share が同期例外を投げる実装への保険 (呼び出し元のフォールバックに委ねる)
        shareBusy = false;
        console.warn('share呼び出し失敗:', e);
        return false;
    }
    return true;
}

// フォールバック: X インテントはテキストとURLしか運べない (画像は絶対に付かない) ので、
// 「画像は手動で添付する」ことを必ず伝える。無言で終わらせない。
// 連打で intent を2つ開かないよう短時間は open だけ抑える (案内は毎回出す — Codex指摘)。
let lastFallbackAt = 0;
function shareFallback(noImage = false) {
    const now = Date.now();
    const recent = now - lastFallbackAt < 2000;
    lastFallbackAt = now;
    if (noImage) {
        toast(t('ui.share_no_img'));
    } else {
        previewCard().catch(() => {});
        toast(t('ui.share_attach_manual'));
    }
    if (recent) return;
    const w = window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText())}&url=${encodeURIComponent(SITE_URL)}`, '_blank');
    // 画像が無いときに「画像を保存して」と言わない (矛盾した案内を出さない — Codex指摘)
    if (!w) toast(noImage ? t('ui.x_open_failed') : t('ui.x_open_failed_img'));
}

// 保存も共有と同じ制約を受ける。アプリ内ブラウザ (X/LINE等) は <a download> を無視するので
// 端末標準の共有シート経由で「写真に保存」してもらうが、**ここも await を挟まない** —
// 挟むと activation が切れて共有シートが出ず、保存できないまま無言で終わる (Codex指摘)。
function onSave() {
    if (!results || shareBusy || !shareBlob) return;   // 準備前はボタンが disabled なので通常来ない
    if (isInAppBrowser() && shareWithFile(shareBlob, {
        onAbort: () => toast(t('ui.save_cancelled')),
        onFail: () => toast(t('ui.save_unsupported')),
    })) return;
    saveByDownload(shareBlob);
}

// 通常ブラウザ用の保存 (a[download])。DOM/ObjectURL 側の失敗も無言にしない。
function saveByDownload(blob) {
    try {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = `fururi-score.png`;
        a.click();
        // ⚠ 同じターンで revoke するとダウンロードが始まる前にURLが無効になり得る (Codex指摘) — 後で捨てる
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
        console.warn('保存に失敗:', e);
        toast(t('ui.save_failed'));
        return;
    }
    if (isInAppBrowser()) toast(t('ui.save_inapp'));
}

// フォールバックからのみ呼ぶ。shareBlob がある前提 (無い場合は呼び出し側が noImage 扱い)
function previewCard() {
    return new Promise((res, rej) => {
        if (!shareBlob) return rej(new Error('カード未生成'));
        setPreviewImage(shareBlob);   // Object URL は setPreviewImage が一元管理 (漏れ防止 — Codex指摘)
        res();
    });
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
    toast(t('ui.load_failed'));
});
