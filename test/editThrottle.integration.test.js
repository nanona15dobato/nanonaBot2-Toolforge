'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

function worker(dir, priority = 'normal') {
    const child = fork(path.join(__dirname, 'helpers/editThrottleWorker.js'), [], {
        env: { ...process.env, EDIT_THROTTLE_DIR: dir, TEST_PRIORITY: priority },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const events = [];
    child.on('message', message => events.push({ ...message, received: performance.now() }));
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, events, exited };
}

async function waitFor(w, event, timeout = 12000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
        const failure = w.events.find(item => item.event === 'error');
        if (failure) throw new Error(failure.message);
        const found = w.events.find(item => item.event === event);
        if (found) return found;
        if (w.child.exitCode !== null || w.child.signalCode !== null) throw new Error(`worker exited before ${event}`);
        await sleep(25);
    }
    throw new Error(`timed out waiting for ${event}`);
}

async function stop(w) {
    if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill();
    await w.exited;
}

test('別プロセスの編集は応答終了後も5秒間待つ', { timeout: 25000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'throttle-process-'));
    const workers = [];
    try {
        const first = worker(dir); workers.push(first);
        await waitFor(first, 'started');
        const second = worker(dir); workers.push(second);
        await waitFor(second, 'ready');
        await sleep(700);
        assert.equal(second.events.some(item => item.event === 'started'), false);
        first.child.send('finish');
        const finished = await waitFor(first, 'finished');
        const started = await waitFor(second, 'started');
        // IPC の受信遅延を許容する。実際の待機時間の厳密な検証は単体テストで行う。
        assert.ok(started.received - finished.received >= 4900);
        second.child.send('finish');
        await waitFor(second, 'released');
        assert.equal((await first.exited).code, 0);
        assert.equal((await second.exited).code, 0);
    } finally {
        await Promise.all(workers.map(stop));
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('鍵の所有者が強制終了すると待機し、手動復旧後に進む', { timeout: 20000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'throttle-crash-'));
    const workers = [];
    try {
        const owner = worker(dir); workers.push(owner);
        await waitFor(owner, 'started');
        await stop(owner);
        const lock = path.join(dir, 'shared.example.org', 'edit.lock');
        assert.equal((await fs.stat(lock)).isDirectory(), true);
        const waiter = worker(dir); workers.push(waiter);
        await waitFor(waiter, 'ready');
        await sleep(1200);
        assert.equal(waiter.events.some(item => item.event === 'started'), false);
        // 所有者の終了を確認済み。実運用では全ジョブとサーバー側の処理の停止も確認する。
        await fs.rmdir(lock);
        await waitFor(waiter, 'started');
        waiter.child.send('finish');
        await waitFor(waiter, 'released');
        assert.equal((await waiter.exited).code, 0);
    } finally {
        await Promise.all(workers.map(stop));
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('通常優先度の待機中に終了すると札が残り、low は復旧まで待つ', { timeout: 25000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'throttle-ticket-'));
    const workers = [];
    try {
        const owner = worker(dir); workers.push(owner);
        await waitFor(owner, 'started');
        const waiter = worker(dir); workers.push(waiter);
        await waitFor(waiter, 'ready');
        const priorityDir = path.join(dir, 'shared.example.org', 'priority');
        const deadline = performance.now() + 5000;
        let tickets = [];
        while (!(tickets = await fs.readdir(priorityDir)).length && performance.now() < deadline) await sleep(25);
        assert.equal(tickets.length, 1);
        await stop(waiter);
        assert.deepEqual(await fs.readdir(priorityDir), tickets);
        const low = worker(dir, 'low'); workers.push(low);
        await waitFor(low, 'ready');
        owner.child.send('finish');
        await waitFor(owner, 'released');
        await sleep(700);
        assert.equal(low.events.some(item => item.event === 'started'), false);
        await fs.unlink(path.join(priorityDir, tickets[0]));
        await waitFor(low, 'started');
        low.child.send('finish');
        await waitFor(low, 'released');
        assert.equal((await low.exited).code, 0);
    } finally {
        await Promise.all(workers.map(stop));
        await fs.rm(dir, { recursive: true, force: true });
    }
});
