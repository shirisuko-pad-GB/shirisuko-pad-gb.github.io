// 測定データの蓄積先 (専用 Supabase プロジェクト / PAD の DB とは完全分離)。
// SDK は使わず REST を fetch 直叩き (依存ゼロ・軽量)。
//
// 【秘匿設計】 ふるり値の計算に使う SLv補正テーブルは未公開の検証データのため
// クライアントには持たせない。計算はすべてサーバー側:
//   - 送信 (INSERT) → トリガが score を計算 → 返事 (?select=attribute,score) で受け取る
//   - 分布も RPC get_distribution がふるり値単位で集計して返す

const SUPABASE_URL = 'https://uwrtsrkeiitboksyzmtq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ZiDwYK5RyuQwNl78ukBdAQ_PVcnJQ2Z';

const TABLE = `${SUPABASE_URL}/rest/v1/measurements`;
const RPC = `${SUPABASE_URL}/rest/v1/rpc/get_distribution`;
const HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
};

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

export function compKeyOf(characters) {
    return characters && characters.length === 5 ? [...characters].sort().join('|') : null;
}

// 凸セット (1〜3件) を一括登録し、サーバーが計算したふるり値を受け取る。
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
        characters: a.characters && a.characters.length === 5 ? a.characters : null,
        comp_key: compKeyOf(a.characters),
        client_id: clientId,
        set_id: setId,
        set_slot: setId ? i + 1 : null,
        // score / norm_damage はサーバーのトリガが計算する
    }));
    const res = await fetch(`${TABLE}?select=score`, {
        method: 'POST',
        headers: { ...HEADERS, 'Prefer': 'return=representation' },
        body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`submit failed: ${res.status} ${await res.text()}`);
    const returned = await res.json();   // 挿入順で返る
    return rows.map((r, i) => ({ score: Number(returned[i]?.score), compKey: r.comp_key }));
}

// 分布を取得 (サーバー側で 1端末1票ベスト・直近120日・p1〜p99トリム)。
// score = 送信の返事で得た自分のふるり値。返り値もすべてふるり値単位:
//   {n, above, median, lo, hi, bins[], my_bin} / データ0件なら {n: 0}
export async function fetchDistribution({ attribute, score, baseVersion, compKey = null }) {
    if (!backendConfigured()) return null;
    const res = await fetch(RPC, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
            p_attribute: attribute,
            p_score: score,
            p_base_version: baseVersion,
            p_comp_key: compKey,
        }),
    });
    if (!res.ok) throw new Error(`distribution failed: ${res.status} ${await res.text()}`);
    return res.json();
}

// みんなのデータ: キャラ採用率 + 編成ランキング (1端末1票ベスト・編成つき提出のみ)。
// 戻り値: {n, chars: [{img, count}], comps: [{chars, n, best, median}]} / 0件なら {n: 0}
export async function fetchCompInsights({ attribute, baseVersion, raidKey = null }) {
    if (!backendConfigured()) return null;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_comp_insights`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
            p_attribute: attribute,
            p_base_version: baseVersion,
            p_raid_key: raidKey,
        }),
    });
    if (!res.ok) throw new Error(`insights failed: ${res.status} ${await res.text()}`);
    return res.json();
}
