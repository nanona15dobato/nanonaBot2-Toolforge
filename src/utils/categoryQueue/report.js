/**
 * カテゴリキュー: 編集要約とキューページへの返信文
 */

const MAX_LISTED_PAGES = 30;

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
        duplicate: `${catLink(command.from)}を${to}へ複製`,
        remove: `${catLink(command.from)}を除去`,
    }[command.type];
    return `Bot: ${body} ([[${discussionLink}|議論場所]]) (ID: ${id})`;
}

function pageList(titles) {
    const shown = titles.slice(0, MAX_LISTED_PAGES).map(t => `[[:${t}]]`).join('、');
    const more = titles.length > MAX_LISTED_PAGES ? ` ほか${titles.length - MAX_LISTED_PAGES}件` : '';
    return shown + more;
}

/**
 * キューページへの返信（署名つき）
 * @param {object} p
 * @param {'完了'|'不受理'|'不可能'|'中止'} p.status {{BOTREQ}}の引数
 * @param {string} p.message
 * @param {string} [p.id]
 * @param {object} [p.result] executeCommand の結果
 * @param {string[]} [p.notes] 追記事項
 */
function formatReply({ status, message, id, result, notes = [] }) {
    const lines = [`:{{BOTREQ|${status}}}${id ? ` (ID: ${id})` : ''} ${message}`];
    if (result) {
        if (result.unchanged.length > 0) {
            lines.push(`:: 直接のカテゴリ指定が見つからず変更しなかったページ（テンプレート経由などの可能性。要確認）${result.unchanged.length}件: ${pageList(result.unchanged)}`);
        }
        if (result.warnings.length > 0) {
            lines.push(`:: 編集はしたが確認が必要なページ${result.warnings.length}件:`);
            for (const w of result.warnings.slice(0, MAX_LISTED_PAGES)) lines.push(`::* [[:${w.title}]] - ${w.messages.join(' / ')}`);
        }
        if (result.errors.length > 0) {
            lines.push(`:: 編集できなかったページ${result.errors.length}件:`);
            for (const e of result.errors.slice(0, MAX_LISTED_PAGES)) lines.push(`::* [[:${e.title}]] - ${e.message}`);
        }
    }
    for (const note of notes) lines.push(`:: ${note}`);
    lines[lines.length - 1] += ' --~~~~';
    return lines.join('\n');
}

module.exports = { editSummary, formatReply, catLink };
