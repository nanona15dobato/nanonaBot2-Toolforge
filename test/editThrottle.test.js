const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('編集を直列化し、失敗後も5秒空ける', { timeout: 20000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-throttle-'));
    process.env.EDIT_THROTTLE_DIR = dir;
    const { applyEditThrottle } = require('../src/utils/editThrottle');
    const times = [];
    let firstFinished;
    const bot = applyEditThrottle({
        options: { apiUrl: 'https://example.org/w/api.php' },
        async request(params) {
            if (params.action !== 'edit') return 'read';
            times.push(performance.now());
            if (times.length === 1) {
                await new Promise(resolve => setTimeout(resolve, 150));
                firstFinished = performance.now();
                throw new Error('failed');
            }
            return 'saved';
        },
    });
    try {
        assert.equal(applyEditThrottle(bot), bot);
        assert.throws(() => applyEditThrottle(bot, { priority: 'low' }));
        assert.equal(await bot.request({ action: 'query' }), 'read');
        const attempt = () => bot.request({ action: 'edit' }).catch(e => e.message);
        const results = await Promise.all([attempt(), attempt()]);
        assert.deepEqual(results.sort(), ['failed', 'saved']);
        assert.ok(times[1] - firstFinished >= 5000, `interval: ${times[1] - firstFinished} ms`);
        assert.deepEqual(await fs.readdir(path.join(dir, 'example.org', 'priority')), []);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('mwn 形式の再試行は鍵を取り直さず間隔を空ける', { timeout: 15000 }, async () => {
    const { applyEditThrottle } = require('../src/utils/editThrottle');
    const times = [];
    const bot = { options: { apiUrl: 'https://retry.example.org/w/api.php' } };
    bot.request = async params => {
        times.push(performance.now());
        if (times.length === 1) return bot.request(params, { retryNumber: 1 });
        return 'saved';
    };
    applyEditThrottle(bot);
    try {
        assert.equal(await bot.request({ action: 'edit' }), 'saved');
        assert.ok(times[1] - times[0] >= 5000);
    } finally {
        await fs.rm(process.env.EDIT_THROTTLE_DIR, { recursive: true, force: true });
    }
});

test('再試行でない入れ子の編集は鍵を迂回しない', { timeout: 10000 }, async () => {
    const { applyEditThrottle } = require('../src/utils/editThrottle');
    const bot = { options: { apiUrl: 'https://nested.example.org/w/api.php' } };
    bot.request = async params => bot.request(params);
    applyEditThrottle(bot);
    try {
        await assert.rejects(bot.request({ action: 'edit' }), /Nested edit/);
    } finally {
        await fs.rm(process.env.EDIT_THROTTLE_DIR, { recursive: true, force: true });
    }
});
