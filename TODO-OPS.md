# 運用TODO (完了したら該当行を消す / 全部済んだらこのファイルごと削除)

## ⏳ 未適用: supabase/06_input_bounds.sql (2026-07-29 作成)

damage のサーバー側上限CHECK (0 < damage < 1000B)。**適用するまで動作は今まで通り** (急ぎではないが公開拡散前に推奨)。

手順 (どのPCでもOK — SQL Editor はブラウザ作業):
1. https://supabase.com/dashboard → **GB のプロジェクト** (uwrtsrkeiitboksyzmtq) → SQL Editor
2. リポジトリの `supabase/06_input_bounds.sql` の中身を貼り付けて **Run**
3. 確認: 同じく SQL Editor で `supabase/99_check_applied.sql` を実行 → `06_input_bounds` の行が ✅ になればOK

⚠ 本家PADのプロジェクトと間違えないこと (GB は別プロジェクト)。
