/**
 * カテゴリキュー用: カテゴリ名の正規化
 */

const CATEGORY_PREFIX = /^\s*(?:category|カテゴリ)\s*:\s*/i;

/**
 * MediaWikiの表記ゆれ（_ と空白、連続空白、先頭文字の大文字小文字）を吸収した名前にする
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
    const s = String(name ?? '').replace(/[_ \s]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * "Category:X" / "カテゴリ:X" / "X" のいずれからも素のカテゴリ名を取り出す
 * @param {string} name
 * @returns {string}
 */
function bareCategoryName(name) {
    return normalizeName(String(name ?? '').replace(CATEGORY_PREFIX, ''));
}

module.exports = { normalizeName, bareCategoryName };
