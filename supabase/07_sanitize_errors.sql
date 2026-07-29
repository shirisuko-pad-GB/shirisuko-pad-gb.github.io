-- 07_sanitize_errors.sql — エラー応答から行内容 (norm_damage/score) の漏洩を止める
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜06 適用済み。
--
-- 【問題】 CHECK 違反 (damage_bounds / characters_format 等) の Postgres エラーには
-- DETAIL として "Failing row contains (...)" = 失敗行の全列が入り、PostgREST が
-- そのままクライアントへ返す。行には BEFORE INSERT トリガが計算済みの
-- score と norm_damage (= damage ÷ slv_ratio[slv]) が含まれるため、
-- わざと弾かれる送信 (例: damage=5000B) を SLv を変えながら繰り返すだけで、
-- 1行も挿入せず・票も汚さずに 秘匿テーブル slv_ratio を正確に逆算できてしまう
-- (2026-07-29 に外部プローブで実証。「SLv補正テーブルの秘匿」ルール違反)。
--
-- 【対処】 INSERT を例外ハンドラで包み、メッセージ (制約名まで) と SQLSTATE だけ
-- 再送出して DETAIL / HINT を落とす。事前バリデーションの重複実装はしない
-- (CHECK が唯一の正のまま、将来の制約追加も自動的に漏洩しない)。
--
-- ※ submit_measurements の最終定義は 05_seasons.sql からこのファイルに移った。
--   他の RPC (get_distribution / get_comp_insights) の最終定義は引き続き 05。

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
                (attribute, slv, damage, season, characters, comp_key, client_id, set_id, set_slot)
            values (
                v_row ->> 'attribute', (v_row ->> 'slv')::int, (v_row ->> 'damage')::numeric, v_row ->> 'season',
                v_char, v_comp_key, (v_row ->> 'client_id')::uuid,
                nullif(v_row ->> 'set_id', '')::uuid, (v_row ->> 'set_slot')::smallint
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
