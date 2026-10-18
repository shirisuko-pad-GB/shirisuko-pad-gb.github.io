-- ============================================================================
-- 13_input_source.sql — 提出が「スクショ読み取り経由」か「手入力」かを記録する
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜12。
-- **既存データは一切変更しない** (カラム追加 default 'manual' + submit_measurements の差し替えのみ。
--  旧クライアントは input_source を送らない = 'manual' として従来どおり通る → 無停止で適用できる)。
--
-- 背景 (2026-10-18): 編成つき提出の割合が 第43回 50% → 第44回 53% → 第45回 37% と急落。
-- 候補は (a) 結果発表で「強かった編成」を公開したこと (b) スクショ読み取り (9/24〜) が
-- 属性・ダメージしか入れず、そのまま送ると「編成なし」になること。どちらが効いているかを
-- 次シーズンで切り分けるための記録。集計・分布の計算には一切使わない。
--
-- 値は 'manual' / 'ocr' の2つだけ。それ以外が来ても弾かず 'manual' に寄せる (送信を止めない)。
-- ⚠ 限界: 後編集 (10 の correct_own_measurement) は行を削除→再挿入するため 'manual' に戻る。
--   修正は少数なので許容 (切り分けの判断を変えるほどではない)。
--
-- このファイルが submit_measurements の最終定義になる (本文は 09 と同一 + input_source)。
-- get_distribution / get_comp_insights の最終定義は引き続き 09。
-- ============================================================================

alter table public.measurements
    add column if not exists input_source text not null default 'manual';

do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'measurements_input_source_check') then
        alter table public.measurements
            add constraint measurements_input_source_check check (input_source in ('manual', 'ocr'));
    end if;
end $$;

create or replace function public.submit_measurements(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    v_len int; v_row jsonb; v_char jsonb; v_comp_key text; v_score numeric;
    v_out jsonb := '[]'::jsonb; v_status text; v_active text;
begin
    select status, active_season into v_status, v_active from public.site_state where id;
    if v_status is distinct from 'open' or v_active is null then
        raise exception 'submissions are closed';                 -- between/maintenance は送信不可
    end if;

    v_len := jsonb_array_length(p_rows);
    if v_len is null or v_len < 1 or v_len > 3 then raise exception 'invalid batch size'; end if;

    for v_row in select value from jsonb_array_elements(p_rows) loop
        if (v_row ->> 'client_id') is null then raise exception 'client_id required'; end if;
        if (v_row ->> 'season') is distinct from v_active then raise exception 'season not open'; end if;

        v_char := case when jsonb_typeof(v_row -> 'characters') = 'array' then v_row -> 'characters' else null end;
        v_comp_key := case when v_char is null then null
                           else (select string_agg(e, '|' order by e) from jsonb_array_elements_text(v_char) as t(e)) end;

        begin
            insert into public.measurements
                (attribute, slv, damage, season, characters, comp_key, client_id, set_id, set_slot, is_finish, input_source)
            values (
                v_row ->> 'attribute', (v_row ->> 'slv')::int, (v_row ->> 'damage')::numeric, v_row ->> 'season',
                v_char, v_comp_key, (v_row ->> 'client_id')::uuid,
                nullif(v_row ->> 'set_id', '')::uuid, (v_row ->> 'set_slot')::smallint,
                coalesce((v_row ->> 'is_finish')::boolean, false),
                case when (v_row ->> 'input_source') = 'ocr' then 'ocr' else 'manual' end
            )
            returning score into v_score;
        exception when others then
            -- DETAIL ("Failing row contains ...") を落とす。メッセージと SQLSTATE は保持
            raise exception '%', sqlerrm using errcode = sqlstate;
        end;
        v_out := v_out || jsonb_build_object('score', v_score, 'comp_key', v_comp_key);
    end loop;
    return v_out;
end; $$;
grant execute on function public.submit_measurements(jsonb) to anon;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- シーズン終わりの確認用 (SQL Editor で実行。集計値のみ):
--   select input_source,
--          count(*) as submissions,
--          count(*) filter (where comp_key is not null) as with_comp,
--          round(100.0 * count(*) filter (where comp_key is not null) / count(*)) as comp_pct
--     from public.measurements where season = '<シーズン>' and not is_finish
--    group by input_source order by input_source;
-- ---------------------------------------------------------------------------
