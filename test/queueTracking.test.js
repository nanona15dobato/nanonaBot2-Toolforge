// 節の追跡: 着手の印「{{BOTREQ|着手}} (ID: …)」で節を探す。他の節の追加・過去ログ化・見出しの変更があっても取り違えない
const test = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../src/utils/categoryQueue/queue');
const { formatStart } = require('../src/utils/categoryQueue/report');
const { findIntroducingRevision } = require('../src/utils/categoryQueue/requester');

const SIG_A = '--[[利用者:A|A]] 2026年10月1日 (水) 00:00 (UTC)';
const SIG_B = '--[[利用者:B|B]] 2026年10月5日 (日) 00:00 (UTC)';
const HEADING = '== Bot: [[:Category:Name1]]を除去 ==';
const A = [HEADING, `[[PJ:議論#1]] ${SIG_A}`, ''].join('\n');
const B = [HEADING, `[[PJ:議論#2]] ${SIG_B}`, ''].join('\n');
const page = (...sections) => ['{{/導入文}}', ...sections].join('\n');
const ID = '20261014000000-abcdef';
// Bot が着手の返信を付けた後の節
const started = section => `${section}${formatStart(ID).replace('--~~~~', '--[[利用者:NanonaBot2|NanonaBot2]] 2026年10月14日 (火) 00:00 (UTC)')}\n`;

test('着手の返信は印の形になっている（queue と report で同じ形）', () => {
    const s = queue.parseQueueSections(page(started(B)))[0];
    assert.equal(queue.startedId(s), ID);
    assert.ok(formatStart(ID).startsWith(`:${queue.startMark(ID)} `));
    // 印だけなら対応済みではない（再開できる）。他の {{BOTREQ}} が付けば対応済み
    assert.equal(queue.isHandled(s), false);
    assert.equal(queue.isHandled(queue.parseQueueSections(page(started(B) + ':{{BOTREQ|完了}} --他の人\n'))[0]), true);
    assert.equal(queue.startedId(queue.parseQueueSections(page(B))[0]), null);
});

test('ID で探すので、同じ見出しの節の過去ログ化・追加・見出しの変更に影響されない', () => {
    // 同じ見出しの A が先に過去ログ化された
    let found = queue.findById(page(started(B)), ID);
    assert.ok(found.section.body.includes('議論#2'));
    // 前に節が追加された
    const NEW = ['== Bot: [[:Category:Name2]]を除去 ==', `新しい依頼 ${SIG_A}`, ''].join('\n');
    found = queue.findById(page(NEW, A, started(B)), ID);
    assert.ok(found.section.body.includes('議論#2'));
    // 異議で「Bot:」が外された → 同じ節が見つかり、見出しが変わったと分かる
    found = queue.findById(page(A, started(B).replace('Bot: ', '') + ':反対です\n'), ID);
    assert.notEqual(found.section.headingLine, HEADING);
    // 節が過去ログ化された → 見つからない（返信しない）
    assert.equal(queue.findById(page(A), ID).error, 'missing');
});

test('着手の前は見出し行と依頼文の両方で探す', () => {
    const loadedB = queue.parseQueueSections(page(A, B))[1];
    // 同じ見出しの A が過去ログ化されても B を見つける
    assert.ok(queue.findByRequest(page(B), loadedB).section.body.includes('議論#2'));
    // B が過去ログ化されたら、同じ見出しの A を B とみなさない
    assert.equal(queue.findByRequest(page(A), loadedB).error, 'missing');
    // 見出しが変わったら（異議など）見つからない → 着手しない
    assert.equal(queue.findByRequest(page(A, B.replace('Bot: ', '')), loadedB).error, 'missing');
    // 見出しも依頼文も同じ節が2つあれば特定できない
    assert.equal(queue.findByRequest(page(B, B), loadedB).error, 'ambiguous');
});

test('返信は節の末尾に入る', () => {
    const text = page(A, started(B));
    const found = queue.findById(text, ID);
    const replied = queue.insertReply(text, found.section, ':{{BOTREQ|完了}} 返信');
    assert.ok(replied.endsWith('(UTC)\n:{{BOTREQ|完了}} 返信\n'));
    assert.ok(replied.includes('議論#1'));
});

test('節を書き込んだ版を履歴から探す（他の節の過去ログ化に影響されない）', () => {
    const target = queue.parseQueueSections(page(B))[0];
    const has = content => queue.findByRequest(content, target).error !== 'missing';
    const revs = [ // 新しい順
        { revid: 6, user: 'Archiver', content: page(B + ':返信\n') }, // 同じ見出しの A が過去ログ化された
        { revid: 5, user: 'Replier', content: page(A, B + ':返信\n') },
        { revid: 4, user: 'Bob', content: page(A, B) },
        { revid: 3, user: 'Alice', content: page(A) },
        { revid: 2, user: 'Old', content: page(B) }, // いったん消えて再び書かれた古い版は数えない
    ];
    assert.deepEqual(findIntroducingRevision(revs, has), { found: true, revision: revs[2] });

    // さかのぼれる範囲の最初の版にも節がある場合は特定できない。ただしそれがページの最初の版なら、その版で書き込まれた
    assert.equal(findIntroducingRevision(revs.slice(0, 3), has).found, false);
    assert.deepEqual(findIntroducingRevision(revs.slice(0, 3), has, true), { found: true, revision: revs[2] });

    // 本文の見られない版（削除など）より前はたどらない
    assert.equal(findIntroducingRevision([revs[0], { revid: 4, user: 'X' }], has).found, false);
});
