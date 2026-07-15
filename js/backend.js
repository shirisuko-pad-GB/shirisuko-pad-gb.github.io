// 測定データの蓄積先 (専用 Supabase プロジェクト / PAD の DB とは完全分離)。
// SDK は使わず REST を fetch 直叩き (依存ゼロ・軽量)。
//
// 【秘匿・堅牢化設計】 measurements テーブルは匿名の直接 read/write を禁止 (04_hardening.sql):
//   - 送信は RPC submit_measurements のみ → サーバーが score/comp_key を計算して返す
//     (SLv補正テーブルは未公開のためクライアントに持たせない / 生行は匿名に晒さない)
//   - 分布・集計も RPC (get_distribution / get_comp_insights)。しきい値未満は gated で本体を返さない

import { sanitizeCharacters } from './shared.js';

const SUPABASE_URL = 'https://uwrtsrkeiitboksyzmtq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ZiDwYK5RyuQwNl78ukBdAQ_PVcnJQ2Z';

const rpcUrl = (fn) => `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
const HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
};

async function callRpc(fn, body) {
    const res = await fetch(rpcUrl(fn), {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${fn} failed: ${res.status} ${await res.text()}`);
    return res.json();
}

export function backendConfigured() {
    return !!(SUPABASE_URL && SUPABASE_KEY);
}

// 端末識別子 (匿名・1端末1票の集計キー)
export function getClientId() {
    let id = localStorage.getItem('spg_client_id');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('spg_client_id', id);
    }
    return id;
}

// 凸セット (1〜3件) を一括登録し、サーバー計算の score と server由来の comp_key を受け取る。
// attacks = [{attribute, slv, damage, characters}]
// 戻り値: 送信順の [{score, compKey}]
export async function submitSet(attacks, baseVersion, raidKey = null) {
    if (!backendConfigured()) throw new Error('backend not configured');
    const setId = attacks.length > 1 ? crypto.randomUUID() : null;
    const clientId = getClientId();
    const rows = attacks.map((a, i) => ({
        attribute: a.attribute,
        slv: a.slv,
        damage: a.damage,
        base_version: baseVersion,
        raid_key: raidKey,
        characters: sanitizeCharacters(a.characters),   // 5×正規画像名でなければ null
        client_id: clientId,
        set_id: setId,
        set_slot: setId ? i + 1 : null,
        // score / norm_damage / comp_key はサーバー側で計算・付与する
    }));
    const returned = await callRpc('submit_measurements', { p_rows: rows });  // [{score, comp_key}]
    return rows.map((r, i) => ({
        score: Number(returned[i]?.score),
        compKey: returned[i]?.comp_key ?? null,
    }));
}

// 分布を取得 (サーバー側で 1端末1票ベスト・直近120日・p1〜p99トリム)。
// score = 送信の返事で得た自分のふるり値。返り値もすべてふるり値単位:
//   閾値以上: {n, above, median, lo, hi, bins[], my_bin}
//   閾値未満: {n, gated:true} (分布本体なし) / データ0件: {n: 0}
export async function fetchDistribution({ attribute, score, baseVersion, compKey = null }) {
    if (!backendConfigured()) return null;
    return callRpc('get_distribution', {
        p_attribute: attribute,
        p_score: score,
        p_base_version: baseVersion,
        p_comp_key: compKey,
    });
}

// みんなのデータ: キャラ採用率 + 編成ランキング (1端末1票ベスト・編成つき提出のみ)。
//   閾値以上: {n, chars: [{img, count}], comps: [{chars, n, best, median}]}
//   閾値未満: {n, gated:true} / 0件: {n: 0}
export async function fetchCompInsights({ attribute, baseVersion, raidKey = null }) {
    if (!backendConfigured()) return null;
    return callRpc('get_comp_insights', {
        p_attribute: attribute,
        p_base_version: baseVersion,
        p_raid_key: raidKey,
    });
}
