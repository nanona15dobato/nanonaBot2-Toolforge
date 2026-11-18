const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseConfig, validateItem, parseInterval, cronMatches, isDue, purge, groupPurgeBatches, resolveConfig, main, expandedTemplates, titleParser } = require('../src/cache-purge');
const { loadRegistry, validateRegistry } = require('../scripts/task-registry');

test('Luaと共通の入力コーパスで検証する', () => {
    const rows = fs.readFileSync(path.join(__dirname, 'cases/cache-purge-validation.tsv'), 'utf8').trimEnd().split(/\r?\n/);
    for (const row of rows.filter(row => row && !row.startsWith('#'))) {
        const [expected, page, timing, mode, extra] = row.split('\t');
        const args = { 1: page, 2: timing, 3: mode };
        if (extra) args[extra] = 'x';
        const text = '{{/temp|' + Object.entries(args).map(([key, value]) => `${key}=${value}`).join('|') + '}}';
        if (expected === '1') {
            assert.doesNotThrow(() => validateItem(args), row);
            assert.doesNotThrow(() => parseConfig(text), row);
        } else {
            assert.throws(() => validateItem(args), undefined, row);
            assert.throws(() => parseConfig(text), undefined, row);
        }
    }
});

test('正常行に続く未閉鎖設定・コメントは正常版と認定しない', () => {
    const good = '{{/temp|Template:Good|15m|purge}}';
    for (const bad of ['{{/temp|Template:Broken|15m|purge', '<!-- broken', '<nowiki>broken']) {
        assert.throws(() => parseConfig(good + '\n' + bad), /閉じていない/);
        const resolved = resolveConfig(good + '\n' + bad, { lastValidConfig: {items: parseConfig(good), content: good} });
        assert.equal(resolved.valid, false);
    }
    assert.throws(() => parseConfig(good.replace('}}', '|extra=1}}')), /引数/);
    assert.throws(() => parseConfig('{{/temp|__proto__=x|Template:Good|15m|purge}}'), /引数/);
    assert.throws(() => parseConfig('{{/temp|Template:Good|15m|purge|1=Template:Other}}'), /重複/);
    assert.throws(() => parseConfig('{{/temp|Invalid[|15m|purge}}'));
    assert.throws(() => parseConfig(good + '}}'), /開始記号/);
    assert.throws(() => parseConfig(good + '}'), /開始記号/);
});

test('構文エラー版は正常本文へ復元して通知し、取得版との編集競合を検出する', async () => {
    const good = '{{/temp|Template:X|15m|purge}}';
    const bad = good + '\n{{/temp|Template:Broken|15m|purge';
    let disk = {targets: {'Template:X|purge': {lastRun: '2026-11-16T09:30:00Z'}},
        lastValidConfig: {content: good, items: parseConfig(good)}};
    let saved;
    await main({
        client: {
            login: async () => {},
            read: async () => ({revisions: [{content: bad, timestamp: '2026-11-16T09:30:00Z'}]}),
            save: async (title, content, summary, options) => {saved = {content, options}; return {result: 'Success'};},
            request: async () => {throw new Error('間隔未達のため対象APIを呼んではいけない');}
        },
        checkStatus: async () => {}, request: action => action(),
        clock: () => Date.parse('2026-11-16T09:31:00Z'),
        loadState: () => structuredClone(disk), saveState: state => {disk = structuredClone(state);},
        log: {info() {}, warning() {}, error() {}}
    });
    assert.ok(saved.content.startsWith(good));
    assert.ok(!saved.content.includes('Template:Broken'));
    assert.match(saved.content, /設定差分エラー通知/);
    assert.equal(saved.options.basetimestamp, '2026-11-16T09:30:00Z');
    assert.equal(disk.lastValidConfig.content, good);
});

test('不正なcronは照合時刻に関係なく拒否する', () => {
    for (const timestamp of ['2026-11-16T09:30:00Z', '2026-11-16T10:30:00Z']) {
        assert.throws(() => cronMatches('0 9,bad * * *', Date.parse(timestamp)));
    }
});

test('空編集の競合は中止し、取得版の時刻とnocreateを送る', async () => {
    let saved;
    const conflict = Object.assign(new Error('conflict'), {code: 'editconflict'});
    await assert.rejects(purge([{title: 'Template:X', mode: 'nulledit'}], {
        read: async (title, options) => {
            assert.equal(options.redirects, false);
            return {revisions: [{content: 'old', timestamp: '2026-11-16T09:00:00Z'}]};
        },
        save: async (title, content, summary, options) => { saved = options; throw conflict; }
    }), {code: 'editconflict'});
    assert.equal(saved.basetimestamp, '2026-11-16T09:00:00Z');
    assert.equal(saved.nocreate, true);
});

test('cronの1分遅延を拾い、予定時刻をキーに二重実行を防ぐ', () => {
    const item = validateItem({1: 'Template:X', 2: '30 9 * * 1', 3: 'purge'});
    const now = Date.parse('2026-11-16T09:31:30Z');
    assert.equal(isDue(item, {targets: {}}, now), true);
    assert.equal(isDue(item, {targets: {[item.id]: {lastSlot: '2026-11-16T09:30'}}}, now), false);
    assert.equal(isDue(item, {targets: {}}, Date.parse('2026-11-16T09:35:00Z')), false);
});

test('後続バッチ失敗後も正常設定と先行バッチの履歴が残る', async () => {
    const content = '{{/temp|Template:A|15m|purge}}\n{{/temp|Template:B|15m|forcelinkupdate}}';
    let disk = {targets: {}};
    let calls = 0;
    const dependencies = {
        client: {
            login: async () => {},
            read: async () => ({revisions: [{content, timestamp: '2026-11-16T09:00:00Z'}]}),
            request: async params => {
                calls++;
                if (params.forcelinkupdate) throw new Error('API failure');
                return {purge: [{title: 'Template:A', purged: true}]};
            }
        },
        checkStatus: async () => {}, request: action => action(),
        loadState: () => structuredClone(disk), saveState: state => {disk = structuredClone(state);},
        clock: () => Date.parse('2026-11-16T09:31:00Z'),
        log: {info() {}, warning() {}, error() {}}
    };
    assert.equal((await main(dependencies)).failed.length, 1);
    assert.equal(disk.lastValidConfig.content, content);
    assert.ok(disk.targets['Template:A|purge']);
    assert.equal(disk.targets['Template:B|forcelinkupdate'], undefined);
    calls = 0;
    assert.equal((await main(dependencies)).failed.length, 1);
    assert.equal(calls, 1, '成功済み対象には再アクセスしない');
});

test('テンプレート形式のキャッシュ破棄設定を読み取る', () => {
    const items = parseConfig(`
{{/temp|Template:RfA watchlist notice|15m|purge}}
`);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Template:RfA watchlist notice');
    assert.equal(items[0].interval, 15 * 60 * 1000);
    assert.equal(items[0].mode, 'purge');
});

test('コメントとnowiki内の設定例は読み取らない', () => {
    const items = parseConfig(`
<!-- {{/temp|Template:Ignored comment|30m|purge}} -->
<nowiki>{{/temp|Template:Ignored nowiki|30m|purge}}</nowiki>
{{/temp|Template:Active|30m|purge}}
`);
    assert.deepEqual(items.map(item => item.title), ['Template:Active']);
});

test('UTC cronで曜日と時刻を指定できる', () => {
    // 2026-11-16 09:30 UTC は月曜日。
    const monday930Utc = Date.parse('2026-11-16T09:30:00Z');
    assert.equal(cronMatches('30 9 * * 1', monday930Utc), true);
    assert.equal(cronMatches('30 9 * * 2', monday930Utc), false);
});

test('5分ごとの起動では到達しないcron時刻は設定として拒否する', () => {
    assert.throws(() => parseConfig(`{{/temp|Template:X|7 9 * * 1|purge}}`), /5分単位/);
});

test('設定エラー時は直前の正常設定を使う', () => {
    const state = { lastValidConfig: { content: '{{/temp|Template:X|30m|purge}}', items: [{ id: 'Template:X|purge', title: 'Template:X', interval: 1800000, mode: 'purge' }] } };
    const resolved = resolveConfig('{{/temp|Template:X|30m|invalid}}', state);
    assert.equal(resolved.valid, false);
    assert.equal(resolved.items[0].title, 'Template:X');
});

test('設定した間隔までは再実行しない', () => {
    const item = { id: 'test', interval: parseInterval('1h') };
    const now = Date.parse('2026-11-16T00:30:00Z');
    assert.equal(isDue(item, { targets: { test: { lastRun: '2026-11-16T00:00:00Z' } } }, now), false);
    assert.equal(isDue(item, { targets: { test: { lastRun: '2026-11-15T23:00:00Z' } } }, now), true);
});

test('同じmodeのpurge対象は1リクエストにまとめる', async () => {
    const items = [
        { title: 'Template:A', mode: 'purge' },
        { title: 'Template:B', mode: 'purge' }
    ];
    let params;
    const results = await purge(items, { request: async value => { params = value; return { purge: [{ title: 'Template:A', purged: true }, { title: 'Template:B', purged: true }] }; } });
    assert.equal(results.every(result => result.success), true);
    assert.equal(params.titles, 'Template:A|Template:B');
    assert.equal(groupPurgeBatches([...items, { title: 'Template:C', mode: 'forcelinkupdate' }]).length, 2);
});

test('parse2で空白・別名を正規化して同一設定を重複除去する', () => {
    const items = parseConfig('{{/temp|template:a_b|15m|purge}}\n{{/temp|テンプレート:A b|15m|purge}}');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Template:A b');
    assert.throws(() => parseConfig('{{/temp|Template:A_B|15m|purge}}\n{{/temp|Template:A B|30m|purge}}'), /重複/);
});

test('APIの正規化・変換情報で成功結果を元の対象に対応付ける', async () => {
    let titles;
    const results = await purge([
        {title: 'Template:A_B', mode: 'purge'}, {title: 'Template:A B', mode: 'purge'},
        {title: 'Template:Old', mode: 'purge'}
    ], {request: async params => {
        titles = params.titles;
        return {normalized: [{from: 'Template:A_B', to: 'Template:A B'}],
            converted: [{from: 'Template:Old', to: 'Template:New'}],
            purge: [{title: 'Template:A B', purged: true}, {title: 'Template:New', purged: true}]};
    }});
    assert.equal(titles, 'Template:A B|Template:Old');
    assert.equal(results.filter(result => result.success).length, 3);
});

test('同一バッチの部分成功を保存し、後続を継続して成功対象への再アクセスを防ぐ', async () => {
    const content = '{{/temp|Template:Good|15m|purge}}\n{{/temp|Template:Missing|15m|purge}}\n{{/temp|Template:Next|15m|forcelinkupdate}}';
    let disk = {targets: {}};
    let calls = [];
    const options = {
        client: {login: async () => {},
            read: async () => ({revisions: [{content, timestamp: '2026-11-16T09:00:00Z'}]}),
            request: async params => {
                calls.push(params.titles);
                return {purge: params.titles.split('|').map(title => title === 'Template:Missing'
                    ? {title, missing: true} : {title, purged: true})};
            }},
        checkStatus: async () => {}, request: action => action(),
        loadState: () => structuredClone(disk), saveState: state => {disk = structuredClone(state);},
        clock: () => Date.parse('2026-11-16T09:31:00Z'), log: {info() {}, warning() {}, error() {}}
    };
    const first = await main(options);
    assert.deepEqual(first.purged, ['Template:Good', 'Template:Next']);
    assert.equal(first.failed.length, 1);
    assert.ok(disk.targets['Template:Good|purge']);
    assert.ok(disk.targets['Template:Next|forcelinkupdate']);
    assert.equal(disk.targets['Template:Missing|purge'], undefined);
    calls = [];
    await main(options);
    assert.deepEqual(calls, ['Template:Missing']);
});

test('展開API障害を構文エラー扱いして設定を書き換えない', async () => {
    let writes = 0;
    await assert.rejects(main({client: {
        login: async () => {},
        read: async () => ({revisions: [{content: '{{/temp|Template:X|{{#expr:15}}m|purge}}'}]}),
        request: async () => {throw new Error('maxlag');}, save: async () => {writes++;}
    }, checkStatus: async () => {}, request: action => action(), loadState: () => ({targets: {}}),
    saveState: () => {}, log: {info() {}, warning() {}, error() {}}}), /maxlag/);
    assert.equal(writes, 0);
});

test('テンプレート呼出しの生wikitextから展開APIを経てLua共通の値を検証する', async () => {
    const rows = fs.readFileSync(path.join(__dirname, 'cases/cache-purge-expansion.tsv'), 'utf8').trimEnd().split(/\r?\n/);
    for (const row of rows.filter(row => row && !row.startsWith('#'))) {
        const [expected, rawTime, time, rawMode, mode, rawPage, page] = row.split('\t');
        const expanded = new Map([[rawTime, time], [rawMode, mode], [rawPage, page]]);
        const client = {request: async params => {
            assert.equal(params.action, 'expandtemplates');
            assert.equal(params.title, '利用者:NanonaBot2/w-ja-nn6/config');
            assert.ok(expanded.has(params.text));
            return {expandtemplates: {wikitext: expanded.get(params.text)}};
        }};
        const source = `{{/temp|${rawPage}|${rawTime}|${rawMode}\n}}`;
        const parser = titleParser();
        const templates = await expandedTemplates(source, client, action => action(), parser);
        if (expected === '1') {
            const resolved = resolveConfig(source, {targets: {}}, {templates, parser});
            assert.equal(resolved.valid, true);
            assert.equal(resolved.items[0].title, page);
        } else assert.throws(() => resolveConfig(source, {targets: {}}, {templates, parser}), undefined, row);
    }
});

test('正常版がない初回の構文エラーでMediaWikiが末尾改行を除去しても無限追記せず、未閉鎖コメントを閉じる', async () => {
    let wikiContent = '<!-- 未閉鎖コメント';
    let revid = 100;
    let disk = { targets: {} };
    let saves = 0;
    const dependencies = {
        client: {
            login: async () => {},
            read: async (title, options) => {
                assert.equal(options.redirects, false);
                return { revisions: [{ content: wikiContent, timestamp: '2026-11-16T09:00:00Z', revid }] };
            },
            save: async (title, content, summary, options) => {
                saves++;
                assert.equal(options.nocreate, true);
                // MediaWiki保存時の末尾空白除去（PST）を再現する
                wikiContent = content.replace(/\s+$/, '');
                revid++;
                return { result: 'Success', newrevid: revid };
            },
            request: async () => { throw new Error('対象APIを呼んではいけない'); }
        },
        checkStatus: async () => {}, request: action => action(),
        loadState: () => structuredClone(disk), saveState: state => { disk = structuredClone(state); },
        clock: () => Date.parse('2026-11-16T09:00:00Z'),
        log: { info() {}, warning() {}, error() {} }
    };
    await main(dependencies);
    assert.equal(saves, 1);
    assert.match(wikiContent, /<!-- 未閉鎖コメント -->\n\n----\n'''Botによる設定差分エラー通知'''/);
    // 5分後の再実行で同じエラー通知を二重追記しない
    await main(dependencies);
    assert.equal(saves, 1);
});

test('設定ページが未作成・削除済みの場合は新規作成しない', async () => {
    let saves = 0;
    await assert.rejects(main({
        client: {
            login: async () => {},
            read: async () => ({ missing: true }),
            save: async () => { saves++; return { result: 'Success' }; }
        },
        checkStatus: async () => {}, request: action => action(),
        loadState: () => ({ targets: {}, lastValidConfig: { content: '{{/temp|Template:X|15m|purge}}', items: parseConfig('{{/temp|Template:X|15m|purge}}') } }),
        saveState: () => {},
        log: { info() {}, warning() {}, error() {} }
    }), /設定ページを読み込めませんでした/);
    assert.equal(saves, 0);
});

test('5分間隔の対象でAPI処理時間や数秒の起動揺れがあっても次の5分枠で実行される', () => {
    const item = validateItem({ 1: 'Template:X', 2: '5m', 3: 'purge' });
    // 09:00枠で 09:00:09 に完了し、次の 09:05枠で 09:05:05 に判定された場合
    const state = { targets: { [item.id]: { lastRun: '2026-11-16T09:00:09.700Z' } } };
    assert.equal(isDue(item, state, Date.parse('2026-11-16T09:04:59.000Z')), false);
    assert.equal(isDue(item, state, Date.parse('2026-11-16T09:05:05.100Z')), true);
});

test('不正な余剰引数やアンパサンドのみのページ名では展開APIを呼ばない', async () => {
    let apiCalls = 0;
    const client = { request: async () => { apiCalls++; return { expandtemplates: { wikitext: 'x' } }; } };
    await assert.rejects(
        expandedTemplates('{{/temp|Template:X|15m|purge|extra={{#expr:1}}}}', client, action => action(), titleParser()),
        /引数/
    );
    const templates = await expandedTemplates('{{/temp|Template:AT&T|15m|purge}}', client, action => action(), titleParser());
    assert.equal(templates.length, 1);
    assert.equal(apiCalls, 0);
});

test('同一対象の失敗が続く間は2回目以降のエラーメールを抑止する', async () => {
    const content = '{{/temp|Template:Missing|5m|purge}}';
    let disk = { targets: {} };
    let now = Date.parse('2026-11-16T09:00:00Z');
    const errorCalls = [];
    const options = {
        client: {
            login: async () => {},
            read: async () => ({ revisions: [{ content, timestamp: '2026-11-16T09:00:00Z' }] }),
            request: async () => ({ purge: [{ title: 'Template:Missing', missing: true }] })
        },
        checkStatus: async () => {}, request: action => action(),
        loadState: () => structuredClone(disk), saveState: state => { disk = structuredClone(state); },
        clock: () => now,
        log: { info() {}, warning() {}, error: (id, msg, pub, extra) => errorCalls.push(extra || {}) }
    };
    await main(options);
    now += 5 * 60 * 1000;
    await main(options);
    assert.equal(errorCalls.length, 2);
    assert.equal(Boolean(errorCalls[0].nomail), false);
    assert.equal(errorCalls[1].nomail, true);
});

test('tasks.json未登録のsrc/oldアーカイブは許容し、src直下の未登録タスクは拒否する', () => {
    const registry = loadRegistry();
    const baseDeclared = Object.fromEntries(Object.entries(registry.tasks).map(([id, task]) => [id, task.file]));
    assert.deepEqual(validateRegistry(registry, {
        declaredTaskIds: { ...baseDeclared, 'w-ja-PHP1': 'old\\php1.js' }
    }), []);
    const errors = validateRegistry(registry, {
        declaredTaskIds: { ...baseDeclared, 'w-ja-nn99': 'unregistered.js' }
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /w-ja-nn99/);
});
