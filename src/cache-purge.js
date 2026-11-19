const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Mwn } = require('mwn');
const WikitextParser = require('./utils/parse2');
const { applyEditThrottle } = require('./utils/editThrottle');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require('./utils/logger');

const taskId = 'w-ja-nn6';
const nnversion = '__FILE_HASH__';
const configPage = '利用者:NanonaBot2/w-ja-nn6/config';
const statePath = path.join(__dirname, 'data/cache-purge/state.json');
const configTemplatePage = '利用者:NanonaBot2/w-ja-nn6/config/temp';
const validModes = new Set(['purge', 'nulledit', 'forcelinkupdate', 'forcerecursivelinkupdate']);
const maxTemplateExpansions = 50;

const bot = applyEditThrottle(new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/cache-purge [${nnversion}] (Toolforge)`,
    defaultParams: { format: 'json', assert: 'bot' }
}));

/** Scribunto の mw.text.trim と同じ ASCII 空白のみを除去 */
function trimAscii(value) {
    return String(value || '').replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '');
}

/** `30m`、`2h`、`1h30m` の間隔をミリ秒にする（5分から7日まで）。 */
function parseInterval(value) {
    const text = trimAscii(value).toLowerCase();
    const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
    if (!match || (!match[1] && !match[2])) {
        throw new Error(`interval は "30m" や "1h30m" の形式で指定してください: ${value}`);
    }
    const milliseconds = ((Number(match[1] || 0) * 60) + Number(match[2] || 0)) * 60 * 1000;
    if (milliseconds < 5 * 60 * 1000 || milliseconds > 7 * 24 * 60 * 60 * 1000) {
        throw new Error(`interval は5分以上7日以下にしてください: ${value}`);
    }
    return milliseconds;
}

function parseModes(value) {
    const mode = trimAscii(value || 'purge').toLowerCase();
    if (!validModes.has(mode)) throw new Error(`未対応の mode です: ${mode}`);
    return mode;
}

function matchesCronField(expression, value, minimum, maximum) {
    let matches = false;
    for (const part of expression.split(',')) {
        const match = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
        if (!match) throw new Error(`schedule を解釈できません: ${expression}`);
        const [, all, start, end, step] = match;
        if (step !== undefined && all !== '*' && end === undefined) {
            throw new Error(`schedule のステップ指定には "*" または範囲が必要です: ${part}`);
        }
        const from = all === '*' ? minimum : Number(start);
        const to = all === '*' ? maximum : Number(end || start);
        const interval = Number(step || 1);
        if (from < minimum || to > maximum || from > to || interval < 1 || !Number.isFinite(interval)) {
            throw new Error(`schedule の範囲が不正です: ${part}`);
        }
        if (value >= from && value <= to && (value - from) % interval === 0) matches = true;
    }
    return matches;
}

function matchesCronDayOfWeek(expression, dayOfWeek) {
    // cronでは日曜を0と7の両方で表せる。
    return matchesCronField(expression, dayOfWeek, 0, 7) || (dayOfWeek === 0 && matchesCronField(expression, 7, 0, 7));
}

/** UTCで解釈する5フィールドcron式。曜日は0または7が日曜、1が月曜。 */
function cronMatches(schedule, now) {
    const fields = trimAscii(schedule).split(/[ \t\r\n\f\v]+/);
    if (fields.length !== 5) throw new Error(`schedule はUTCの5フィールドcron式にしてください: ${schedule}`);
    const date = new Date(now);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const minuteMatches = matchesCronField(minute, date.getUTCMinutes(), 0, 59);
    const hourMatches = matchesCronField(hour, date.getUTCHours(), 0, 23);
    const monthMatches = matchesCronField(month, date.getUTCMonth() + 1, 1, 12);
    const domMatches = matchesCronField(dayOfMonth, date.getUTCDate(), 1, 31);
    const dowMatches = matchesCronDayOfWeek(dayOfWeek, date.getUTCDay());
    if (!minuteMatches || !hourMatches || !monthMatches) return false;
    const domAny = dayOfMonth === '*';
    const dowAny = dayOfWeek === '*';
    return domAny && dowAny ? true : domAny ? dowMatches : dowAny ? domMatches : domMatches || dowMatches;
}

function minuteKey(now) {
    return new Date(now).toISOString().slice(0, 16);
}

// Toolforgeジョブは5分ごとなので、到達しない分指定を設定時に防ぐ。
function validateScheduleCadence(schedule) {
    cronMatches(schedule, Date.now());
    const minuteField = trimAscii(schedule).split(/[ \t\r\n\f\v]+/)[0];
    for (let minute = 0; minute < 60; minute++) {
        if (matchesCronField(minuteField, minute, 0, 59) && minute % 5 !== 0) {
            throw new Error(`schedule の分は5分単位（0,5,…,55）にしてください: ${schedule}`);
        }
    }
}

// 表示用Luaと共有する入力仕様。ページ名は展開を含まない絶対名のみ。
function stripComments(value) {
    return String(value || '').replace(/<!--[\s\S]*?-->/g, '');
}

function titleParser(client) {
    const parser = new WikitextParser();
    // mwnはログイン時に取得したsiteinfoをTitleへ保持する。
    if (client?.Title?.idNameMap) parser.setSiteInfo({
        namespaces: Object.entries(client.Title.idNameMap).map(([id, name]) => ({ id: Number(id), name })),
        namespacealiases: Object.entries(client.Title.nameIdMap || {}).map(([alias, id]) => ({ alias: alias.replace(/_/g, ' '), id }))
    });
    return parser;
}

function validateArgsList(args, argsOrdered) {
    if (Array.isArray(argsOrdered)) {
        for (const entry of argsOrdered) {
            const key = String(entry.key);
            if (!['1', '2', '3'].includes(key)) throw new Error('引数は1・2・3のみ指定できます');
        }
    }
    if (Object.keys(args).some(key => !['1', '2', '3'].includes(String(key)))) {
        throw new Error('引数は1・2・3のみ指定できます');
    }
}

function validateItem(args, parser = titleParser(), argsOrdered = null) {
    validateArgsList(args, argsOrdered);
    const [page, timing, modeValue] = [1, 2, 3].map(key => trimAscii(stripComments(args[key])));
    if (!page || !timing || !modeValue) throw new Error('3引数が必要です');
    const name = trimAscii(page.replace(/_/g, ' '));
    if (Buffer.byteLength(page, 'utf8') > 255 || /[|{}\[\]<>#\x00-\x1f\x7f]|%[0-9a-f]{2}|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|~{3}/i.test(page)
        || !name || name.startsWith(':') || name.startsWith('/') || name.endsWith(':')
        || name.split('/').some(part => ['.', '..'].includes(trimAscii(part)))) {
        throw new Error(`ページ名が不正です: ${page}`);
    }
    const mode = parseModes(modeValue);
    const title = parser.normalizeTitle(page);
    const item = { id: `${title}|${mode}`, title, mode };
    if (timing.split(/[ \t\r\n\f\v]+/).length === 5) {
        validateScheduleCadence(timing);
        item.schedule = timing;
    } else item.interval = parseInterval(timing);
    return item;
}

/** 設定ページ内の {{/temp|ページ名|interval または schedule|mode}} を読み取る。 */
function configTemplates(wikitext, parser = titleParser()) {
    // nowiki等の中は保持し、本物のコメントだけを除去する。
    const comments = parser.findProtectedRanges(wikitext).filter(range => range.prefix === 'COMMENT');
    const text = WikitextParser.applyEdits(wikitext, comments.map(range => ({ ...range, replacement: '' })));
    const templates = parser.parse(text, {
        pageTitle: configPage,
        strict: true,
        templateContext: true,
        templates: [configTemplatePage]
    }).templates.filter(template => template.type === 'template' && template.name === parser.normalizeTitle(configTemplatePage));
    if (templates.some(template => !template.topLevel)) {
        throw new Error('設定テンプレート /temp はトップレベルに記述してください（入れ子は禁止です）');
    }
    return templates;
}

function configItems(templates, parser) {
    const items = [];
    for (const template of templates) {
        items.push(validateItem(template.args, parser, template.argsOrdered));
    }
    const ids = new Map();
    for (const item of items) {
        const previous = ids.get(item.id);
        if (previous && (previous.interval !== item.interval || previous.schedule !== item.schedule)) {
            throw new Error(`同じページ・modeの実行予定が重複しています: ${item.id}`);
        }
        ids.set(item.id, item);
    }
    return [...ids.values()];
}

function parseConfig(wikitext) {
    const parser = titleParser();
    return configItems(configTemplates(wikitext, parser), parser);
}

async function expandedTemplates(wikitext, client, request, parser, revisionId = null) {
    const templates = configTemplates(wikitext, parser);
    const cache = new Map();
    for (const template of templates) {
        validateArgsList(template.args, template.argsOrdered);
        for (const key of ['1', '2', '3']) {
            const raw = template.args[key];
            if (typeof raw !== 'string' || !/[{<]/.test(raw)) continue;
            if (!cache.has(raw)) {
                if (cache.size >= maxTemplateExpansions) {
                    throw new Error(`展開が必要な引数が上限（${maxTemplateExpansions}種類）を超えています`);
                }
                try {
                    const result = await request(() => client.request({
                        action: 'expandtemplates', title: configPage, text: raw, prop: 'wikitext',
                        ...(revisionId !== null ? { revid: revisionId } : {})
                    }));
                    const expanded = result?.expandtemplates?.wikitext ?? result?.expandtemplates?.['*'];
                    if (typeof expanded !== 'string') throw new Error('展開APIの応答が不正です');
                    cache.set(raw, expanded);
                } catch (error) {
                    // 通信障害を設定ミスと誤認して差し戻さない。
                    error.configurationReadError = true;
                    throw error;
                }
            }
            template.args[key] = cache.get(raw);
        }
    }
    return templates;
}

function resolveConfig(wikitext, state, prepared) {
    try {
        const items = prepared ? configItems(prepared.templates, prepared.parser) : parseConfig(wikitext);
        if (!items.length) throw new Error('有効な /temp 設定がありません');
        return { items, valid: true };
    } catch (error) {
        const previousItems = state.lastValidConfig?.items;
        if (!Array.isArray(previousItems) || !previousItems.length) throw error;
        return { items: previousItems, valid: false, error };
    }
}

function configHash(text) {
    return crypto.createHash('sha256').update(String(text ?? '').replace(/\s+$/, '')).digest('hex');
}

/** 前回正常版がない状態でエラー通知を追記する際、未閉鎖のコメント・保護タグに通知が飲み込まれないよう閉じる。 */
function closeBrokenMarkup(text, parser = titleParser()) {
    const outside = WikitextParser.applyEdits(
        text,
        parser.findProtectedRanges(text).map(range => ({ ...range, replacement: '' }))
    );
    let suffix = '';
    if (outside.includes('<!--')) suffix += ' -->';
    for (const tag of parser.escapeTags) {
        if (new RegExp(`<${tag}\\b`, 'i').test(outside)) suffix += `</${tag}>`;
    }
    return text.replace(/\s+$/, '') + suffix;
}

function errorNotice(error, restored = true) {
    const message = String(error.message).replace(/<\/nowiki>/gi, '&lt;/nowiki&gt;');
    const status = restored
        ? '設定を解釈できなかったため、直前に正常確認した版へ差し戻したうえで、この通知を追記しました。'
        : '設定を解釈できず、直前に正常確認した版もないため、この通知を追記しました。';
    return `\n\n----\n'''Botによる設定差分エラー通知''' (${new Date().toISOString()})\n\n${status}\n<nowiki>${message}</nowiki>`;
}

function readState(file = statePath) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { targets: {} };
        throw error;
    }
}

function writeState(state, file = statePath) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temporary, file);
}

function dueSlot(item, state, now) {
    // 直近5分の各分を走査し、最も新しい予定を1回だけ実行する。
    const minute = Math.floor(now / 60000) * 60000;
    const last = state.targets?.[item.id]?.lastSlot;
    for (let offset = 0; offset < 5; offset++) {
        const scheduled = minute - offset * 60000;
        const key = minuteKey(scheduled);
        if (cronMatches(item.schedule, scheduled) && (!last || key > last)) return key;
    }
    return null;
}

function isDue(item, state, now) {
    if (item.schedule) return dueSlot(item, state, now) !== null;
    const lastRun = state.targets?.[item.id]?.lastRun;
    if (!lastRun) return true;
    // API処理時間や数秒の起動揺れで5分周期の枠を取りこぼさないよう、分単位で経過を判定する。
    const lastMinute = Math.floor(Date.parse(lastRun) / 60000);
    if (!Number.isFinite(lastMinute)) return true;
    const nowMinute = Math.floor(now / 60000);
    return (nowMinute - lastMinute) * 60000 >= item.interval;
}

function createRequestLimiter(minimumInterval = 1000) {
    let lastStarted = 0;
    return async action => {
        let wait = minimumInterval - (Date.now() - lastStarted);
        while (wait > 0) {
            await delay(wait);
            wait = minimumInterval - (Date.now() - lastStarted);
        }
        lastStarted = Date.now();
        return action();
    };
}

function isApiFlagSet(obj, key) {
    return Boolean(obj && key in obj && obj[key] !== false);
}

async function nullEdit(item, client = bot, request = action => action()) {
    const editClient = Object.create(client);
    editClient.request = (...args) => request(() => client.request(...args));
    const result = await editClient.edit(item.title, revision => ({
        text: revision.content,
        summary: 'Bot: キャッシュ更新',
        minor: true, bot: true, watchlist: 'nochange'
    }), { conflictRetries: 0, suppressNochangeWarning: true });
    if (result?.result !== 'Success' && !result?.nochange) throw new Error(`空編集に失敗しました: ${item.title}`);
}

async function purge(items, client = bot, request = action => action()) {
    if (!Array.isArray(items) || !items.length) return [];
    const mode = items[0].mode;
    if (items.some(item => item.mode !== mode)) throw new Error('異なる mode は同じリクエストにまとめられません');
    if (mode === 'nulledit') {
        for (const item of items) await nullEdit(item, client, request);
        return items.map(item => ({ item, success: true }));
    }
    const parser = titleParser(client);
    const params = {
        action: 'purge',
        titles: [...new Set(items.map(item => parser.normalizeTitle(item.title)))].join('|')
    };
    if (mode === 'forcelinkupdate') params.forcelinkupdate = true;
    if (mode === 'forcerecursivelinkupdate') params.forcerecursivelinkupdate = true;
    // Mwn.purge()はdata.purgeだけを返す。タイトル照合にnormalized/convertedも必要なためrequestを使う。
    const response = await request(() => client.request(params));
    if (!Array.isArray(response?.purge)) throw new Error('purge APIの応答が不正です');
    const aliases = new Map([...(response.normalized || []), ...(response.converted || [])]
        .map(entry => [parser.normalizeTitle(entry.from), parser.normalizeTitle(entry.to)]));
    const canonical = title => {
        let key = parser.normalizeTitle(title);
        const seen = new Set();
        while (aliases.has(key) && !seen.has(key)) { seen.add(key); key = aliases.get(key); }
        return key;
    };
    const results = new Map(response.purge.map(result => [canonical(result.title || ''), result]));
    return items.map(item => {
        const result = results.get(canonical(item.title));
        const success = Boolean(result && isApiFlagSet(result, 'purged') && !isApiFlagSet(result, 'missing')
            && !isApiFlagSet(result, 'invalid') && !result.error);
        return { item, success, error: success ? undefined : `キャッシュ破棄に失敗しました: ${item.title}` };
    });
}

function groupPurgeBatches(items) {
    const grouped = new Map();
    for (const item of items) {
        const group = grouped.get(item.mode) || [];
        group.push(item);
        grouped.set(item.mode, group);
    }
    return [...grouped.values()].flatMap(group => {
        const batches = [];
        const size = group[0].mode === 'nulledit' ? 1 : 50;
        for (let i = 0; i < group.length; i += size) batches.push(group.slice(i, i + size));
        return batches;
    });
}

async function main({ client = bot, checkStatus = checkTaskStatusAndExit, loadState = readState, saveState = writeState,
    request = createRequestLimiter(), clock = Date.now, log = logger } = {}) {
    await checkStatus(taskId);
    await client.login();
    const config = await request(() => client.read(configPage, { redirects: false, rvprop: 'ids|content|timestamp' }));
    const content = config?.revisions?.[0]?.content;
    if (isApiFlagSet(config, 'missing') || typeof content !== 'string') {
        throw new Error(`設定ページを読み込めませんでした: ${configPage}`);
    }
    const currentRevId = config?.revisions?.[0]?.revid ?? null;
    const configEditOptions = { minor: true, bot: true, nocreate: true, watchlist: 'nochange' };
    if (config?.revisions?.[0]?.timestamp) configEditOptions.basetimestamp = config.revisions[0].timestamp;
    const state = loadState();
    const parser = titleParser(client);
    let resolved;
    try {
        const templates = await expandedTemplates(content, client, request, parser, currentRevId);
        resolved = resolveConfig(content, state, { templates, parser });
    } catch (error) {
        if (error.configurationReadError) throw error;
        // 抽出段階の構文エラーも、正常版があればその設定へ戻す。
        if (state.lastValidConfig?.items?.length) {
            resolved = { items: state.lastValidConfig.items, valid: false, error };
        } else {
            const errorHash = configHash(content);
            const alreadyReported = state.reportedConfigErrorHash === errorHash
                || (currentRevId !== null && state.reportedConfigErrorRevId === currentRevId);
            if (!alreadyReported) {
                const reportContent = closeBrokenMarkup(content, parser) + errorNotice(error, false);
                try {
                    const saved = await request(() => client.save(configPage, reportContent, 'Bot: 設定差分エラーを通知', configEditOptions));
                    state.reportedConfigErrorHash = configHash(reportContent);
                    state.reportedConfigErrorRevId = saved?.newrevid ?? currentRevId;
                    saveState(state);
                } catch (noticeError) {
                    log.error(taskId, `設定差分エラーの通知を書き込めませんでした: ${noticeError.message}`, true, { stack: noticeError.stack, nomail: true });
                }
            }
            log.error(taskId, `設定を解釈できず、前回正常設定もありません: ${error.message}`, true, { stack: error.stack, nomail: true });
            return;
        }
    }

    const now = clock();
    if (resolved.valid) {
        const isOwnRollback = currentRevId !== null && state.lastRollbackRevId === currentRevId && Boolean(state.lastValidConfig?.content);
        state.lastValidConfig = {
            items: resolved.items,
            content: isOwnRollback ? state.lastValidConfig.content : content,
            revisionId: isOwnRollback ? state.lastValidConfig.revisionId : currentRevId,
            confirmedAt: new Date(now).toISOString()
        };
        if (!isOwnRollback) delete state.lastRollbackRevId;
        delete state.reportedConfigErrorHash;
        delete state.reportedConfigErrorRevId;
    } else {
        const errorHash = configHash(content);
        const alreadyReported = state.reportedConfigErrorHash === errorHash
            || (currentRevId !== null && state.reportedConfigErrorRevId === currentRevId);
        if (!alreadyReported) {
            const notice = errorNotice(resolved.error);
            const rollbackContent = state.lastValidConfig.content.replace(/\s+$/, '');
            const reportContent = rollbackContent + notice;
            try {
                const saved = await request(() => client.save(configPage, reportContent, 'Bot: 設定差分エラーのため直前の正常設定へ差し戻し', configEditOptions));
                state.reportedConfigErrorHash = configHash(reportContent);
                state.reportedConfigErrorRevId = saved?.newrevid ?? currentRevId;
                if (saved?.newrevid !== undefined) state.lastRollbackRevId = saved.newrevid;
            } catch (error) {
                log.error(taskId, `設定差分エラーの通知を書き込めませんでした: ${error.message}`, true, { stack: error.stack, nomail: true });
            }
        }
        log.warning(taskId, `設定差分エラーのため前回正常設定を使用します: ${resolved.error.message}`);
    }

    saveState(state);
    if (!state.targets || typeof state.targets !== 'object') state.targets = {};
    const dueItems = resolved.items.filter(item => isDue(item, state, now));
    const purged = [];
    const failed = [];
    for (const batch of groupPurgeBatches(dueItems)) {
        const slots = batch.map(item => item.schedule ? dueSlot(item, state, now) : minuteKey(now));
        let results;
        try { results = await purge(batch, client, request); }
        catch (error) { results = batch.map(item => ({ item, success: false, error: error.message })); }
        for (const [index, { item, success, error }] of results.entries()) {
            if (!success) { failed.push({ title: item.title, error }); continue; }
            state.targets[item.id] = { lastRun: new Date(clock()).toISOString(), lastSlot: slots[index], title: item.title };
            purged.push(item.title);
        }
        saveState(state);
    }
    log.info(taskId, purged.length ? `キャッシュを破棄しました: ${purged.join(', ')}`
        : dueItems.length ? '成功した対象はありません' : '実行間隔に達した対象はありません');
    if (failed.length) {
        const failureMessage = failed.map(entry => `${entry.title}: ${entry.error}`).join(', ');
        const failureHash = crypto.createHash('sha256').update(failureMessage).digest('hex');
        const nomail = state.reportedFailureHash === failureHash;
        if (!nomail) {
            state.reportedFailureHash = failureHash;
            saveState(state);
        }
        log.error(taskId, `キャッシュ破棄失敗: ${failureMessage}`, false, nomail ? { nomail: true } : {});
    } else if (state.reportedFailureHash && dueItems.length) {
        delete state.reportedFailureHash;
        saveState(state);
    }
    return { purged, failed };
}

if (require.main === module) {
    main().then(result => { if (result?.failed?.length) process.exitCode = 1; }).catch(error => {
        console.error('キャッシュ破棄中にエラーが発生しました:', error);
        logger.error(taskId, `キャッシュ破棄中にエラーが発生しました: ${error.message}`, true, { stack: error.stack });
        process.exitCode = 1;
    });
}

module.exports = { configPage, parseConfig, validateItem, parseInterval, parseModes, cronMatches, isDue, purge, groupPurgeBatches, resolveConfig, main, expandedTemplates, titleParser };
