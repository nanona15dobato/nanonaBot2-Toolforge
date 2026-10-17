/**
 * カテゴリキュー: キューページの節の読み取り・コマンドの解釈・返信の挿入
 *
 * 対応する構文（プロジェクト:カテゴリ関連/キュー/導入文）
 *   == Bot: [[:Category:A]]を[[:Category:B]]へ ==
 *   == Bot: (記事) [[:Category:A]]を[[:Category:B]]へ ==
 *   == Bot: (カテゴリ) [[:Category:A]]を[[:Category:B]]へ ==
 *   == Bot: [[:Category:A]]を除去 ==
 * 複数の移動先（「…と…へ」）と複製（「…に複製」）は受け付けない（不受理）。
 * 本文の最初のリンク（カテゴリ・利用者ページ等を除く）を議論場所とする。
 */
const WikitextParser = require('../parse2');
const { bareCategoryName } = require('./title');

// 対象名前空間。null はすべての名前空間（「Bot:」だけの場合）。
// (記事) は標準に加えて Template も対象にする（テンプレート経由で記事を分類しているテンプレートを直すため。
// 直したテンプレートの呼び出し先は null edit して、カテゴリの所属をすぐ反映させる。category-queue.js）
const DEFAULT_NAMESPACES = null;
const NAMESPACES_BY_SCOPE = { '記事': [0, 10], 'カテゴリ': [14] };
// カテゴリへのリンクも書き換える名前空間（有効にしたときだけ。sites.js の replaceLinks）。(カテゴリ) では書き換えない
const DEFAULT_LINK_NAMESPACES = [0, 10, 14];
const LINK_NAMESPACES_BY_SCOPE = { '記事': [0, 10], 'カテゴリ': [] };

/** その名前空間が対象か（namespaces が null ならすべて対象） */
const includesNamespace = (namespaces, ns) => namespaces === null || namespaces.includes(ns);
const NON_DISCUSSION_PREFIX = /^\s*:?\s*(?:category|カテゴリ|file|ファイル|画像|image|user|利用者|user[ _]talk|利用者[‐-]会話|special|特別)\s*:/i;
const parser = new WikitextParser();

// Bot が着手時に付ける印「{{BOTREQ|着手}} (ID: …)」。以後はこの ID で節を探す
// （形は report.formatStart と同じ。{{BOTREQ|着手}} の直後に続く「 (ID: …)」を MARK_ID_AFTER で読む）
const MARK_ID_AFTER = /^ \(ID: (\d{14}-[0-9a-f]{6})\)/;
const startMark = id => `{{BOTREQ|着手}} (ID: ${id})`;

/** 本文の最初の行（依頼文と署名）。返信が後ろに付いても変わらない */
function requestLineOf(body) {
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (t) return t;
    }
    return '';
}

/**
 * キューページを第2レベルの節に分ける
 * 見出しの検出は parse2 に任せる（コメント・<nowiki> の中やテンプレートの中の見出しは数えない）
 * @param {string} wikitext
 * @returns {{heading: string, headingLine: string, requestLine: string, start: number, bodyStart: number, end: number, body: string}[]}
 */
function parseQueueSections(wikitext) {
    const sections = [];
    for (const h of parser.parse(wikitext, { headings: true }).headings) {
        if (h.level !== 2) continue;
        const { header, content } = h.position;
        const body = wikitext.slice(header.end, content.end);
        sections.push({
            heading: h.title,
            headingLine: wikitext.slice(header.start, header.end),
            requestLine: requestLineOf(body),
            start: header.start,
            bodyStart: header.end,
            end: content.end,
            body,
        });
    }
    return sections;
}

/**
 * 着手の印（ID）で節を探す。印は Bot が付けたものなので、他の節の追加・過去ログ化や
 * 見出しの書き換えに関係なく、その節を一意に見つけられる
 * @param {string} wikitext 最新のキューページ
 * @param {string} id
 * @returns {{section: object} | {error: 'missing'|'ambiguous'}}
 */
function findById(wikitext, id) {
    return single(parseQueueSections(wikitext).filter(s => scanBotreq(s.body).marks.includes(id)));
}

/**
 * 着手の前（印がまだ無いとき）に節を探す。見出し行と依頼文（本文の最初の行）の両方が同じ節だけを同じものとみなす。
 * 着手の返信と同じ編集の中で、最新の本文に対して使う（探してから書き込むまでの間に変わることはない）
 * @param {string} wikitext
 * @param {{headingLine: string, requestLine: string}} target 読み込んだときの節
 * @returns {{section: object} | {error: 'missing'|'ambiguous'}}
 */
function findByRequest(wikitext, target) {
    return single(parseQueueSections(wikitext)
        .filter(s => s.headingLine === target.headingLine && s.requestLine === target.requestLine));
}

function single(candidates) {
    if (candidates.length === 0) return { error: 'missing' };
    if (candidates.length > 1) return { error: 'ambiguous' };
    return { section: candidates[0] };
}

/** 見出しが「Bot:」で始まるか（異議のある節は「Bot:」が外される） */
function isBotHeading(heading) {
    return /^Bot\s*[:：]/i.test(normalizeSpaces(heading));
}

/** 節に付いている着手の印の ID（無ければ null） */
function startedId(section) {
    return scanBotreq(section.body).marks[0] || null;
}

/**
 * 他の誰かが対応済み（または対応中）か
 * 着手の印（{{BOTREQ|着手}} (ID: …)）以外の {{BOTREQ}} があれば対応済みとする。
 * 印の ID が本当にこの Bot のものか（再開してよいか）は、呼び出し側が手元の記録で確かめる
 */
function isHandled(section) {
    const { botreqs, marks } = scanBotreq(section.body);
    return botreqs > marks.length;
}

/**
 * 本文の {{BOTREQ}} を数え、着手の印（{{BOTREQ|着手}} の直後に「 (ID: …)」が続くもの）の ID を集める。
 * parse2 で解析するので、コメントや <nowiki> の中に写された印は数えない
 * @param {string} body
 * @returns {{botreqs: number, marks: string[]}}
 */
function scanBotreq(body) {
    const templates = parser.parse(body, { templates: true }).templates
        .filter(t => t.type === 'template' && t.name.toLowerCase() === 'template:botreq');
    const marks = [];
    const replies = [];
    for (const t of templates) {
        const m = MARK_ID_AFTER.exec(body.slice(t.position.end));
        if (!m) continue;
        const status = (t.args['1'] || '').trim();
        if (status === '着手') marks.push(m[1]);
        else replies.push({ status, id: m[1] });
    }
    return { botreqs: templates.length, marks, replies };
}

/**
 * Bot が節に付けた結果の返信（「{{BOTREQ|完了}} (ID: …)」など、着手以外で ID の付いたもの）
 * @returns {{status: string, id: string}[]}
 */
function idReplies(section) {
    return scanBotreq(section.body).replies;
}

function normalizeSpaces(s) {
    return String(s).replace(/&nbsp;|&#160;|&#xa0;| /gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 見出しをコマンドとして解釈する
 * @param {string} heading
 * @returns {{ok: true, command: {type: string, from: string, to: string[], namespaces: number[]|null, linkNamespaces: number[], scope: string|null}} | {ok: false, error: string}}
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
        const link = takeLink();
        if (!link) return { ok: false, error: '移動先のカテゴリへのリンク（[[:Category:…]]）が見つかりません' };
        links.push(link);
        to.push(link.name);
        // 複数の移動先（「…と…へ」）と複製（「…に複製」）は受け付けない
        if (rest.startsWith('と')) return { ok: false, error: '移動先は1つだけ指定してください（「[[:Category:…]]と[[:Category:…]]へ」の構文は受け付けていません）' };
        if (rest.startsWith('に複製')) return { ok: false, error: '複製（「[[:Category:…]]に複製」）は受け付けていません' };
        if (!takeWord('へ')) return { ok: false, error: '末尾が「へ」「を除去」のいずれでもありません' };
        type = 'reassign';
    }
    if (rest !== '') return { ok: false, error: `コマンドの後ろに余分な文字列があります（${rest}）` };
    if (links.some(l => !l.colon)) {
        return { ok: false, error: 'カテゴリへのリンクは先頭にコロンを付けて [[:Category:…]] と書いてください' };
    }
    if (!from.name || to.some(t => !t)) return { ok: false, error: 'カテゴリ名が空です' };
    if (to.includes(from.name)) return { ok: false, error: '移動元と移動先が同じカテゴリです' };

    const namespaces = scope ? NAMESPACES_BY_SCOPE[scope] : DEFAULT_NAMESPACES;
    // 除去では移動先が無いので、リンクは書き換えない
    const linkNamespaces = type === 'remove' ? [] : scope ? LINK_NAMESPACES_BY_SCOPE[scope] : DEFAULT_LINK_NAMESPACES;
    return { ok: true, command: { type, from: from.name, to, namespaces: namespaces && [...namespaces], linkNamespaces: [...linkNamespaces], scope } };
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
 * 節（最新の本文で探し直したもの）の末尾に返信を挿入した本文を返す
 * @param {string} wikitext
 * @param {{end: number}} section findById / findByRequest で wikitext から見つけた節
 * @param {string} reply
 */
function insertReply(wikitext, section, reply) {
    const before = wikitext.slice(0, section.end).replace(/\s+$/, '');
    const after = wikitext.slice(section.end);
    return `${before}\n${reply}\n${after ? `\n${after}` : ''}`;
}

module.exports = {
    DEFAULT_NAMESPACES,
    includesNamespace,
    parseQueueSections,
    isBotHeading,
    isHandled,
    parseCommandHeading,
    findDiscussionLink,
    findById,
    findByRequest,
    startedId,
    idReplies,
    startMark,
    insertReply,
};
