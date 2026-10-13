/**
 * カテゴリキュー: キューページの節の読み取り・コマンドの解釈・返信の挿入
 *
 * 対応する構文（プロジェクト:カテゴリ関連/キュー/導入文）
 *   == Bot: [[:Category:A]]を[[:Category:B]]へ ==
 *   == Bot: [[:Category:A]]を[[:Category:B]]と[[:Category:C]]へ ==
 *   == Bot: (記事) [[:Category:A]]を[[:Category:B]]へ ==
 *   == Bot: (カテゴリ) [[:Category:A]]を[[:Category:B]]へ ==
 *   == Bot: [[:Category:A]]を除去 ==
 *   == Bot: [[:Category:A]]を[[:Category:B]]に複製 ==
 * 本文の最初のリンク（カテゴリ・利用者ページ等を除く）を議論場所とする。
 */
const WikitextParser = require('../parse2');
const { bareCategoryName } = require('./title');

// 「Bot:」だけの場合の対象名前空間（QueueBotと同じく標準・Category）
const DEFAULT_NAMESPACES = [0, 14];
const NAMESPACES_BY_SCOPE = { '記事': [0], 'カテゴリ': [14] };
const MAX_TO_CATEGORIES = 5;
const NON_DISCUSSION_PREFIX = /^\s*:?\s*(?:category|カテゴリ|file|ファイル|画像|image|user|利用者|user[ _]talk|利用者[‐-]会話|special|特別)\s*:/i;
const parser = new WikitextParser();

/**
 * キューページを第2レベルの節に分ける
 * 見出しの検出は parse2 に任せる（コメント・<nowiki> の中やテンプレートの中の見出しは数えない）
 * @param {string} wikitext
 * @returns {{heading: string, headingLine: string, occurrence: number, start: number, bodyStart: number, end: number, body: string}[]}
 */
function parseQueueSections(wikitext) {
    const sections = [];
    const seen = new Map();
    for (const h of parser.parse(wikitext, { headings: true }).headings) {
        if (h.level !== 2) continue;
        const { header, content } = h.position;
        const headingLine = wikitext.slice(header.start, header.end);
        const occurrence = seen.get(headingLine) || 0;
        seen.set(headingLine, occurrence + 1);
        sections.push({
            heading: h.title,
            headingLine,
            occurrence,
            start: header.start,
            bodyStart: header.end,
            end: content.end,
            body: wikitext.slice(header.end, content.end),
        });
    }
    return sections;
}

/** 見出しが「Bot:」で始まるか（異議のある節は「Bot:」が外される） */
function isBotHeading(heading) {
    return /^Bot\s*[:：]/i.test(normalizeSpaces(heading));
}

/** 既に{{BOTREQ}}が付いている節は処理済み（または人が対応中）として扱う */
function isHandled(section) {
    return parser.parse(section.body, { templates: true }).templates
        .some(t => t.type === 'template' && t.name.toLowerCase() === 'template:botreq');
}

function normalizeSpaces(s) {
    return String(s).replace(/&nbsp;|&#160;|&#xa0;| /gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 見出しをコマンドとして解釈する
 * @param {string} heading
 * @returns {{ok: true, command: {type: string, from: string, to: string[], namespaces: number[], scope: string|null}} | {ok: false, error: string}}
 */
function parseCommandHeading(heading) {
    let rest = normalizeSpaces(heading);
    const prefix = /^Bot\s*[:：]\s*/i.exec(rest);
    if (!prefix) return { ok: false, error: '見出しが「Bot:」で始まっていません' };
    rest = rest.slice(prefix[0].length);

    let scope = null;
    const scopeMatch = /^[(（]\s*(記事|カテゴリ)\s*[)）]\s*/.exec(rest);
    if (scopeMatch) {
        scope = scopeMatch[1];
        rest = rest.slice(scopeMatch[0].length);
    }

    const linkRe = /^\[\[\s*(:?)\s*((?:category|カテゴリ)\s*:[^\]|]+?)\s*(?:\|[^\]]*)?\]\]\s*/i;
    const takeLink = () => {
        const lm = linkRe.exec(rest);
        if (!lm) return null;
        rest = rest.slice(lm[0].length);
        return { name: bareCategoryName(lm[2]), colon: lm[1] === ':' };
    };
    const takeWord = word => {
        if (!rest.startsWith(word)) return false;
        rest = rest.slice(word.length).trimStart();
        return true;
    };

    const from = takeLink();
    if (!from) return { ok: false, error: '最初のカテゴリへのリンク（[[:Category:…]]）が見つかりません' };
    if (!takeWord('を')) return { ok: false, error: '「[[:Category:…]]を」の形になっていません' };

    let type;
    const to = [];
    const links = [from];
    if (takeWord('除去')) {
        type = 'remove';
    } else {
        for (;;) {
            const link = takeLink();
            if (!link) return { ok: false, error: '移動先のカテゴリへのリンク（[[:Category:…]]）が見つかりません' };
            links.push(link);
            to.push(link.name);
            if (takeWord('と')) continue;
            if (takeWord('へ')) { type = 'reassign'; break; }
            if (takeWord('に複製')) { type = 'duplicate'; break; }
            return { ok: false, error: '末尾が「へ」「に複製」「を除去」のいずれでもありません' };
        }
    }
    if (rest !== '') return { ok: false, error: `コマンドの後ろに余分な文字列があります（${rest}）` };
    if (links.some(l => !l.colon)) {
        return { ok: false, error: 'カテゴリへのリンクは先頭にコロンを付けて [[:Category:…]] と書いてください' };
    }
    if (!from.name || to.some(t => !t)) return { ok: false, error: 'カテゴリ名が空です' };
    if (to.length > MAX_TO_CATEGORIES) return { ok: false, error: `移動先は${MAX_TO_CATEGORIES}件までです` };
    if (new Set(to).size !== to.length) return { ok: false, error: '移動先に同じカテゴリが重複しています' };
    if (to.includes(from.name)) return { ok: false, error: '移動元と移動先が同じカテゴリです' };

    const namespaces = scope ? NAMESPACES_BY_SCOPE[scope] : DEFAULT_NAMESPACES;
    return { ok: true, command: { type, from: from.name, to, namespaces: [...namespaces], scope } };
}

/**
 * 本文から議論場所へのリンクを取り出す（申請文で示される最初のリンク）
 * @param {string} body
 * @returns {string|null}
 */
function findDiscussionLink(body) {
    // parse2 は [[Category:…]] [[File:…]] をリンクに含めない。[[:Category:…]] や署名のリンクはここで除く
    for (const link of parser.parse(body, { wikilinks: true }).wikilinks) {
        if (link.target && !NON_DISCUSSION_PREFIX.test(link.target)) return link.target;
    }
    return null;
}

/**
 * 節（見出し）の末尾に返信を挿入した本文を返す
 * 見出しの文字列と、同じ見出しの何番目か（occurrence）で節を探し直す
 * @returns {string|null} 節が見つからなければ null
 */
function insertReply(wikitext, section, reply) {
    const target = parseQueueSections(wikitext)
        .find(s => s.headingLine === section.headingLine && s.occurrence === section.occurrence);
    if (!target) return null;
    const before = wikitext.slice(0, target.end).replace(/\s+$/, '');
    const after = wikitext.slice(target.end);
    return `${before}\n${reply}\n${after ? `\n${after}` : ''}`;
}

module.exports = {
    DEFAULT_NAMESPACES,
    parseQueueSections,
    isBotHeading,
    isHandled,
    parseCommandHeading,
    findDiscussionLink,
    insertReply,
};
