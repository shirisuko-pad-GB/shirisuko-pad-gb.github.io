// 表示文言の辞書 (ja / en)。仕組みは i18n.js、ここはデータだけ。
//
// **訳語の方針** (英語圏プレイヤーからの要望で 2026-09-08 追加):
// - ゲーム用語は NIKKE 英語版の公式表記に合わせる:
//   属性 = Code (Fire / Water / Electric / Iron / Wind)、Union Raid、Synchro Level、Burst
// - 「ふるり値」は固有名詞なので訳さず **Fururi Score** (カード内の狭い場所は Fururi)
// - 「凸」= attack、「締め凸」= finisher (打ち切りダメージの最後の一撃)
// - 「PT」= team、「編成」= comp / team
//
// 鍵の付け方: `領域.意味` (card.* = シェアカード / ui.* = 測定画面 / stats.* = みんなのデータ)。
// 値が {one, other} の形なら、t(key, {n}) の n で単複を選ぶ (英語の 1 user / 5 users)。
// **英語に鍵が無ければ日本語へ落ちる**ので、訳は少しずつ足せる。
export const MESSAGES = {
    ja: {
        // ── 属性 (ATTR_INFO のキーと対) ──
        'attr.FIRE': '灼熱',
        'attr.WATER': '水冷',
        'attr.ELECTRIC': '電撃',
        'attr.IRON': '鉄甲',
        'attr.WIND': '風圧',
        'attr.unknown': '属性？',

        // ── 共通 ──
        'common.refreshing': '更新中…',
        'common.lang_name': '日本語',
        'common.lang_switch': 'English',

        // ── シェアカード ──
        'card.team_of': '{code}PT',
        'card.results': '測定結果',
        'card.results_n': '測定結果 ({n}凸)',
        'card.median_is_100': '中央値 = みんなの真ん中 = 100%',
        'card.overall': '総合',
        'card.overall_note': '各凸の中央値比を同じ重みで平均',
        'card.avg_fururi_all_finish': '平均ふるり値 (全て締め凸・参考)',
        'card.avg_fururi_n': '平均ふるり値 ({n}凸)',
        'card.sub_all_finish': '締め凸{n}凸 / SLv {slv}',
        'card.sub_excl_finish': '{n}凸 (締め凸除く) / SLv {slv}',
        'card.sub_plain': '{n}凸 / SLv {slv}',
        'card.users_n': '利用者 {n}人',
        'card.vs_completed': '3凸完走 {n}人と比較',
        'card.vs_submissions': 'のべ {n}人の提出と比較',
        'card.finish_excluded': '締め凸は分布・総合に不参加 (参考)',
        'card.note_line1': 'ボスの通りやすさは属性ごとの',
        'card.note_line2': '中央値で補正済み。編成内%は',
        'card.note_line3': '同じ5人との比較 (並び順は不問)',
        'card.fururi': 'ふるり値',
        'card.fururi_val': 'ふるり値 {v}',
        'card.finisher': '締め凸',
        'card.median_n': '中央値 {v} · {n}人',
        'card.until_dist': 'みんなの分布まで あと{n}人',
        'card.progress_n': '現在 {now} / {need}人',
        'card.in_comp': '編成内 {pct}% · {n}人',
        'card.in_comp_locked': '編成内%は{n}人で解禁',
        'card.fanmade': '非公式ファンコンテンツ — 掲載に問題がある場合は削除対応します',
        'card.copyright': 'キャラクター画像・名称: 勝利の女神：NIKKE © SHIFT UP CORP.',
    },

    en: {
        // ── Codes (NIKKE 公式の属性表記) ──
        'attr.FIRE': 'Fire',
        'attr.WATER': 'Water',
        'attr.ELECTRIC': 'Electric',
        'attr.IRON': 'Iron',
        'attr.WIND': 'Wind',
        'attr.unknown': 'Code?',

        'common.refreshing': 'Refreshing…',
        'common.lang_name': 'English',
        'common.lang_switch': '日本語',

        // ── Share card ──
        // カードは幅が固定なので、日本語より長くなりがちな英語は**短い言い回し**を選ぶ。
        // ここを長くすると数字の隣で溢れる (レイアウトは幅を測って縮めない箇所がある)。
        'card.team_of': '{code} team',
        'card.results': 'Results',
        'card.results_n': 'Results ({n} attacks)',
        'card.median_is_100': 'Median of everyone = 100%',
        'card.overall': 'Overall',
        'card.overall_note': 'Avg of median ratios',
        'card.avg_fururi_all_finish': 'Avg Fururi (finishers · ref)',
        'card.avg_fururi_n': 'Avg Fururi ({n} attacks)',
        'card.sub_all_finish': '{n} finishers / SLv {slv}',
        'card.sub_excl_finish': '{n} attacks / SLv {slv}',
        'card.sub_plain': '{n} attacks / SLv {slv}',
        'card.users_n': { one: '{n} user', other: '{n} users' },
        'card.vs_completed': 'vs {n} who cleared 3',
        'card.vs_submissions': 'vs {n} submissions',
        'card.finish_excluded': 'Finishers excluded (ref only)',
        'card.note_line1': 'Normalized by each code’s',
        'card.note_line2': 'median. In-comp % is vs',
        'card.note_line3': 'the same 5 (any order)',
        'card.fururi': 'Fururi',
        'card.fururi_val': 'Fururi {v}',
        'card.finisher': 'Finisher',
        'card.median_n': 'Median {v} · {n}',
        'card.until_dist': '{n} more to unlock stats',
        'card.progress_n': 'Now {now} / {need}',
        'card.in_comp': 'In comp {pct}% · {n}',
        'card.in_comp_locked': 'In-comp % unlocks at {n}',
        'card.fanmade': 'Unofficial fan content — will be removed on request',
        'card.copyright': 'Character art & names: GODDESS OF VICTORY: NIKKE © SHIFT UP CORP.',
    },
};
