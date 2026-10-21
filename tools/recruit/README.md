# 募集の目安 (SLv 帯 × 属性のダメージ分布) の作り方

新メンバー募集で「この SLv でこのダメージなら上位何%か」を見るための表・グラフを、GB の
measurements から作る手順 (2026-10-22 に第45回のデータで作成。出力は本家側の
`~/Desktop/しりすこPAD_GB_募集基準_第45回/` に置いた)。

**設計の前提**: 生の SLv × ダメージの分布から描く (ふるり値を slv-ratio で逆算しない —
逆算した表は帯ごとの値がそのまま補正表の形になり、公開厳禁の slv-ratio が漏れる)。
匿名キーからは measurements を読めないので、**SQL Editor で実行して CSV を落とす**。

## 手順

1. Supabase Dashboard › SQL Editor で `gb_export.sql` (1 凸・属性別) と `gb_export_total.sql`
   (同じ日の 3 凸の合計) を順に実行し、それぞれ **Export → Download CSV**
   (画面のグリッドは先頭 100 行しか出ない。コピーでは足りない)。
   季節が変わったら 3 つの SQL の `'2026-10'` を置き換える。
   `gb_export_bands.sql` は帯ごとに集計して 100 行以内に収めた版 (CSV が落とせない環境用・
   `gb-chart.mjs` はこの形式も読む。ただし `gb-table.mjs` は生データが要る)。
2. 2 つの CSV を 1 つにする (ヘッダは 1 行): `awk 'FNR==1 && NR>1 {next} {print}' a.csv b.csv > all.csv`
3. `node tools/recruit/gb-chart.mjs all.csv <出力先> [--band 50] [--min 5] [--ref 15] [--season 2026-10] [--round 第45回]`
   → `<出力先>/pages/*.html` (PNG 用・属性別 + 3凸合計 + 全属性) と閲覧用 `GB_募集基準_SLv帯別ダメージ.html`
4. `node tools/recruit/gb-table.mjs all.csv <出力先>/pages/募集の目安表.html --bare` (`--bare` を外すと題・見方・注記つき)
5. PNG にする: ヘッドレス Chrome を `--remote-debugging-port=9336` で起動し
   `CDP_PORT=9336 node tools/recruit/gb-shot.mjs <出力先>` → `<出力先>/GB_募集基準_*.png` (2 倍解像度)

## 注意

- 落とした CSV は 1 人 1 行の匿名データだが**公開リポジトリに入れない** (手元の出力フォルダに置く)
- 人数 5 人未満の帯は非表示、15 人未満は ※ (参考値)。上端のまばらな帯は「950+」にまとめる
- 「3凸合計」= 3 凸とも通常の凸 (締め凸なし・シャドウ範囲内) のセットの合計・1 人 1 票 (合計が最大の日)
- 色: 属性の見出しだけ属性色、分布の線は 1 色 (青の濃淡) — 本家 PAD の属性名は 灼熱/水冷/風圧/電撃/鉄甲
