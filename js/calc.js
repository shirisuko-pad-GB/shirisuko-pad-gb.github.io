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
