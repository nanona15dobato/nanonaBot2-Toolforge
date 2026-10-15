// PR #39 のレビューで直した点のテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const queue = require('../src/utils/categoryQueue/queue');
const { formatStart } = require('../src/utils/categoryQueue/report');
const { applyCategoryCommand } = require('../src/utils/categoryQueue/replacer');
const { CommandRecord, readCommandRecord, reopenCommandRecord, listCommandRecords, updateCommandRecord, SkipIndex } = require('../src/utils/categoryQueue/record');
const { QueueStatus } = require('../src/utils/categoryQueue/status');

const ID = '20261014000000-abcdef';
const SIG = '--[[利用者:A|A]] 2026年10月1日 (水) 00:00 (UTC)';
const HEADING = '== Bot: [[:Category:Name1]]を除去 ==';
const section = body => queue.parseQueueSections(`${HEADING}\n${body}\n`)[0];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cq-review-'));

test('コメント・nowiki の中に写された着手の印は本物とみなさない', () => {
    const mark = formatStart(ID);
    for (const body of [`依頼 ${SIG}\n<!-- ${mark} -->`, `依頼 ${SIG}\n<nowiki>${mark}</nowiki>`]) {
        const s = section(body);
        assert.equal(queue.startedId(s), null, body);
        assert.equal(queue.isHandled(s), false, body);
        assert.equal(queue.findById(`${HEADING}\n${body}\n`, ID).error, 'missing', body);
    }
    // 本物の印は見つける。{{BOTREQ|着手}} の直後に ID が無いもの（人の作業者の着手）は印ではない
    assert.equal(queue.startedId(section(`依頼 ${SIG}\n${mark}`)), ID);
    const human = section(`依頼 ${SIG}\n:{{BOTREQ|着手}} 私がやります`);
    assert.equal(queue.startedId(human), null);
    assert.equal(queue.isHandled(human), true);
});

test('画像提供依頼: cat 引数で表せない移動先なら、除去にせず書き換えない（要確認）', () => {
    const text = '{{画像提供依頼|写真|cat=東京都|date=2026年10月}}';
    const r = applyCategoryCommand(text, { type: 'reassign', from: '東京都の画像提供依頼', to: ['日本の行政区画'] });
    assert.equal(r.changed, false);
    assert.equal(r.text, text);
    assert.equal(r.warnings.length, 1);
});

test('記録を開き直すとき、件数はページの結果から数え直す', () => {
    const dir = tmp();
    try {
        const rec = new CommandRecord(dir, ID, { heading: 'Bot: A' }, { dryRun: false });
        rec.page({ title: 'p1', result: 'edited', warnings: ['w'] });
        rec.page({ title: 'p2', result: 'error', message: 'x' });
        // ページごとに概要も書き出している
        assert.deepEqual(readCommandRecord(dir, ID).record.counts, { edited: 1, unchanged: 0, skipped: 0, warnings: 1, errors: 1 });

        // 概要を書く前に落ちた場合を模す（ページの結果だけ1件多い）
        fs.appendFileSync(path.join(dir, 'commands', `${ID}.pages.jsonl`), JSON.stringify({ title: 'p3', result: 'unchanged' }) + '\n');
        fs.appendFileSync(path.join(dir, 'commands', `${ID}.pages.jsonl`), JSON.stringify({ title: 'p4', result: 'skipped', message: 'nobots' }) + '\n');
        const reopened = reopenCommandRecord(dir, ID, { dryRun: false });
        // {{nobots}} はエラーではなくスキップとして数える
        assert.deepEqual(reopened.data.counts, { edited: 1, unchanged: 1, skipped: 1, warnings: 1, errors: 1 });
        reopened.page({ title: 'p5', result: 'skipped' });
        assert.equal(reopened.data.counts.skipped, 2);
        assert.equal(reopened.data.state, 'running');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('実行中の印を他の実行に取られたら、更新も削除もしない', () => {
    const dir = tmp();
    try {
        const first = new QueueStatus(dir, 'normal');
        assert.equal(first.acquireLock(), true);
        assert.equal(first.ownsLock(), true);

        // 印が古いとみなされて、別の実行が取り直した
        fs.rmSync(path.join(dir, 'run.lock'), { recursive: true, force: true });
        const second = new QueueStatus(dir, 'normal');
        assert.equal(second.acquireLock(), true);

        assert.equal(first.lockLost(), true);
        first.save(); // 新しい持ち主の実行状況を上書きしない
        assert.equal(fs.existsSync(path.join(dir, 'status.json')), false);
        first.releaseLock(); // 新しい持ち主の印を消さない
        assert.equal(second.ownsLock(), true);
        assert.equal(new QueueStatus(dir, 'normal').acquireLock(), false);

        second.releaseLock();
        assert.equal(new QueueStatus(dir, 'normal').acquireLock(), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('履歴は終わったコマンドだけを書く（緊急停止で中断したものは書かない）', () => {
    const dir = tmp();
    try {
        const st = new QueueStatus(dir, 'normal');
        st.acquireLock();
        st.setSections([{ heading: 'A' }, { heading: 'B' }]);
        st.sectionEnd(0, { stopped: true, id: 'X' }, { id: 'X', state: 'stopped' });
        st.sectionEnd(1, { status: '完了', id: 'Y' }, { id: 'Y', state: 'done', status: '完了' });
        const lines = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(lines.map(l => l.id), ['Y']);
        st.releaseLock();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('古い印の取り直し: 他の実行が先に取り直した新しい印は消さない', () => {
    const dir = tmp();
    const lockDir = path.join(dir, 'run.lock');
    const makeStale = owner => {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner'), owner);
        const old = new Date(Date.now() - 60 * 60 * 1000);
        fs.utimesSync(lockDir, old, old);
    };
    try {
        // 古い印は取り直せる
        makeStale('OLD');
        const c = new QueueStatus(dir, 'normal');
        assert.equal(c.acquireLock(), true);
        assert.equal(c.ownsLock(), true);
        c.releaseLock();

        // A と B が同じ古い印（札 OLD）を見た。B が先に取り直して新しい印を作った後で、A が片付けようとする
        makeStale('OLD');
        const a = new QueueStatus(dir, 'normal');
        const b = new QueueStatus(dir, 'normal');
        const observedByA = a.readLockOwner(lockDir);
        assert.equal(b.acquireLock(), true);
        assert.equal(a.reclaimStaleLock(observedByA), false); // B の印を移しても札が違うので元に戻す
        assert.equal(b.ownsLock(), true);
        assert.equal(b.lockLost(), false);
        assert.equal(a.acquireLock(), false); // B の印は新しいので取れない
        assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.stale-')), []); // 移した跡も残らない
        b.releaseLock();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('連続する行のカテゴリタグ・テンプレートを消しても、範囲の重なりで失敗しない', () => {
    const remove = text => applyCategoryCommand(text, { type: 'remove', from: 'A', to: [] }).text;
    assert.equal(remove('[[Category:A]]\n[[Category:A]]'), '');
    assert.equal(remove('x\n[[Category:A]]\n[[Category:A|k]]'), 'x\n');
    assert.equal(remove('[[Category:A]]\n[[Category:Z]]\n[[Category:A]]'), '[[Category:Z]]');
    assert.equal(remove('{{リダイレクトの所属カテゴリ|1-1=A}}\n{{リダイレクトの所属カテゴリ|1-1=A}}'), '');
    // 再配属（最初のタグは置き換え、残りは消す）も同じ
    assert.equal(applyCategoryCommand('[[Category:A]]\n[[Category:A]]', { type: 'reassign', from: 'A', to: ['B'] }).text, '[[Category:B]]');
});

test('結果の返信（ID 付き）を見分ける。人の返信やコメント内のものは数えない', () => {
    const body = [
        `依頼 ${SIG}`,
        formatStart(ID),
        `:{{BOTREQ|完了}} (ID: ${ID}) 3件を編集しました。 --[[利用者:NanonaBot2|NanonaBot2]]`,
        ':{{BOTREQ|完了}} 手作業で対応 --[[利用者:Other|Other]]',
        `<!-- :{{BOTREQ|中止}} (ID: 20261014999999-000000) -->`,
    ].join('\n');
    const s = section(body);
    assert.deepEqual(queue.idReplies(s), [{ status: '完了', id: ID }]);
    assert.equal(queue.startedId(s), ID);
    assert.equal(queue.isHandled(s), true);
});

test('見送りの記録: 見出し行と依頼文が同じ節を同じものとみなし、無くなった節の分は消す', () => {
    const dir = tmp();
    try {
        const a = section(`依頼A ${SIG}`);
        const b = section(`依頼B ${SIG}`);
        const skips = new SkipIndex(dir);
        skips.set(a, ID);
        // 返信が付いても依頼文（本文の最初の行）は変わらない
        assert.equal(new SkipIndex(dir).get(section(`依頼A ${SIG}
:返信`)), ID);
        assert.equal(new SkipIndex(dir).get(b), null);
        const reread = new SkipIndex(dir);
        reread.prune([b]);
        assert.equal(new SkipIndex(dir).get(a), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('記録の一覧は概要だけを読み、壊れたファイルを飛ばす。概要に注意書きを足せる', () => {
    const dir = tmp();
    try {
        const rec = new CommandRecord(dir, ID, { heading: 'Bot: A' }, { dryRun: false, queuePage: 'Q' });
        rec.page({ title: 'p1', result: 'edited' });
        fs.writeFileSync(path.join(dir, 'commands', '20261014000000-000000.json'), '{壊れた');
        const list = listCommandRecords(dir);
        assert.deepEqual(list.map(r => [r.id, r.queuePage]), [[ID, 'Q']]);
        updateCommandRecord(dir, ID, r => { r.orphanNotifiedAt = 'x'; });
        assert.equal(readCommandRecord(dir, ID).record.orphanNotifiedAt, 'x');
        // 再開したら（節が戻された）、また知らせられるよう印を消す
        assert.equal(reopenCommandRecord(dir, ID, { dryRun: false }).data.orphanNotifiedAt, null);
        assert.deepEqual(listCommandRecords(path.join(dir, 'none')), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
