-- しりすこPADグローバル: 測定データ蓄積テーブル
-- 専用 Supabase プロジェクトの SQL Editor で実行すること (PAD の DB には入れない)。
--
-- 方針: 匿名の不特定多数から INSERT を受けるため、
--   - anon は INSERT と SELECT のみ (UPDATE / DELETE 不可 → 改ざん・削除できない)
--   - ゴミデータは CHECK 制約で入口で弾く

create table public.measurements (
    id           bigint generated always as identity primary key,
    created_at   timestamptz not null default now(),
    attribute    text        not null check (attribute in ('FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND')),
    slv          int         not null check (slv between 1 and 1000),
    damage       numeric     not null check (damage > 0 and damage < 1e15),
    score        numeric     not null check (score > 0 and score < 1000),
    base_version text        not null,          -- 基準データの版 (例 '2026-07')。版が違うスコアは混ぜない
    characters   jsonb,                          -- キャラ画像ファイル名5個の配列 or null
    comp_key     text,                           -- characters をソートして '|' 連結 (同一編成の検索用)
    client_id    uuid                            -- 端末識別 (localStorage 由来・匿名)
);

-- 分布取得は 属性 × 基準版 (+ comp_key) で絞る
create index measurements_dist_idx on public.measurements (base_version, attribute);
create index measurements_comp_idx on public.measurements (comp_key) where comp_key is not null;

alter table public.measurements enable row level security;

create policy "anon_insert" on public.measurements
    for insert to anon with check (true);

create policy "anon_select" on public.measurements
    for select to anon using (true);

-- UPDATE / DELETE のポリシーは作らない = anon には不可
