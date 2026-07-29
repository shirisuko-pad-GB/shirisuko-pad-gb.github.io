// クライアント側の計算ユーティリティ (純関数)。
//
// ふるり値の計算式そのもの (SLv補正テーブル・基準値を使う部分) は
// **サーバー側にしかない** (supabase/02_stats.sql の measurements_compute トリガ)。
// SLv補正テーブルは未公開の検証データのため、クライアントには一切持たせない設計。
// クライアントは送信の返事から score を受け取り、分布も RPC の集計結果を表示するだけ。

export const ATTRS = ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND'];

// RPC の集計結果 (自分より上の件数 above / 全件数 n) から「上位◯%」を出す。
// 自分の1票は n に含まれている前提。丸めても最低1%。
export function topPercentFromCounts(above, n) {
    if (!Number.isFinite(above) || !Number.isFinite(n) || n <= 0) return null;
    return Math.max(1, Math.round(((above + 1) / n) * 100));
}

// ダメージ入力のパース → 生ダメージ (実数) or null。
// 基本は B (10億) 単位の少数入力 (例 "13.18" → 13,180,000,000)。
// フル桁の貼り付け (1,000,000 以上) は生の数字として扱う。カンマ・空白・末尾のBは許容。
export function parseDamageInput(str) {
    if (typeof str !== 'string') str = String(str ?? '');
    const trimmed = str.replace(/[,\s，、]/g, '');
    const hasB = /[bB]$/.test(trimmed);
    const s = trimmed.replace(/[bB]$/, '');
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const v = parseFloat(s);
    if (!(v > 0)) return null;
    return (hasB || v < 1e6) ? v * 1e9 : v;
}

// ---------- バースト編成 (B1/B2/B3/BΛ) ----------
// BΛ (レッドフード) はどのバースト枠にも入れる特殊仕様。
// バースト不明 (データ未整備) のキャラも弾かず、どの枠でも選べる扱いにする。
// サブバースト対応 (2026-07): ラピ:レッドフード のように複数の枠で使えるキャラは
// 「入れる枠の配列」で扱う。burstsOf(img) は ['B3','B1'] のような配列 (先頭が主) か、
// null (Λ・未分類 = どの枠でも可) を返す関数。

export const BURST_TEMPLATES = [
    { id: 'standard', label: 'B1・B2・B3×3', slots: ['B1', 'B2', 'B3', 'B3', 'B3'] },
    { id: 'double2',  label: 'B1・B2×2・B3×2', slots: ['B1', 'B2', 'B2', 'B3', 'B3'] },
    { id: 'free',     label: '自由',           slots: [null, null, null, null, null] },
];

export function templateById(id) {
    return BURST_TEMPLATES.find(t => t.id === id) || BURST_TEMPLATES[0];
}

// そのキャラをその枠に置けるか。slotBurst=null は自由枠 / bursts=null はどこでも可
export function burstMatchesSlot(bursts, slotBurst) {
    if (!slotBurst || !bursts) return true;
    return bursts.includes(slotBurst);
}

// 選択済みキャラ列をテンプレートの枠に詰め直す (テンプレ切替・プリセット適用時)。
// 枠の選択肢が狭いキャラから貪欲に置く: 主バーストの枠を優先し、
// 埋まっていればサブバースト可の枠 → 自由枠。Λ・未分類は最後に残り枠へ。
// 収まらないキャラは dropped に返す。
export function reslotChars(imgs, burstsOf, slotBursts) {
    const slots = slotBursts.map(() => null);
    const dropped = [];
    const wildcards = [];
    const fixed = [];
    for (const img of imgs) {
        if (!img) continue;
        const bs = burstsOf(img);
        if (!bs) wildcards.push(img); else fixed.push([img, bs]);
    }
    fixed.sort((a, b) => a[1].length - b[1].length);   // 選択肢が狭い順
    for (const [img, bs] of fixed) {
        let i = slotBursts.findIndex((s, k) => slots[k] === null && s === bs[0]);
        if (i < 0) i = slotBursts.findIndex((s, k) => slots[k] === null && (s === null || bs.includes(s)));
        if (i >= 0) slots[i] = img; else dropped.push(img);
    }
    for (const img of wildcards) {
        const i = slots.findIndex(s => s === null);
        if (i >= 0) slots[i] = img; else dropped.push(img);
    }
    return { slots, dropped };
}

// 5キャラのバースト構成に合うテンプレートを選ぶ (プリセット適用時の自動判定)
export function detectTemplate(imgs, burstsOf) {
    for (const t of BURST_TEMPLATES) {
        if (t.id === 'free') continue;
        if (reslotChars(imgs, burstsOf, t.slots).dropped.length === 0) return t.id;
    }
    return 'free';
}
