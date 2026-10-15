/**
 * カテゴリキュー: 依頼者・依頼日時の特定
 *
 * 署名はただの文字列なので、他人の名前でも書ける。そこでキューページの版の履歴から、
 * その節（見出し行と本文の最初の行が同じもの。queue.findByRequest）を最初に書き込んだ版
 * （＝実際の依頼者と依頼日時）を探し、署名の利用者と比べる。
 * 他の節の追加・過去ログ化で節の位置や数が変わっても影響しない。
 * 見出しが後から他人に書き換えられた場合は、書き換えた人が「見出しを書き込んだ人」になる
 * （実行されるのは書き換え後の見出しなので、責任の所在としてはそれが正しい）。
 */
const WikitextParser = require('../parse2');
const { findByRequest } = require('./queue');

const parser = new WikitextParser();
const USER_LINK = /^(?:user|利用者)\s*:\s*([^/#]+)/i;
const REVISIONS_PER_REQUEST = 50;
const MAX_REVISIONS = 500;

/** 利用者名の表記ゆれ（_ と空白、先頭文字）をそろえる */
function normalizeUser(name) {
    const s = String(name ?? '').replace(/[_\s]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * 節の本文から、最初の署名の利用者名を取り出す（利用者ページへの最初のリンク）
 * @param {string} body
 * @returns {string|null}
 */
function signatureUser(body) {
    for (const link of parser.parse(body, { wikilinks: true }).wikilinks) {
        const m = USER_LINK.exec(link.target);
        if (m) return normalizeUser(m[1]);
    }
    return null;
}

/** その版の本文に、対象の節（見出し行も同じもの）があるか */
function hasSection(content, section) {
    return findByRequest(content, section).error !== 'missing';
}

/**
 * 新しい順の版の並びから、節を書き込んだ版を探す
 * @param {{revid: number, user?: string, userhidden?: boolean, timestamp: string, content?: string}[]} revisions 新しい順
 * @param {(content: string) => boolean} isPresent その版に節があるか
 * @param {boolean} [reachedFirst] revisions の最後がページの最初の版か（そうなら、最初の版で書き込まれたとみなせる）
 * @returns {{found: boolean, revision: object|null}} found=false は、渡した版の範囲では最初の版を特定できなかった
 */
function findIntroducingRevision(revisions, isPresent, reachedFirst = false) {
    let introducing = null;
    for (const rev of revisions) {
        if (typeof rev.content !== 'string') return { found: false, revision: introducing }; // 本文が見られない版（削除など）より前はたどれない
        if (!isPresent(rev.content)) {
            return { found: introducing !== null, revision: introducing };
        }
        introducing = rev;
    }
    return { found: reachedFirst && introducing !== null, revision: introducing };
}

/**
 * キューページの履歴をたどって依頼者を特定する
 * @param {import('mwn').Mwn} bot
 * @param {string} pageTitle
 * @param {{headingLine: string, requestLine: string, body: string}} section 読み込んだときの節
 * @returns {Promise<{requester: string|null, requestedAt: string|null, revid: number|null, signer: string|null, signerMatches: boolean|null, traced: boolean}>}
 */
async function identifyRequester(bot, pageTitle, section) {
    const isPresent = content => hasSection(content, section);
    const revisions = [];
    let result = { found: false, revision: null };
    let reachedFirst = false;
    for await (const res of bot.continuedQueryGen({
        action: 'query',
        prop: 'revisions',
        titles: pageTitle,
        rvprop: 'ids|user|timestamp|content',
        rvslots: 'main',
        rvlimit: REVISIONS_PER_REQUEST,
        formatversion: 2,
    })) {
        for (const rev of res.query?.pages?.[0]?.revisions || []) {
            revisions.push({ ...rev, content: rev.slots?.main?.content });
        }
        reachedFirst = !res.continue;
        result = findIntroducingRevision(revisions, isPresent, reachedFirst);
        // 見出しの無い版まで来たら、それ以上古い版は要らない
        const last = revisions[revisions.length - 1];
        if (result.found || typeof last?.content !== 'string' || !isPresent(last.content)) break;
        if (revisions.length >= MAX_REVISIONS) break;
    }

    const signer = signatureUser(section.body);
    const rev = result.found ? result.revision : null;
    const requester = rev && !rev.userhidden && rev.user ? normalizeUser(rev.user) : null;
    return {
        requester,
        requestedAt: rev ? rev.timestamp : null,
        revid: rev ? rev.revid : null,
        signer,
        signerMatches: requester && signer ? requester === signer : null,
        traced: result.found,
    };
}

module.exports = { identifyRequester, findIntroducingRevision, signatureUser, normalizeUser };
