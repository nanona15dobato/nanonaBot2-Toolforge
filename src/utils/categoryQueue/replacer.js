/**
 * カテゴリキュー: ページ本文（wikitext）のカテゴリ付け替え
 *
 * 1コマンド分の操作（再配属 / 除去）を、次の3か所に適用する。
 *   1. カテゴリタグ           [[Category:X|ソートキー]]
 *   2. {{リダイレクトの所属カテゴリ}}  |1-1 = X / |redirect2 … |2-1 = X / 位置引数 |X
 *   3. {{画像提供依頼}} など    |cat = X（カテゴリ「Xの画像提供依頼」を作るテンプレート）
 *
 * 構文の解析は parse2（utils/parse2.js）に任せる。コメント・<nowiki> などの中は parse2 が対象にしない。
 * テンプレート経由でしかカテゴリに入っていないページは「変更なし」になる（呼び出し側で要確認として報告する）。
 */
const WikitextParser = require('../parse2');
const { bareCategoryName } = require('./title');

const REDIRECT_CATEGORY_TEMPLATES = ['リダイレクトの所属カテゴリ'];
const IMAGE_REQUEST_TEMPLATES = ['画像提供依頼', '画像募集中', '画像改訂依頼'];
const IMAGE_REQUEST_SUFFIX = 'の画像提供依頼';

const parser = new WikitextParser();
/**
 * 編集をまとめて適用する。行ごと消す範囲（expandToLine）は前後の改行を含むので、連続する行を消すと
 * 範囲が重なることがある（最終行は直前の改行を含めるため）。重なった削除どうしは1つにまとめる
 */
function applyEdits(text, edits) {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const e of sorted) {
        const last = merged[merged.length - 1];
        if (last && e.start < last.end && last.replacement === '' && e.replacement === '') {
            last.end = Math.max(last.end, e.end);
            continue;
        }
        merged.push({ start: e.start, end: e.end, replacement: e.replacement });
    }
    return WikitextParser.applyEdits(text, merged);
}

/** [start, end) がその行の唯一の内容なら、改行ごと消す範囲に広げる */
function expandToLine(text, start, end) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = text.length;
    if (text.slice(lineStart, start).trim() !== '' || text.slice(end, lineEnd).trim() !== '') {
        return { start, end };
    }
    if (lineEnd < text.length) return { start: lineStart, end: lineEnd + 1 };
    // 最終行: 直前の改行を消す
    return { start: Math.max(0, lineStart - 1), end: lineEnd };
}

// ==========================================
// 値の並びの付け替え（3種類の書き換えで共通）
// ==========================================

/**
 * カテゴリ名の並びに操作を適用する
 * @param {string[]} values 現在の値（素のカテゴリ名、表記はそのまま）
 * @param {{type: string, from: string, to: string[]}} op 素のカテゴリ名で表した操作
 * @returns {string[]|null} 新しい並び。from が無ければ null
 */
function transformList(values, op) {
    const norm = values.map(bareCategoryName);
    const index = norm.indexOf(op.from);
    if (index === -1) return null;
    const missing = op.to.filter(t => !norm.includes(t));

    const kept = values.filter((_, i) => norm[i] !== op.from);
    if (op.type === 'remove') return kept;
    // reassign: 最初の from の位置に、まだ無い移動先を入れる
    const before = values.slice(0, index).filter((_, i) => norm[i] !== op.from).length;
    return [...kept.slice(0, before), ...missing, ...kept.slice(before)];
}

// ==========================================
// 1. カテゴリタグ
// ==========================================

function replaceCategoryTags(text, op) {
    const categories = parser.parse(text, { categories: true }).categories;
    const matches = categories.filter(c => bareCategoryName(c.category) === op.from);
    if (matches.length === 0) return { text, changed: false };

    const present = new Set(categories.map(c => bareCategoryName(c.category)));
    const missing = op.to.filter(t => !present.has(t));
    const edits = [];
    matches.forEach((c, i) => {
        const { start, end } = c.position;
        // ソートキーは空白だけのもの（[[Category:X| ]]）も含めてそのまま引き継ぐ
        const makeTags = () => missing.map(t => `[[Category:${t}${c.sortKeyRaw !== null ? `|${c.sortKeyRaw}` : ''}]]`);
        const atLineEnd = /^[ \t]*(?:\n|$)/.test(text.slice(end));

        if (op.type === 'reassign' && i === 0 && missing.length > 0) {
            edits.push({ start, end, replacement: makeTags().join(atLineEnd ? '\n' : '') });
            return;
        }
        edits.push({ ...expandToLine(text, start, end), replacement: '' });
    });
    if (edits.length === 0) return { text, changed: false };
    return { text: applyEdits(text, edits), changed: true };
}

// ==========================================
// テンプレート引数の書き換え
// ==========================================

function findTemplateCalls(text, names) {
    return parser.parse(text, { templates: names.map(n => `Template:${n}`) }).templates
        .filter(t => t.type === 'template');
}

/**
 * 1グループの引数（slots、並び順どおり。parse2 の argsOrdered の要素）の値を newValues に書き換える編集を作る
 * @param {string} text
 * @param {object[]} slots
 * @param {string[]} newValues
 * @param {(i: number) => string} keyFor i番目（0始まり）の引数名
 */
function rewriteSlots(text, slots, newValues, keyFor) {
    const edits = [];
    const common = Math.min(slots.length, newValues.length);
    for (let i = 0; i < common; i++) {
        const slot = slots[i];
        if (slot.value !== newValues[i]) {
            edits.push({ start: slot.valuePosition.start, end: slot.valuePosition.end, replacement: newValues[i] });
        }
        if (slot.named && slot.key !== keyFor(i)) {
            edits.push({ start: slot.keyPosition.start, end: slot.keyPosition.end, replacement: keyFor(i) });
        }
    }
    if (newValues.length > slots.length) {
        // 最後の引数と同じ書式（空白・改行）で後ろに足す
        const last = slots[slots.length - 1];
        const lead = text.slice(last.position.start, last.named ? last.keyPosition.start : last.valuePosition.start);
        const trail = text.slice(last.valuePosition.end, last.position.end);
        const mid = last.named ? text.slice(last.keyPosition.end, last.valuePosition.start) : '';
        const insert = newValues.slice(slots.length).map((v, j) => {
            const i = slots.length + j;
            return '|' + (last.named ? `${lead}${keyFor(i)}${mid}${v}${trail}` : `${lead}${v}${trail}`);
        }).join('');
        edits.push({ start: last.position.end, end: last.position.end, replacement: insert });
    }
    for (let i = newValues.length; i < slots.length; i++) {
        // position は | の直後から始まるので、| も含めて消す
        edits.push({ start: slots[i].position.start - 1, end: slots[i].position.end, replacement: '' });
    }
    return edits;
}

// ==========================================
// 2. {{リダイレクトの所属カテゴリ}}
// ==========================================

function replaceInRedirectCategoryTemplates(text, op, warnings) {
    const edits = [];
    for (const call of findTemplateCalls(text, REDIRECT_CATEGORY_TEMPLATES)) {
        // グループ: "N-M" 形式はリダイレクト番号 N ごと、位置引数（1件目の省略形）は別グループ
        const groups = new Map();
        for (const arg of call.argsOrdered) {
            let group;
            let order;
            const m = /^(\d+)-(\d+)$/.exec(arg.key);
            if (m) { group = m[1]; order = Number(m[2]); }
            else if (/^\d+$/.test(arg.key)) { group = 'positional'; order = Number(arg.key); }
            else continue;
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push({ ...arg, order });
        }

        const callEdits = [];
        let remaining = 0;
        for (const [group, slots] of groups) {
            slots.sort((a, b) => a.order - b.order);
            const filled = slots.filter(s => s.value !== '');
            const values = filled.map(s => s.value);
            const next = transformList(values, op);
            if (!next) { remaining += values.length; continue; }
            // 件数の上限は設けない。再配属・除去では件数が増えないので、21件目以降（テンプレートがモジュール化されると
            // 使えるようになる）を含むグループも、そのまま書き換えてよい
            remaining += next.length;
            if (next.length === 0 && group !== 'positional') {
                warnings.push(`{{リダイレクトの所属カテゴリ}}の redirect${group} にカテゴリが残っていません`);
            }
            const keyFor = group === 'positional' ? i => String(i + 1) : i => `${group}-${i + 1}`;
            callEdits.push(...rewriteSlots(text, filled, next, keyFor));
        }
        if (callEdits.length === 0) continue;
        if (remaining === 0) {
            // カテゴリ指定がすべて無くなったら呼び出しごと消す
            edits.push({ ...expandToLine(text, call.position.start, call.position.end), replacement: '', whole: true });
        } else {
            edits.push(...callEdits);
        }
    }
    // 呼び出しごと消すものの内側の編集（入れ子の呼び出し）は捨てる
    const wholes = edits.filter(e => e.whole);
    const kept = edits.filter(e => !wholes.some(w => w !== e && w.start <= e.start && e.end <= w.end));
    if (kept.length === 0) return { text, changed: false };
    return { text: applyEdits(text, kept), changed: true };
}

// ==========================================
// 3. {{画像提供依頼}} など
// ==========================================

function replaceInImageRequestTemplates(text, op, warnings) {
    if (!op.from.endsWith(IMAGE_REQUEST_SUFFIX)) return { text, changed: false };
    const strip = name => name.slice(0, -IMAGE_REQUEST_SUFFIX.length);
    const from = strip(op.from);
    // 「…の画像提供依頼」以外への再配属は cat 引数では表せない。移動先を落として除去にしてしまわないよう、
    // その場合はテンプレートを書き換えず、要確認として残す
    const unrepresentable = op.type === 'reassign' && op.to.some(t => !t.endsWith(IMAGE_REQUEST_SUFFIX));
    const subOp = { type: op.type, from: bareCategoryName(from), to: op.to.map(t => bareCategoryName(strip(t))) };

    const edits = [];
    for (const call of findTemplateCalls(text, IMAGE_REQUEST_TEMPLATES)) {
        const slots = call.argsOrdered
            .filter(a => /^cat\d*$/.test(a.key) && a.value !== '')
            .map(a => ({ ...a, order: a.key === 'cat' ? 1 : Number(a.key.slice(3)) }))
            .sort((a, b) => a.order - b.order);
        const next = transformList(slots.map(s => s.value), subOp);
        if (!next) continue;
        if (unrepresentable) {
            warnings.push(`画像提供依頼テンプレートの cat 引数では「…${IMAGE_REQUEST_SUFFIX}」以外のカテゴリを指定できないため、テンプレートを書き換えませんでした`);
            continue;
        }
        edits.push(...rewriteSlots(text, slots, next, i => (i === 0 ? 'cat' : `cat${i + 1}`)));
    }
    if (edits.length === 0) return { text, changed: false };
    return { text: applyEdits(text, edits), changed: true };
}

// ==========================================
// 4. カテゴリへのリンク（既定では無効。呼び出し側が replaceLinks で有効にする）
// ==========================================

// 書き換えない範囲（コメント・<nowiki> など。中の文字列は表示されるだけで、リンクにならない）
const LINK_PROTECTED = /<!--[\s\S]*?-->|<(nowiki|pre|syntaxhighlight|source|math|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 名前空間の接頭辞は大文字小文字を区別しない
const caseless = word => [...word].map(c => (c.toUpperCase() !== c.toLowerCase() ? `[${c.toUpperCase()}${c.toLowerCase()}]` : escapeRegex(c))).join('');
const CATEGORY_PREFIX_PATTERN = `(?:${caseless('category')}|カテゴリ)`;

/** カテゴリ名（先頭の1文字だけ大文字小文字を区別しない。空白と _ は同じ） */
function categoryNamePattern(name) {
    const [first, ...rest] = [...name];
    const head = first.toUpperCase() !== first.toLowerCase() ? `[${first.toUpperCase()}${first.toLowerCase()}]` : escapeRegex(first);
    return head + rest.join('').split(/[ _]+/).map(escapeRegex).join('[ _]+');
}

/**
 * 移動元のカテゴリへのリンクを移動先に書き換える（再配属のときだけ）
 *   [[:Category:A]] / [[:カテゴリ:A|表示]] / {{テンプレート|:Category:A}} / {{Catlink|Category:A}} など
 * 「(:)Category:A」の直後が ] | } # < 改行・末尾（空白を挟んでもよい）のときだけ一致させ、「A橋梁」などの別のカテゴリを書き換えない。
 * 直前が英数字・コロンのもの（[[:commons:Category:A]] などのウィキ間リンク）は、別のウィキのカテゴリなので書き換えない。
 * カテゴリのタグ（コロンなしの [[Category:A]]）は 1. で書き換え済みなので、ここに残るのはリンクと引数だけ
 */
function replaceCategoryLinks(text, op) {
    if (op.type !== 'reassign' || op.to.length !== 1) return { text, changed: false };
    const re = new RegExp(`(?<![A-Za-z0-9_:\\-])(:?[ _]*${CATEGORY_PREFIX_PATTERN}[ _]*:[ _]*)(${categoryNamePattern(op.from)})(?=[ _]*(?:[\\]|}#<\\n]|$))`, 'g');
    let out = '';
    let last = 0;
    const rewrite = segment => segment.replace(re, (_, prefix) => `${prefix}${op.to[0]}`);
    for (const m of text.matchAll(LINK_PROTECTED)) {
        out += rewrite(text.slice(last, m.index)) + m[0];
        last = m.index + m[0].length;
    }
    out += rewrite(text.slice(last));
    return { text: out, changed: out !== text };
}

// ==========================================
// まとめ
// ==========================================

/**
 * @param {string} wikitext
 * @param {{type: 'reassign'|'remove', from: string, to: string[]}} command 移動先 to は再配属で1件
 *        from/to は "Category:" の有無を問わない
 * @param {{replaceLinks?: boolean}} [options] replaceLinks: カテゴリへのリンクも書き換える（4.）
 * @returns {{text: string, changed: boolean, warnings: string[]}}
 */
function applyCategoryCommand(wikitext, command, { replaceLinks = false } = {}) {
    const op = {
        type: command.type,
        from: bareCategoryName(command.from),
        to: (command.to || []).map(bareCategoryName),
    };
    const warnings = [];
    let text = wikitext;
    let changed = false;
    // 1つ書き換えるたびに位置が変わるので、段階ごとに解析し直す
    const steps = [replaceCategoryTags, replaceInRedirectCategoryTemplates, replaceInImageRequestTemplates];
    if (replaceLinks) steps.push(replaceCategoryLinks);
    for (const step of steps) {
        const r = step(text, op, warnings);
        text = r.text;
        changed = changed || r.changed;
    }
    return { text, changed: changed && text !== wikitext, warnings: [...new Set(warnings)] };
}

module.exports = {
    applyCategoryCommand,
    transformList,
    findTemplateCalls,
    REDIRECT_CATEGORY_TEMPLATES,
    IMAGE_REQUEST_SUFFIX,
};
