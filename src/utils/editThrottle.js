const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { setTimeout: sleep } = require('node:timers/promises');

/**
 * nanonaBot2 編集間隔制御
 * 全ジョブ(別プロセス・別Pod)で共有するファイルを使い、
 * 同一ウィキへの編集リクエストの送信間隔を MIN_INTERVAL 以上に保つ。
 *
 *   edit.lock/        … 鍵 (mkdir がアトミックなことを利用)
 *   last-edit         … 最後に編集を送り始めた時刻
 *   priority/<id>     … 通常優先度のジョブが待機中であることを示す札
 *
 * priority: 'low' のBot(大量処理用)は、札が1枚でもあれば編集を譲る。
 */
const BASE_DIR = path.join(__dirname, '../data/edit-throttle');
const MIN_INTERVAL = 5000;
const STALE_LOCK_MS = 60000;   // 鍵を持ったまま落ちたとみなす時間
const STALE_PRIORITY_MS = 600000; // 札を立てたまま落ちたとみなす時間

function poll() {
    return sleep(200 + Math.random() * 300);
}

async function hasPriorityWaiter(priorityDir) {
    const names = await fs.readdir(priorityDir).catch(() => []);
    for (const name of names) {
        const file = path.join(priorityDir, name);
        const st = await fs.stat(file).catch(() => null);
        if (!st) continue;
        if (Date.now() - st.mtimeMs > STALE_PRIORITY_MS) {
            await fs.unlink(file).catch(() => {});
            continue;
        }
        return true;
    }
    return false;
}

async function tryAcquire(lockDir) {
    try {
        await fs.mkdir(lockDir);
        return true;
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const st = await fs.stat(lockDir).catch(() => null);
        if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
            await fs.rmdir(lockDir).catch(() => {});
        }
        return false;
    }
}

/**
 * 編集スロットを確保してから fn を実行する
 * @param {string} key 間隔を共有する単位 (ウィキのホスト名)
 * @param {'normal'|'low'} priority
 * @param {() => Promise<any>} fn
 */
async function withEditSlot(key, priority, fn) {
    const dir = path.join(BASE_DIR, key);
    const lockDir = path.join(dir, 'edit.lock');
    const stampFile = path.join(dir, 'last-edit');
    const priorityDir = path.join(dir, 'priority');
    await fs.mkdir(priorityDir, { recursive: true });

    const isLow = priority === 'low';
    let ticket = null;
    if (!isLow) {
        ticket = path.join(priorityDir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        await fs.writeFile(ticket, '');
    }

    try {
        for (;;) {
            if (isLow && await hasPriorityWaiter(priorityDir)) {
                await poll();
                continue;
            }
            if (!await tryAcquire(lockDir)) {
                await poll();
                continue;
            }
            try {
                const last = Number(await fs.readFile(stampFile, 'utf8').catch(() => 0)) || 0;
                const wait = last + MIN_INTERVAL - Date.now();
                if (wait > 0) await sleep(wait);
                // 待っている間に通常優先度のジョブが来たら譲る
                if (isLow && await hasPriorityWaiter(priorityDir)) continue;
                await fs.writeFile(stampFile, String(Date.now()));
                break;
            } finally {
                await fs.rmdir(lockDir).catch(() => {});
            }
        }
    } finally {
        if (ticket) await fs.unlink(ticket).catch(() => {});
    }
    return fn();
}

/**
 * mwn の Bot に編集間隔制御を組み込む
 * edit / save / create などはすべて request({ action: 'edit' }) を通るため、そこを包む
 * @param {import('mwn').Mwn} bot
 * @param {{ priority?: 'normal'|'low' }} [options]
 */
function applyEditThrottle(bot, { priority = 'normal' } = {}) {
    const key = new URL(bot.options.apiUrl).hostname;
    const orig = bot.request.bind(bot);
    bot.request = (params, customRequestOptions) =>
        params?.action === 'edit'
            ? withEditSlot(key, priority, () => orig(params, customRequestOptions))
            : orig(params, customRequestOptions);
    return bot;
}

module.exports = { applyEditThrottle };
