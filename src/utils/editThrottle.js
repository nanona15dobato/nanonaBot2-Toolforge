const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout: sleep } = require('node:timers/promises');

// 全プロセスが同じ共有ディレクトリを使うこと。鍵の自動回収は行わない。
const BASE_DIR = process.env.EDIT_THROTTLE_DIR || path.join(__dirname, '../data/edit-throttle');
const MIN_INTERVAL = 5000;
const applied = Symbol.for('nanonaBot2.editThrottle');
const slotContext = new AsyncLocalStorage();

async function poll() {
    await sleep(200 + Math.random() * 300);
}

async function acquire(lockDir) {
    for (;;) {
        try {
            await fs.mkdir(lockDir);
            return;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await poll();
        }
    }
}

async function withEditSlot(key, priority, bot, options, fn) {
    // mwn の再試行は同じ非同期コンテキストで request を呼ぶ。
    // 自分の鍵を再取得せず、前の試行から間隔を空ける。
    const context = slotContext.getStore();
    if (context?.key === key && context.active) {
        // 同じ非同期処理からの呼び出しが全て再試行とは限らない。
        // mwn の retry() が渡す連続した番号と元の bot を確認する。
        if (context.bot !== bot || options?.retryNumber !== context.retryNumber + 1) {
            throw new Error('Nested edit is not a sequential mwn retry');
        }
        context.retryNumber++;
        await sleep(MIN_INTERVAL);
        if (!context.active) throw new Error('Edit throttle slot is no longer active');
        return fn();
    }

    const dir = path.join(BASE_DIR, key);
    const lockDir = path.join(dir, 'edit.lock');
    const priorityDir = path.join(dir, 'priority');
    await fs.mkdir(priorityDir, { recursive: true });
    const ticket = priority === 'normal'
        ? path.join(priorityDir, `${process.pid}-${crypto.randomBytes(16).toString('hex')}`)
        : null;
    if (ticket) await fs.writeFile(ticket, '', { flag: 'wx' });

    let locked = false;
    try {
        for (;;) {
            if (!ticket && (await fs.readdir(priorityDir)).length) {
                await poll();
                continue;
            }
            await acquire(lockDir);
            locked = true;
            if (!ticket && (await fs.readdir(priorityDir)).length) {
                await fs.rmdir(lockDir);
                locked = false;
                await poll();
                continue;
            }
            break;
        }
        if (ticket) await fs.unlink(ticket);
        const slot = { key, bot, active: true, retryNumber: options?.retryNumber || 0 };
        try {
            return await slotContext.run(slot, fn);
        } finally {
            slot.active = false;
            // 応答・エラー後も鍵を保持する。共有時計や状態ファイルは不要。
            await sleep(MIN_INTERVAL);
        }
    } finally {
        try {
            if (ticket) await fs.unlink(ticket).catch(error => {
                if (error.code !== 'ENOENT') throw error;
            });
        } finally {
            if (locked) await fs.rmdir(lockDir);
        }
    }
}

function applyEditThrottle(bot, { priority = 'normal' } = {}) {
    if (priority !== 'normal' && priority !== 'low') throw new Error(`Invalid edit throttle priority: ${priority}`);
    if (bot[applied]) {
        if (bot[applied] !== priority) throw new Error('Edit throttle already applied with a different priority');
        return bot;
    }
    const key = new URL(bot.options.apiUrl).hostname;
    const request = bot.request.bind(bot);
    bot.request = (params, options) => params?.action === 'edit'
        ? withEditSlot(key, priority, bot, options, () => request(params, options))
        : request(params, options);
    bot[applied] = priority;
    return bot;
}

module.exports = { applyEditThrottle };
