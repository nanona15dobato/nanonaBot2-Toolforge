const test = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../src/utils/categoryQueue/queue');
const { applyCategoryCommand, transformList } = require('../src/utils/categoryQueue/replacer');
const { editSummary, formatReply } = require('../src/utils/categoryQueue/report');
const { signatureUser } = require('../src/utils/categoryQueue/requester');

const apply = (text, type, from, to = []) => applyCategoryCommand(text, { type, from, to });

// ==========================================
// コマンドの解釈
// ==========================================
test('再配属・除去の見出しを解釈する', () => {
    const cases = [
        ['Bot: [[:Category:Name1]]を[[:Category:Name2]]へ', 'reassign', 'Name1', ['Name2'], [0, 10, 14]],
        ['Bot: (記事) [[:Category:Name1]]を[[:Category:Name2]]へ', 'reassign', 'Name1', ['Name2'], [0]],
        ['Bot:&nbsp;(カテゴリ) [[:Category:Name1]]を[[:Category:Name2]]へ', 'reassign', 'Name1', ['Name2'], [14]],
        ['Bot: [[:Category:Name1]]を除去', 'remove', 'Name1', [], [0, 10, 14]],
        ['Bot: [[:Category:日本の_橋]] を [[:カテゴリ:日本の橋梁|橋梁]] へ', 'reassign', '日本の 橋', ['日本の橋梁'], [0, 10, 14]],
    ];
    for (const [heading, type, from, to, namespaces] of cases) {
        const r = queue.parseCommandHeading(heading);
        assert.ok(r.ok, `${heading}: ${r.error}`);
        assert.equal(r.command.type, type);
        assert.equal(r.command.from, from);
        assert.deepEqual(r.command.to, to);
        assert.deepEqual(r.command.namespaces, namespaces);
    }
});

test('不正な見出しは理由つきで不受理にする', () => {
    for (const heading of [
        'Bot: [[Category:Name1]]を[[:Category:Name2]]へ',      // コロンなし
        'Bot: [[:Category:Name1]]を[[:Category:Name2]]',       // 末尾なし
        'Bot: [[:Category:Name1]]を[[:Category:Name1]]へ',      // 同じ
        'Bot: [[:Category:A]]を[[:Category:B]]へ お願いします',
    ]) {
        const r = queue.parseCommandHeading(heading);
        assert.equal(r.ok, false, heading);
        assert.ok(r.error);
    }
});

test('複数の移動先と複製の構文は受け付けない', () => {
    const multi = queue.parseCommandHeading('Bot: [[:Category:Name1]]を[[:Category:Name2]]と[[:Category:Name3]]へ');
    assert.equal(multi.ok, false);
    assert.match(multi.error, /移動先は1つだけ/);
    const dup = queue.parseCommandHeading('Bot: [[:Category:Name1]]を[[:Category:Name2]]に複製');
    assert.equal(dup.ok, false);
    assert.match(dup.error, /複製/);
    assert.equal(queue.parseCommandHeading('Bot: (記事) [[:Category:Name1]]を[[:Category:Name2]]に複製').ok, false);
});

test('キューページの節を読み、処理済みと異議ありを見分ける', () => {
    const page = [
        '{{/導入文}}',
        '<!-- == Bot: [[:Category:X]]を除去 == -->',
        '== Bot: [[:Category:A]]を[[:Category:B]]へ ==',
        '[[プロジェクト:カテゴリ関連/議論/2026年/10月1日#A|議論]]を参照。--[[利用者:Ex|Ex]]（[[利用者‐会話:Ex|会話]]）',
        '=== 小見出し ===',
        '本文',
        '== Bot: [[:Category:C]]を除去 ==',
        '[[利用者:Ex|Ex]] 議論は[[プロジェクト:カテゴリ関連/議論/2026年/10月2日#C]]',
        ':{{BOTREQ|完了}} --署名',
        '== [[:Category:D]]を[[:Category:E]]へ ==',
        '異議あり',
    ].join('\n');
    const sections = queue.parseQueueSections(page);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].heading, 'Bot: [[:Category:A]]を[[:Category:B]]へ');
    assert.ok(sections[0].body.includes('小見出し'));
    assert.equal(queue.findDiscussionLink(sections[0].body), 'プロジェクト:カテゴリ関連/議論/2026年/10月1日#A');
    assert.equal(queue.findDiscussionLink(sections[1].body), 'プロジェクト:カテゴリ関連/議論/2026年/10月2日#C');
    assert.deepEqual(sections.map(s => queue.isHandled(s)), [false, true, false]);
    assert.deepEqual(sections.map(s => queue.isBotHeading(s.heading)), [true, true, false]);

    const replied = queue.insertReply(page, sections[0], ':{{BOTREQ|完了}} 返信');
    assert.ok(replied.includes('本文\n:{{BOTREQ|完了}} 返信\n\n== Bot: [[:Category:C]]を除去 =='));
});

// ==========================================
// カテゴリタグ
// ==========================================
test('カテゴリタグを再配属し、ソートキーを引き継ぐ', () => {
    const r = apply('本文\n[[Category:Name1|あ]]\n[[Category:Other]]\n', 'reassign', 'Name1', ['Name2']);
    assert.equal(r.text, '本文\n[[Category:Name2|あ]]\n[[Category:Other]]\n');
    assert.ok(r.changed);
});

test('表記ゆれ（先頭小文字・_・カテゴリ:）も対象にし、別名のカテゴリは触らない', () => {
    const text = '[[category:name_1]]\n[[カテゴリ: Name  1 ]]\n[[Category:Name 10]]\n[[:Category:Name 1]]';
    const r = apply(text, 'remove', 'Name 1');
    assert.equal(r.text, '[[Category:Name 10]]\n[[:Category:Name 1]]');
});

test('移動先が既にある・移動元のタグが重複している', () => {
    assert.equal(
        apply('[[Category:Name1]]\n[[Category:Name2]]\n', 'reassign', 'Name1', ['Name2']).text,
        '[[Category:Name2]]\n');
    assert.equal(
        apply('[[Category:Name1]][[Category:Name1|x]]', 'reassign', 'Name1', ['Name2']).text,
        '[[Category:Name2]]');
});

test('コメントとnowikiの中は書き換えない', () => {
    const text = '<!--[[Category:Name1]]-->\n<nowiki>[[Category:Name1]]</nowiki>\n[[Category:Name1]]';
    assert.equal(apply(text, 'remove', 'Name1').text, '<!--[[Category:Name1]]-->\n<nowiki>[[Category:Name1]]</nowiki>');
});

test('テンプレート引数の中のカテゴリタグも書き換える', () => {
    const r = apply('{{Infobox|x=[[Category:Name1]]}}', 'reassign', 'Name1', ['Name2']);
    assert.equal(r.text, '{{Infobox|x=[[Category:Name2]]}}');
});

test('直接の指定が無ければ変更なし', () => {
    const r = apply('{{Name1を付けるテンプレート}}', 'reassign', 'Name1', ['Name2']);
    assert.equal(r.changed, false);
});

// ==========================================
// {{リダイレクトの所属カテゴリ}}
// ==========================================
test('リダイレクトの所属カテゴリ: 名前付き引数の再配属・除去・詰め直し', () => {
    const text = [
        '{{リダイレクトの所属カテゴリ',
        '|redirect1 = あ',
        '|1-1 = Name1',
        '|1-2 = Other',
        '|redirect2 = い',
        '|2-1 = Name1',
        '}}',
    ].join('\n');
    assert.equal(apply(text, 'reassign', 'Category:Name1', ['Category:Name2']).text, text.replace(/= Name1/g, '= Name2'));

    const removed = apply(text, 'remove', 'Name1');
    assert.equal(removed.text, [
        '{{リダイレクトの所属カテゴリ',
        '|redirect1 = あ',
        '|1-1 = Other',
        '|redirect2 = い',
        '}}',
    ].join('\n'));
    assert.ok(removed.warnings.some(w => w.includes('redirect2')));
});

test('リダイレクトの所属カテゴリ: 位置引数、全カテゴリ除去で呼び出しごと削除', () => {
    assert.equal(
        apply('{{リダイレクトの所属カテゴリ|Name1|Other}}', 'reassign', 'Name1', ['Name2']).text,
        '{{リダイレクトの所属カテゴリ|Name2|Other}}');
    assert.equal(
        apply('本文\n{{リダイレクトの所属カテゴリ|redirect1=あ|1-1=Name1}}\n[[Category:X]]', 'remove', 'Name1').text,
        '本文\n[[Category:X]]');
    assert.equal(
        apply('{{リダイレクトの所属カテゴリ|redirect1=あ|1-1=Other}}', 'remove', 'Name1').changed,
        false);
});

// ==========================================
// {{画像提供依頼}}
// ==========================================
test('画像提供依頼の cat 引数を付け替える', () => {
    const text = '{{画像提供依頼|建物の写真|cat=東京都|cat2=日本の橋|date=2026年10月}}';
    assert.equal(
        apply(text, 'reassign', '東京都の画像提供依頼', ['東京都区部の画像提供依頼']).text,
        '{{画像提供依頼|建物の写真|cat=東京都区部|cat2=日本の橋|date=2026年10月}}');
    assert.equal(
        apply(text, 'remove', '東京都の画像提供依頼').text,
        '{{画像提供依頼|建物の写真|cat=日本の橋|date=2026年10月}}');
    assert.equal(apply(text, 'reassign', '大阪府の画像提供依頼', ['京都府の画像提供依頼']).changed, false);
});

test('transformList', () => {
    const op = (type, to = []) => ({ type, from: 'A', to });
    assert.deepEqual(transformList(['X', 'A', 'Y'], op('reassign', ['B'])), ['X', 'B', 'Y']);
    assert.deepEqual(transformList(['X', 'A', 'B'], op('reassign', ['B'])), ['X', 'B']);
    assert.deepEqual(transformList(['A', 'Y', 'a'], op('remove')), ['Y']);
    assert.equal(transformList(['X'], op('remove')), null);
});

// ==========================================
// 返信・要約
// ==========================================
test('編集要約と返信', () => {
    assert.equal(
        editSummary({ type: 'reassign', from: 'A', to: ['B'] }, 'PJ:議論#A', 'ID1'),
        'Bot: [[:Category:A]]から[[:Category:B]]へ変更 ([[PJ:議論#A|議論場所]]) (ID: ID1)');
    assert.equal(
        editSummary({ type: 'remove', from: 'A', to: [] }, 'PJ:議論#A', 'ID1'),
        'Bot: [[:Category:A]]を除去 ([[PJ:議論#A|議論場所]]) (ID: ID1)');
    // 返信は1行。ページの一覧や理由は Web の詳細ページに載せる
    assert.equal(
        formatReply({ status: '完了', id: 'ID1', counts: { edited: 2, unchanged: 1, warnings: 0, errors: 1 }, notes: ['[[:Category:A]]は空になりました。'] }),
        ':{{BOTREQ|完了}} (ID: ID1) 2件を編集しました（変更なし1件・エラー1件）。 [[:Category:A]]は空になりました。 ' +
        '詳細は[https://nanonabot2-01.toolforge.org/queue/ID1 処理結果]を参照してください。 --~~~~');
    assert.equal(
        formatReply({ status: '完了', id: 'ID4', counts: { edited: 2, unchanged: 0, skipped: 1, warnings: 0, errors: 0 } }),
        ':{{BOTREQ|完了}} (ID: ID4) 2件を編集しました（スキップ1件）。 詳細は[https://nanonabot2-01.toolforge.org/queue/ID4 処理結果]を参照してください。 --~~~~');
    assert.equal(
        formatReply({ status: '完了', id: 'ID2', counts: { edited: 3, unchanged: 0, warnings: 0, errors: 0 } }),
        ':{{BOTREQ|完了}} (ID: ID2) 3件を編集しました。 詳細は[https://nanonabot2-01.toolforge.org/queue/ID2 処理結果]を参照してください。 --~~~~');
    assert.equal(
        formatReply({ status: '不受理', id: 'ID3', message: '議論場所へのリンクがありません' }),
        ':{{BOTREQ|不受理}} (ID: ID3) 議論場所へのリンクがありません。 詳細は[https://nanonabot2-01.toolforge.org/queue/ID3 処理結果]を参照してください。 --~~~~');
});

// ==========================================
// 実行状況（Web表示用）
// ==========================================
test('実行状況の書き出しと二重起動の防止', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { QueueStatus } = require('../src/utils/categoryQueue/status');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-status-'));
    try {
        const st = new QueueStatus(dir, 'normal');
        assert.equal(st.acquireLock(), true);
        assert.equal(new QueueStatus(dir, 'normal').acquireLock(), false);

        st.setSections([{ heading: 'Bot: A' }, { heading: 'Bot: B' }]);
        st.sectionStart(0);
        st.commandStart({ id: 'ID1', command: { type: 'remove', from: 'A', to: [], namespaces: [0] }, discussionLink: 'L', total: 2 });
        st.pageStart('p1');
        let saved = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
        assert.equal(saved.state, 'running');
        assert.equal(saved.current.currentTitle, 'p1');
        assert.equal(saved.sections[0].state, 'running');

        st.pageDone({ title: 'p1', result: 'edited', revid: 10 });
        st.pageDone({ title: 'p2', result: 'error', message: 'x' });
        saved = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
        assert.deepEqual([saved.current.done, saved.current.edited, saved.current.errors], [2, 1, 1]);
        assert.deepEqual(saved.events.map(e => e.title), ['p2', 'p1']);

        st.sectionEnd(0, { status: '完了', id: 'ID1', message: 'm' }, { id: 'ID1', status: '完了' });
        st.finish('完了');
        st.releaseLock();
        saved = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
        assert.equal(saved.state, 'idle');
        assert.equal(saved.current, null);
        assert.equal(saved.sections[0].status, '完了');
        const history = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(history[0].id, 'ID1');
        assert.ok(history[0].finishedAt);
        assert.equal(new QueueStatus(dir, 'normal').acquireLock(), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ==========================================
// 依頼者の特定
// ==========================================
test('署名の利用者を取り出す（会話ページへのリンクは飛ばす）', () => {
    assert.equal(signatureUser('議論は[[PJ:議論]]。--[[利用者‐会話:Bob|会話]] [[利用者:Alice_b|Alice]] 2026年'), 'Alice b');
    assert.equal(signatureUser('[[User:alice/sub|x]]'), 'Alice');
    assert.equal(signatureUser('署名なし'), null);
});

// ==========================================
// コマンドごとの記録（Web の詳細ページ用）
// ==========================================
test('コマンドの記録と読み出し', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { CommandRecord, readCommandRecord } = require('../src/utils/categoryQueue/record');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-record-'));
    try {
        const id = '20261014000000-abcdef';
        const rec = new CommandRecord(dir, id, { heading: 'Bot: A' }, { dryRun: false });
        rec.setRequest({ requester: 'Alice', signer: 'Bob', signerMatches: false, requestedAt: '2026-10-13T00:00:00Z', revid: 4, traced: true });
        rec.setCommand({ type: 'remove', from: 'A', to: [], namespaces: [0] }, 'PJ:議論', 2);
        rec.log('info', '開始');
        rec.page({ title: 'p1', result: 'edited', revid: 10, warnings: ['w'] });
        rec.page({ title: 'p2', result: 'error', message: 'x' });
        rec.finish({ status: '完了', notes: ['n'] });

        const { record, pages } = readCommandRecord(dir, id);
        assert.equal(record.state, 'done');
        assert.equal(record.status, '完了');
        assert.deepEqual(record.counts, { edited: 1, unchanged: 0, skipped: 0, warnings: 1, errors: 1 });
        assert.equal(record.request.requester, 'Alice');
        assert.deepEqual(record.log.map(l => l.message), ['開始']);
        assert.deepEqual(pages.map(p => p.title), ['p1', 'p2']);
        assert.ok(!('log' in rec.summary()));
        // ID の形でないものはファイルを開かない
        assert.equal(readCommandRecord(dir, '../status'), null);
        assert.equal(readCommandRecord(dir, '20261014000000-000000'), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ==========================================
// 動かすウィキ（--site）
// ==========================================
test('--site: 試験用のウィキを選び、認証情報はウィキごとの環境変数から読む', () => {
    const { resolveSite, siteCredentials, TEST_DATA_DIRS } = require('../src/utils/categoryQueue/sites');
    const ja = resolveSite([]);
    assert.equal(ja.name, 'ja');
    assert.equal(ja.search, 'backlinks');
    assert.equal(resolveSite(['--site', 'test']).search, 'embeddedin');
    const ptw = resolveSite(['--site', 'ptw', '--dry-run']);
    assert.equal(new URL(ptw.apiUrl).hostname, 'publictestwiki.com');
    assert.equal(ptw.search, 'embeddedin');
    assert.equal(ptw.assertBot, false);
    assert.equal(resolveSite(['--site', 'ptw', '--queue-page', 'User:A/Q']).queuePage, 'User:A/Q');
    assert.throws(() => resolveSite(['--site', 'nope']));

    const env = { MW_NBOT2_USERNAME: 'Bot2', MW_NBOT2_PASSWORD: 'p2', MW_USERNAME: 'U', MW_PASSWORD: 'p' };
    assert.deepEqual(siteCredentials(ja, env), { username: 'Bot2', password: 'p2' });
    assert.deepEqual(siteCredentials(ja, { MW_USERNAME: 'U', MW_PASSWORD: 'p' }), { username: 'U', password: 'p' });
    // publictestwiki は Wikimedia とアカウントが別なので、Wikimedia の認証情報を使わない
    assert.deepEqual(siteCredentials(ptw, env), { username: undefined, password: undefined });
    assert.deepEqual(siteCredentials(ptw, { ...env, MW_PTW_USERNAME: 'Me@bot', MW_PTW_PASSWORD: 'x' }), { username: 'Me@bot', password: 'x' });
    assert.deepEqual(TEST_DATA_DIRS, ['data/category-queue-test', 'data/category-queue-ptw']);
});

test('{{リダイレクトの所属カテゴリ}}: 21件目以降（モジュール化後）を含むグループも書き換える', () => {
    const args = Array.from({ length: 25 }, (_, i) => `|1-${i + 1}=C${i + 1}`).join('\n');
    const text = `{{リダイレクトの所属カテゴリ\n|redirect1=R\n${args}\n}}`;
    const moved = apply(text, 'reassign', 'C23', ['新']);
    assert.equal(moved.changed, true);
    assert.deepEqual(moved.warnings, []);
    assert.match(moved.text, /\|1-23=新\n/);
    const removed = apply(text, 'remove', 'C3');
    assert.match(removed.text, /\|1-3=C4\n/);
    assert.match(removed.text, /\|1-24=C25\n\}\}/);
    assert.doesNotMatch(removed.text, /1-25/);
});
