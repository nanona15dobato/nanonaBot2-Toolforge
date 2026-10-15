/**
 * カテゴリキュー: 編集要約とキューページへの返信文
 */

// nanonaBot2 Web（Toolforge の webservice）
const WEB_BASE = 'https://nanonabot2-01.toolforge.org';

const catLink = name => `[[:Category:${name}]]`;

/**
 * 編集要約（QueueBotの形式に合わせる）
 * @param {{type: string, from: string, to: string[]}} command
 * @param {string} discussionLink
 * @param {string} id
 */
function editSummary(command, discussionLink, id) {
    const to = command.to.map(catLink).join(',');
    const body = {
        reassign: `${catLink(command.from)}から${to}へ変更`,
        remove: `${catLink(command.from)}を除去`,
    }[command.type];
    return `Bot: ${body} ([[${discussionLink}|議論場所]]) (ID: ${id})`;
}

/** コマンドの詳細ページ（nanonaBot2 Web）の URL */
function detailUrl(id) {
    return `${WEB_BASE}/queue/${encodeURIComponent(id)}`;
}

/** 「12件を編集しました（変更なし3件・スキップ1件・要確認1件・エラー1件）。」 */
function countsText(counts) {
    const extra = [
        counts.unchanged ? `変更なし${counts.unchanged}件` : null,
        counts.skipped ? `スキップ${counts.skipped}件` : null,
        counts.warnings ? `要確認${counts.warnings}件` : null,
        counts.errors ? `エラー${counts.errors}件` : null,
    ].filter(Boolean);
    return `${counts.edited}件を編集しました${extra.length ? `（${extra.join('・')}）` : ''}。`;
}

/**
 * キューページへの返信（署名つき、1行）
 * ページの一覧や理由は返信に書かず、Web の詳細ページに載せる（キューページを長くしないため）。
 * @param {object} p
 * @param {'完了'|'不受理'|'不可能'|'中止'} p.status {{BOTREQ}}の引数
 * @param {string} [p.message] 不受理・中止などの理由
 * @param {string} [p.id]
 * @param {{edited: number, unchanged: number, skipped?: number, warnings: number, errors: number}} [p.counts] 編集した件数（完了・途中で中止したとき）
 * @param {string[]} [p.notes] 追記事項（「Category:Name1 は空になりました。」など）
 */
function formatReply({ status, message, id, counts, notes = [] }) {
    const parts = [`:{{BOTREQ|${status}}}`];
    if (id) parts.push(`(ID: ${id})`);
    if (message) parts.push(/[。.]$/.test(message) ? message : `${message}。`);
    if (counts) parts.push(countsText(counts));
    parts.push(...notes);
    if (id) parts.push(`詳細は[${detailUrl(id)} 処理結果]を参照してください。`);
    return `${parts.join(' ')} --~~~~`;
}

/**
 * 着手の返信。印「{{BOTREQ|着手}} (ID: …)」を付け、以後はこの ID で節を探す
 * （queue.startMark と同じ形。変えるときは queue.js の MARK_ID_AFTER も直す）
 */
function formatStart(id) {
    return `:{{BOTREQ|着手}} (ID: ${id}) 処理を始めました。進み具合は[${detailUrl(id)} 処理状況]で確認できます。 --~~~~`;
}

module.exports = { editSummary, formatReply, formatStart, countsText, detailUrl, catLink };
