-- しりすこPAD GB: レイド刻印 + みんなのデータ集計 (02_stats 適用後に実行。冪等)
-- シードを含まないためこのままコミット・GitHubからのコピーOK。

-- ============================================================
-- 1) レイド刻印 — data/raid.json の raidKey を送信時にスタンプ。
--    レイド単位の集計 (3凸総合・ボスの通りやすさ補正) の軸になる
-- ============================================================
alter table public.measurements
    add column if not exists raid_key text;

create index if not exists measurements_raid_idx on public.measurements (raid_key, attribute);

-- ============================================================
-- 2) みんなのデータ集計 RPC
--    編成つき提出を 1端末1票 (ベスト) で集計し、
--    キャラ採用率 と 編成ランキング (採用数・最高・中央値) を返す。
--    スコアはふるり値単位 (p_base_version の基準で換算)。
-- ============================================================
create or replace function public.get_comp_insights(
    p_attribute    text,
    p_base_version text,
    p_days         int  default 120,
    p_raid_key     text default null,   -- 指定するとそのレイドのみ
    p_top_chars    int  default 30,
    p_top_comps    int  default 10
)
returns json
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_k     numeric;
    v_chars json;
    v_comps json;
    v_n     int;
begin
    select r.ratio / b.base_damage into v_k
    from public.fururi_bases b
    join public.slv_ratio r on r.slv = b.base_slv
    where b.base_version = p_base_version and b.attribute = p_attribute;
    if not found then
        raise exception 'unknown base_version/attribute: % / %', p_base_version, p_attribute;
    end if;

    -- 編成つき提出のみ・1端末1票 (ベスト) → キャラ採用率と編成ランキングを1文で集計
    with rows as (
        select distinct on (coalesce(client_id::text, id::text))
               characters, comp_key, norm_damage
        from public.measurements
        where attribute = p_attribute
          and characters is not null
          and norm_damage is not null
          and created_at > now() - make_interval(days => p_days)
          and (p_raid_key is null or raid_key = p_raid_key)
        order by coalesce(client_id::text, id::text), norm_damage desc
    )
    select
        (select count(*) from rows),
        -- キャラ採用率 (1票の編成に入っていれば1カウント)
        (select json_agg(json_build_object('img', img, 'count', cnt) order by cnt desc, img)
         from (
             select img, count(*)::int as cnt
             from rows, lateral jsonb_array_elements_text(characters) as t(img)
             group by img
             order by cnt desc
             limit p_top_chars
         ) c),
        -- 編成ランキング (採用票数 → 中央値の順)
        (select json_agg(json_build_object(
                    'chars', chars, 'n', n_votes,
                    'best', round((best * v_k)::numeric, 4),
                    'median', round((med * v_k)::numeric, 4))
                order by n_votes desc, med desc)
         from (
             select comp_key,
                    (array_agg(characters))[1] as chars,
                    count(*)::int as n_votes,
                    max(norm_damage) as best,
                    percentile_cont(0.5) within group (order by norm_damage) as med
             from rows
             group by comp_key
             order by n_votes desc, med desc
             limit p_top_comps
         ) g)
    into v_n, v_chars, v_comps;

    if v_n = 0 then
        return json_build_object('n', 0);
    end if;
    return json_build_object('n', v_n, 'chars', v_chars, 'comps', v_comps);
end;
$$;

grant execute on function public.get_comp_insights(text, text, int, text, int, int) to anon;
