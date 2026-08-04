-- ============================================================================
-- 10_own_edits.sql — 自分の提出の後編集 (締め凸トグル + ダメージ/編成の修正)
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜09。
-- **既存データ・既存関数は一切変更しない** (新規RPC 2本の追加のみ)。
--
-- 背景 (運営判断 2026-08-04):
--  - 提出後に「あれは締め凸だった」と気付いた人が、再入力なしで自分の票を
--    集計から外せるようにする (再訪 → 前回結果 → トグル1タップ)。
--  - ダメージの桁間違い (スコアが score_bounds 外に出てシャドウ除外され
--    「無言で票が消えている」状態) を、本人が修正して復帰できるようにする。
--    単純な再送信では古い誤り行が per-client ベスト選抜に勝ち残るため、
--    「自分のその属性の行を置き換える」原子的な RPC が必要。
--
-- セキュリティモデルは submit と同じ「client_id (端末ローカルのランダムUUID) を
-- 知っている = 本人」の bearer 方式。**どちらの RPC も指定 client_id の行しか触れない**。
-- UUIDv4 (2^122通り) の総当たりは非現実的だが、UUID が漏れればその人の票を
-- 操作できる点は submit と同等の割り切り (Codexレビュー 2026-08-04 で明文化)。
-- correct は「既存行がある場合のみ」置き換え可 (新規作成は submit のみ —
-- この RPC を Sybil 的な行量産に使えないようにするガード)。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) mark_own_finish — 自分の (属性, シーズン) の行の締め凸フラグを一括更新。
--    行の削除・追加はしない。戻り値 = 更新行数。
-- ---------------------------------------------------------------------------
create or replace function public.mark_own_finish(
    p_client_id uuid, p_season text, p_attribute text, p_is_finish boolean
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
    v_status text; v_active text; v_n int;
begin
    select status, active_season into v_status, v_active from public.site_state where id;
    if v_status is distinct from 'open' or v_active is null then
        raise exception 'submissions are closed';       -- 締切後の書き換えは不可 (submit と同じ)
    end if;
    if p_season is distinct from v_active then raise exception 'season not open'; end if;
    if p_client_id is null then raise exception 'client_id required'; end if;

    update public.measurements
       set is_finish = coalesce(p_is_finish, false)
     where client_id = p_client_id and season = p_season and attribute = p_attribute;
    get diagnostics v_n = row_count;
    return v_n;
end; $$;
revoke all on function public.mark_own_finish(uuid, text, text, boolean) from public;
grant execute on function public.mark_own_finish(uuid, text, text, boolean) to anon;

-- ---------------------------------------------------------------------------
-- 2) correct_own_measurement — 自分の (属性, シーズン) の行を新しい1行に置き換える。
--    削除 → 挿入は同一トランザクション: 挿入が CHECK 等で失敗したら例外で全体が
--    ロールバックされ、**元の行はそのまま残る** (中途半端な消失は起きない)。
--    score / norm_damage / comp_key の計算は従来どおり INSERT トリガと本関数内
--    (submit_measurements と同じ手順)。戻り値 = {score, comp_key, replaced}。
-- ---------------------------------------------------------------------------
create or replace function public.correct_own_measurement(p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    v_status text; v_active text; v_char jsonb; v_comp_key text; v_score numeric;
    v_client uuid; v_attr text; v_replaced int;
begin
    select status, active_season into v_status, v_active from public.site_state where id;
    if v_status is distinct from 'open' or v_active is null then
        raise exception 'submissions are closed';
    end if;
    if (p_row ->> 'client_id') is null then raise exception 'client_id required'; end if;
    if (p_row ->> 'season') is distinct from v_active then raise exception 'season not open'; end if;
    if (p_row ->> 'attribute') is null then raise exception 'attribute required'; end if;

    v_client := (p_row ->> 'client_id')::uuid;
    v_attr := p_row ->> 'attribute';
    v_char := case when jsonb_typeof(p_row -> 'characters') = 'array' then p_row -> 'characters' else null end;
    v_comp_key := case when v_char is null then null
                       else (select string_agg(e, '|' order by e) from jsonb_array_elements_text(v_char) as t(e)) end;

    -- 自分の行だけを置き換える (client_id + season + attribute の3条件を必ず揃える)
    delete from public.measurements
     where client_id = v_client and season = v_active and attribute = v_attr;
    get diagnostics v_replaced = row_count;

    -- 既存行が無いなら「修正」ではない → 拒否 (新規作成は submit_measurements のみ。
    -- この RPC で無から行を量産する Sybil/DoS 経路を塞ぐ — Codex指摘)。
    -- 例外で関数全体が失敗するため上の delete も無効 (何も変わらない)
    if v_replaced = 0 then raise exception 'no existing submission to correct'; end if;

    begin
        insert into public.measurements
            (attribute, slv, damage, season, characters, comp_key, client_id, set_id, set_slot, is_finish)
        values (
            v_attr, (p_row ->> 'slv')::int, (p_row ->> 'damage')::numeric, v_active,
            v_char, v_comp_key, v_client, null, null,
            coalesce((p_row ->> 'is_finish')::boolean, false)
        )
        returning score into v_score;
    exception when others then
        -- DETAIL ("Failing row contains ...") を落とす (07 と同じ漏洩ガード)。
        -- 例外で関数全体が失敗 → 上の delete もロールバックされ元の行は残る
        raise exception '%', sqlerrm using errcode = sqlstate;
    end;

    return jsonb_build_object('score', v_score, 'comp_key', v_comp_key, 'replaced', v_replaced);
end; $$;
revoke all on function public.correct_own_measurement(jsonb) from public;
grant execute on function public.correct_own_measurement(jsonb) to anon;

notify pgrst, 'reload schema';
