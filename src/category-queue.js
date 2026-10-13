/**
 * カテゴリキューの処理（プロジェクト:カテゴリ関連/キュー）
 *
 * 見出しが「Bot:」で始まり、まだ{{BOTREQ}}の付いていない節をコマンドとして実行し、
 * 結果を同じ節に返信する。構文は utils/categoryQueue/queue.js を参照。
 *
 * 使い方:
 *   node category-queue.js                 キューを処理する
 *   node category-queue.js --dry-run       編集せず、変更前後の本文を data/category-queue/dry-run/ に保存する
 *   node category-queue.js --only "原爆"    見出しにこの文字列を含む節だけ処理する
 *   node category-queue.js --max-pages 5   1コマンドあたりの対象ページ数を制限する（試験用。返信はしない）
 *   node category-queue.js --no-report     キューページに返信しない
 *   node category-queue.js --rollback <ID> 指定IDのコマンドで行った編集を取り消す
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Mwn } = require('mwn');
const { applyEditThrottle } = require('./utils/editThrottle');
const { allowBots } = require('./utils/parse.js');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require('./utils/logger');
const queue = require('./utils/categoryQueue/queue');
const { applyCategoryCommand, REDIRECT_CATEGORY_TEMPLATES, IMAGE_REQUEST_SUFFIX } = require('./utils/categoryQueue/replacer');
const { editSummary, formatReply, catLink } = require('./utils/categoryQueue/report');
const { QueueStatus } = require('./utils/categoryQueue/status');
const taskId = 'w-ja-nn5';
const nnversion = '__FILE_HASH__';

const QUEUE_PAGE = 'プロジェクト:カテゴリ関連/キュー';
// 本文（コメントを除く）が「動作中」のときだけ編集する
const EMERGENCY_STOP_PAGE = 'プロジェクト:カテゴリ関連/キュー/緊急停止';
const DATA_DIR = path.join(__dirname, 'data/category-queue');
const EDIT_CONFIG = { conflictRetries: 2, suppressNochangeWarning: true };

const bot = applyEditThrottle(new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/CategoryQueue [${nnversion}] (Toolforge)`,
    defaultParams: {
        assert: 'bot'
    }
}), { priority: 'low' });

// ==========================================
// 引数
// ==========================================
function parseArgs(argv) {
    const opts = { dryRun: false, only: null, maxPages: Infinity, report: true, rollback: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-report') opts.report = false;
        else if (a === '--only') opts.only = argv[++i];
        else if (a === '--max-pages') opts.maxPages = Number(argv[++i]);
        else if (a === '--rollback') opts.rollback = argv[++i];
        else throw new Error(`不明な引数です: ${a}`);
    }
    if (!(opts.maxPages > 0)) throw new Error('--max-pages には1以上の数を指定してください');
    if (opts.rollback !== null && !/^[\w-]+$/.test(opts.rollback || '')) throw new Error('--rollback にはIDを指定してください');
    // 途中までしか処理しないときは、完了と誤解される返信をしない
    if (opts.maxPages !== Infinity || opts.dryRun) opts.report = false;
    return opts;
}

// ==========================================
// 記録（取り消し用）
// ==========================================
function newCommandId() {
    const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `${d}-${crypto.randomBytes(3).toString('hex')}`;
}

function appendJsonl(file, entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

const operationsFile = id => path.join(DATA_DIR, 'operations', `${id}.jsonl`);

function readOperations(id) {
    const file = operationsFile(id);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function saveDryRun(id, title, before, after) {
    const dir = path.join(DATA_DIR, 'dry-run', id);
    fs.mkdirSync(dir, { recursive: true });
    const base = title.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(dir, `${base}.before.wiki`), before);
    fs.writeFileSync(path.join(dir, `${base}.after.wiki`), after);
}

// ==========================================
// Wikiへの問い合わせ
// ==========================================
async function isEmergencyStopped() {
    try {
        const page = await bot.read(EMERGENCY_STOP_PAGE);
        const content = page?.revisions?.[0]?.content;
        if (typeof content !== 'string') return true;
        return content.replace(/<!--[\s\S]*?-->/g, '').trim() !== '動作中';
    } catch (e) {
        logger.warning(taskId, `緊急停止ページを確認できませんでした: ${e.message}`);
        return true;
    }
}

async function pageExists(title) {
    const res = await bot.request({ action: 'query', titles: title, formatversion: 2 });
    const page = res.query.pages[0];
    return !page.missing && !page.invalid;
}

async function categoryInfo(name) {
    const res = await bot.request({ action: 'query', titles: `Category:${name}`, prop: 'categoryinfo', formatversion: 2 });
    return res.query.pages[0]?.categoryinfo || { size: 0, pages: 0, subcats: 0, files: 0 };
}

/**
 * 操作対象のページ一覧
 * カテゴリのメンバーに加え、{{リダイレクトの所属カテゴリ}}でカテゴリ名を書いているページを検索で拾う
 */
async function listTargets(command) {
    const titles = new Map();
    for await (const res of bot.continuedQueryGen({
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${command.from}`,
        cmnamespace: command.namespaces.join('|'),
        cmprop: 'title',
        cmlimit: 'max',
        formatversion: 2,
    })) {
        for (const m of res.query?.categorymembers || []) titles.set(m.title, true);
    }
    if (command.namespaces.includes(0)) {
        const search = `insource:"${command.from.replace(/"/g, '')}" hastemplate:"${REDIRECT_CATEGORY_TEMPLATES[0]}"`;
        for await (const res of bot.continuedQueryGen({
            action: 'query',
            list: 'search',
            srsearch: search,
            srnamespace: 0,
            srwhat: 'text',
            srinfo: '',
            srprop: '',
            srlimit: 'max',
            formatversion: 2,
        })) {
            for (const m of res.query?.search || []) titles.set(m.title, true);
        }
    }
    return [...titles.keys()];
}

// ==========================================
// コマンドの実行
// ==========================================
async function processPage(title, command, ctx) {
    if (ctx.dryRun) {
        const page = await bot.read(title);
        const content = page?.revisions?.[0]?.content;
        if (typeof content !== 'string') throw new Error('本文を取得できませんでした');
        if (!await allowBots(content, ctx.botUser)) throw new Error('{{bots}}/{{nobots}}により編集が拒否されています');
        const r = applyCategoryCommand(content, command);
        if (r.changed) saveDryRun(ctx.id, title, content, r.text);
        return { changed: r.changed, warnings: r.warnings };
    }

    let replaced = null;
    const res = await bot.edit(title, async rev => {
        if (!await allowBots(rev.content, ctx.botUser)) throw new Error('{{bots}}/{{nobots}}により編集が拒否されています');
        replaced = applyCategoryCommand(rev.content, command);
        if (!replaced.changed) return null;
        return { text: replaced.text, summary: ctx.summary, minor: true, watchlist: 'nochange' };
    }, { ...EDIT_CONFIG });

    if (!res || res.result === 'aborted' || res.nochange) return { changed: false, warnings: [] };
    if (res.result !== 'Success') throw new Error(`保存に失敗しました (${res.result})`);
    appendJsonl(operationsFile(ctx.id), {
        title: res.title || title,
        pageid: res.pageid,
        oldrevid: res.oldrevid,
        newrevid: res.newrevid,
        timestamp: res.newtimestamp,
    });
    return { changed: true, warnings: replaced.warnings, revid: res.newrevid, oldrevid: res.oldrevid };
}

/**
 * @returns {Promise<{status: string, message: string, id?: string, result?: object, notes?: string[], stopped?: boolean, record?: object}>}
 */
async function executeSection(section, opts) {
    const { status } = opts;
    const parsed = queue.parseCommandHeading(section.heading);
    if (!parsed.ok) return { status: '不受理', message: parsed.error };
    const command = parsed.command;

    const discussionLink = queue.findDiscussionLink(section.body);
    if (!discussionLink) {
        return { status: '不受理', message: '議論場所へのリンクがありません。申請文に議論場所へのリンクを記載してください' };
    }

    // {{画像提供依頼}}はノートページに貼られるため、全名前空間指定ではノートも対象にする
    if (command.scope === null && command.from.endsWith(IMAGE_REQUEST_SUFFIX)) command.namespaces.push(1);

    for (const to of command.to) {
        if (!await pageExists(`Category:${to}`)) {
            return { status: '不可能', message: `${catLink(to)}が存在しません。先にカテゴリを作成（または移動）してください` };
        }
    }

    const targets = (await listTargets(command)).slice(0, opts.maxPages);
    if (targets.length === 0) {
        return { status: '不可能', message: 'カテゴリに操作対象となる所属記事または所属カテゴリがありませんでした' };
    }

    const id = newCommandId();
    const ctx = { id, dryRun: opts.dryRun, botUser: opts.botUser, summary: editSummary(command, discussionLink, id) };
    const startedAt = new Date().toISOString();
    appendJsonl(path.join(DATA_DIR, 'commands.jsonl'), {
        id, heading: section.heading, command, discussionLink, dryRun: opts.dryRun, startedAt, targets: targets.length,
    });
    status.commandStart({ id, command, discussionLink, total: targets.length });
    logger.info(taskId, `[${id}] ${section.heading}: 対象${targets.length}件${opts.dryRun ? '（dry-run）' : ''}`, !opts.dryRun);

    const result = { edited: [], unchanged: [], warnings: [], errors: [] };
    let stopped = false;
    for (const title of targets) {
        if (!opts.dryRun && await isEmergencyStopped()) {
            stopped = true;
            break;
        }
        status.pageStart(title);
        try {
            const r = await processPage(title, command, ctx);
            (r.changed ? result.edited : result.unchanged).push(title);
            if (r.warnings.length > 0) result.warnings.push({ title, messages: r.warnings });
            status.pageDone({ title, result: r.changed ? 'edited' : 'unchanged', warnings: r.warnings, revid: r.revid, oldrevid: r.oldrevid });
        } catch (e) {
            result.errors.push({ title, message: e.message || String(e) });
            logger.warning(taskId, `[${id}] ${title}: ${e.message || e}`);
            status.pageDone({ title, result: 'error', message: e.message || String(e) });
        }
    }

    const summaryLine = `編集${result.edited.length}件 / 変更なし${result.unchanged.length}件 / エラー${result.errors.length}件`;
    logger.info(taskId, `[${id}] ${stopped ? '緊急停止' : '終了'}: ${summaryLine}`, !opts.dryRun);
    const record = {
        id, heading: section.heading, type: command.type, from: command.from, to: command.to, discussionLink,
        dryRun: opts.dryRun, startedAt, total: targets.length,
        edited: result.edited.length, unchanged: result.unchanged.length, warnings: result.warnings.length, errors: result.errors.length,
    };
    if (stopped) return { stopped: true, id, result, record: { ...record, status: '緊急停止' } };

    const notes = [];
    if (command.type === 'reassign' && !opts.dryRun) {
        const info = await categoryInfo(command.from);
        if (info.size === 0) notes.push(`${catLink(command.from)}は空になりました。`);
        else notes.push(`${catLink(command.from)}にはまだ${info.size}件が所属しています。`);
    }
    return {
        status: '完了',
        id,
        message: `${result.edited.length}件の編集を行いました。`,
        result,
        notes,
        record: { ...record, status: '完了' },
    };
}

async function postReply(section, reply) {
    const res = await bot.edit(QUEUE_PAGE, rev => {
        const text = queue.insertReply(rev.content, section, reply);
        if (text === null) throw new Error(`節「${section.heading}」が見つかりません（除去・過去ログ化された可能性）`);
        return { text, summary: `Bot: /* ${section.heading.replace(/\[\[:?([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')} */ キューの処理結果`, nocreate: true };
    }, { ...EDIT_CONFIG });
    if (res?.result !== 'Success') throw new Error(`返信を保存できませんでした (${res?.result})`);
}

/** @returns {Promise<string>} 終わり方（実行状況に出す） */
async function runQueue(opts) {
    const { status } = opts;
    const page = await bot.read(QUEUE_PAGE);
    const content = page?.revisions?.[0]?.content;
    if (typeof content !== 'string') throw new Error(`${QUEUE_PAGE} を取得できませんでした`);

    const sections = queue.parseQueueSections(content)
        .filter(s => queue.isBotHeading(s.heading))
        .filter(s => !queue.isHandled(s))
        .filter(s => !opts.only || s.heading.includes(opts.only));
    logger.info(taskId, `未処理のキュー: ${sections.length}件`);
    status.setSections(sections);
    if (sections.length === 0) return '未処理のキューなし';

    for (const [index, section] of sections.entries()) {
        status.sectionStart(index);
        let outcome;
        try {
            outcome = await executeSection(section, opts);
        } catch (e) {
            logger.error(taskId, `節「${section.heading}」の処理中にエラー: ${e.message}`, false, { stack: e.stack });
            outcome = { status: '中止', message: 'Botの内部エラーにより処理を中止しました。運用者が確認します。' };
        }
        status.sectionEnd(index, outcome, outcome.record);
        if (outcome.stopped) {
            logger.warning(taskId, '緊急停止しました。残りのキューは次回処理します。', true);
            return '緊急停止';
        }

        const reply = formatReply(outcome);
        if (!opts.report) {
            console.log(`--- 返信（未投稿）: ${section.heading}\n${reply}\n`);
            continue;
        }
        try {
            await postReply(section, reply);
        } catch (e) {
            logger.error(taskId, `返信に失敗: ${section.heading}: ${e.message}`, false, { stack: e.stack });
        }
    }
    return '完了';
}

// ==========================================
// 取り消し
// ==========================================
async function rollback(id, opts) {
    const { status } = opts;
    const operations = readOperations(id);
    if (!operations) throw new Error(`ID ${id} の編集記録がありません (${operationsFile(id)})`);
    logger.info(taskId, `[${id}] 取り消し開始: ${operations.length}件${opts.dryRun ? '（dry-run）' : ''}`, !opts.dryRun);
    status.setSections([{ heading: `取り消し (ID: ${id})` }]);
    status.sectionStart(0);
    status.commandStart({ id, command: { type: 'rollback', from: null, to: [], namespaces: [] }, discussionLink: null, total: operations.length });
    let done = 0;
    for (const op of [...operations].reverse()) {
        if (opts.dryRun) {
            console.log(`取り消し予定: ${op.title} (rev ${op.newrevid})`);
            continue;
        }
        status.pageStart(op.title);
        try {
            const res = await bot.request({
                action: 'edit',
                pageid: op.pageid,
                undo: op.newrevid,
                undoafter: op.oldrevid,
                summary: `Bot: キュー処理 (ID: ${id}) の取り消し`,
                nocreate: true,
                bot: true,
                token: bot.csrfToken,
                formatversion: 2,
            });
            if (res.edit?.result === 'Success') {
                done++;
                status.pageDone({ title: op.title, result: res.edit.nochange ? 'unchanged' : 'edited', revid: res.edit.newrevid, oldrevid: res.edit.oldrevid });
            } else {
                status.pageDone({ title: op.title, result: 'error', message: `取り消しできませんでした (${res.edit?.result})` });
            }
        } catch (e) {
            logger.warning(taskId, `[${id}] 取り消し失敗: ${op.title}: ${e.message}`);
            status.pageDone({ title: op.title, result: 'error', message: e.message });
        }
    }
    status.sectionEnd(0, { status: '完了', id, message: `${done}/${operations.length}件を取り消しました` });
    logger.info(taskId, `[${id}] 取り消し終了: ${done}/${operations.length}件`, !opts.dryRun);
    return '完了';
}

// ==========================================
// main
// ==========================================
(async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.dryRun) await checkTaskStatusAndExit(taskId);

    const status = new QueueStatus(DATA_DIR, opts.rollback ? 'rollback' : opts.dryRun ? 'dry-run' : 'normal');
    if (!status.acquireLock()) {
        logger.warning(taskId, '別のキュー処理が実行中のため終了します');
        return;
    }
    opts.status = status;
    let reason = 'エラー';
    try {
        status.save();
        await bot.login();
        const userinfo = await bot.userinfo();
        opts.botUser = userinfo.name;
        logger.success(taskId, `ログイン成功 (${opts.botUser})`);

        if (!opts.dryRun && await isEmergencyStopped()) {
            logger.info(taskId, `${EMERGENCY_STOP_PAGE} が「動作中」ではないため終了します`);
            reason = '緊急停止ページが「動作中」ではない';
            return;
        }

        reason = opts.rollback ? await rollback(opts.rollback, opts) : await runQueue(opts);
    } finally {
        status.finish(reason);
        status.releaseLock();
    }
})().catch(e => {
    logger.error(taskId, `実行時エラー: ${e.message}`, false, { stack: e.stack });
    process.exitCode = 1;
});
