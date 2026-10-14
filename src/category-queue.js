/**
 * カテゴリキューの処理（プロジェクト:カテゴリ関連/キュー）
 *
 * 見出しが「Bot:」で始まり、まだ{{BOTREQ}}の付いていない節をコマンドとして実行し、
 * 結果を同じ節に返信する。構文は utils/categoryQueue/queue.js を参照。
 *
 * 使い方:
 *   node category-queue.js                 キューを処理する
 *   node category-queue.js --dry-run       編集せず、変更前後の本文を data/category-queue/dry-run/ に保存する
 *   node category-queue.js --only "Name1"    見出しにこの文字列を含む節だけ処理する
 *   node category-queue.js --max-pages 5   1コマンドあたりの対象ページ数を制限する（試験用。返信はしない）
 *   node category-queue.js --no-report     キューページに返信しない
 *   node category-queue.js --rollback <ID> 指定IDのコマンドで行った編集を取り消す
 *   node category-queue.js --site test     test.wikipedia.org の試験用キューで動かす（scripts/queue-test-setup.js で用意）
 *   node category-queue.js --queue-page <ページ名> --stop-page <ページ名>  キューページ・緊急停止ページを変える
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
const { editSummary, formatReply, formatStart, catLink } = require('./utils/categoryQueue/report');
const { CommandRecord, readCommandRecord, reopenCommandRecord } = require('./utils/categoryQueue/record');
const { identifyRequester } = require('./utils/categoryQueue/requester');
const { QueueStatus } = require('./utils/categoryQueue/status');
const taskId = 'w-ja-nn5';
const nnversion = '__FILE_HASH__';

/**
 * 動かすウィキ（--site）
 * - ja:   本番。日本語版ウィキペディアのキュー
 * - test: 試験。test.wikipedia.org の利用者ページにキューを置き、試験用のカテゴリ・記事で実際に編集する
 *         （scripts/queue-test-setup.js で用意する。Bot フラグが無いので assert=bot は付けず、メタの稼働スイッチも見ない）
 * どちらも --queue-page / --stop-page でページを変えられる（例: jawp の利用者サンドボックスにキューを置いて --dry-run）
 */
const SITES = {
    ja: {
        apiUrl: 'https://ja.wikipedia.org/w/api.php',
        queuePage: 'プロジェクト:カテゴリ関連/キュー',
        stopPage: 'プロジェクト:カテゴリ関連/キュー/緊急停止',
        dataDir: 'data/category-queue',
        assertBot: true,
        taskSwitch: true,
    },
    test: {
        apiUrl: 'https://test.wikipedia.org/w/api.php',
        queuePage: 'User:NanonaBot2/カテゴリキュー',
        stopPage: 'User:NanonaBot2/カテゴリキュー/緊急停止',
        dataDir: 'data/category-queue-test',
        assertBot: false,
        taskSwitch: false,
    },
};

/** --site / --queue-page / --stop-page を、Bot を作る前に読む */
function resolveSite(argv) {
    const value = name => {
        const i = argv.indexOf(name);
        return i === -1 ? null : argv[i + 1];
    };
    const name = value('--site') || 'ja';
    if (!SITES[name]) throw new Error(`--site は ${Object.keys(SITES).join(' / ')} のどれかです`);
    return { name, ...SITES[name], queuePage: value('--queue-page') || SITES[name].queuePage, stopPage: value('--stop-page') || SITES[name].stopPage };
}

const SITE = resolveSite(process.argv.slice(2));
const QUEUE_PAGE = SITE.queuePage;
// 本文（コメントを除く）が「動作中」のときだけ編集する
const EMERGENCY_STOP_PAGE = SITE.stopPage;
const DATA_DIR = path.join(__dirname, SITE.dataDir);
const EDIT_CONFIG = { conflictRetries: 2, suppressNochangeWarning: true };
// 編集中にキューページを読み直し、節の見出しが変わっていないか確かめる間隔
// （環境変数 CATEGORY_QUEUE_CHECK_MS で変えられる。試験用）
const SECTION_CHECK_INTERVAL_MS = Number(process.env.CATEGORY_QUEUE_CHECK_MS) || 2 * 60 * 1000;

const bot = applyEditThrottle(new Mwn({
    apiUrl: SITE.apiUrl,
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/CategoryQueue [${nnversion}] (Toolforge)`,
    defaultParams: SITE.assertBot ? { assert: 'bot' } : {},
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
        else if (a === '--site' || a === '--queue-page' || a === '--stop-page') i++; // resolveSite で読み済み
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
    // キューページ・緊急停止ページは対象にしない（見出しにコロンなしの [[Category:…]] を書かれると、
    // キューページ自体がそのカテゴリに入る。書き換えると依頼の見出しが変わってしまう）
    const own = new Set([QUEUE_PAGE, EMERGENCY_STOP_PAGE].map(t => t.replace(/_/g, ' ')));
    return [...titles.keys()].filter(t => !own.has(t.replace(/_/g, ' ')));
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

    // 書き換えなかったページでも、警告（{{リダイレクトの所属カテゴリ}}の件数超過など）は要確認として残す
    if (!res || res.result === 'aborted' || res.nochange) return { changed: false, warnings: replaced ? replaced.warnings : [] };
    if (res.result !== 'Success') throw new Error(`保存に失敗しました (${res.result})`);
    const result = { changed: true, warnings: replaced.warnings, revid: res.newrevid, oldrevid: res.oldrevid };
    try {
        appendJsonl(operationsFile(ctx.id), {
            title: res.title || title,
            pageid: res.pageid,
            oldrevid: res.oldrevid,
            newrevid: res.newrevid,
            timestamp: res.newtimestamp,
        });
    } catch (e) {
        // 編集は済んでいるのに取り消し用の記録が残らない。普通のエラーとは分け、呼び出し側でコマンドを止める
        result.recordError = `取り消し用の記録を書き出せませんでした（${e.message}）。版 ${res.newrevid}`;
    }
    return result;
}

/**
 * 1節を実行する。経過と結果は record（コマンドごとの記録、Web の詳細画面）に残す
 *
 * 編集を始める前に、節に着手の印「{{BOTREQ|着手}} (ID: …)」を返信する。以後はこの ID で節を探すので、
 * 他の節の追加・過去ログ化や見出しの書き換えがあっても、返信先を取り違えない。
 * 返信しない実行（dry-run など）では印を付けない。
 *
 * @param {object} section 読み込んだときの節
 * @param {object} opts
 * @param {CommandRecord} record
 * @param {boolean} resumed 着手済みのコマンドの再開か
 * @returns {Promise<{status: string, message?: string, counts?: object, notes?: string[], stopped?: boolean, skipped?: boolean}>}
 */
async function executeSection(section, opts, record, resumed) {
    const { status } = opts;
    const id = record.id;
    const log = (level, message, isPublic = false) => {
        record.log(level, message);
        logger[level === 'warning' ? 'warning' : 'info'](taskId, `[${id}] ${message}`, isPublic && !opts.dryRun);
    };

    // 再開: 中断している間に見出しが変わっていたら、別の操作を同じ ID で実行しないよう、何よりも先に中止する
    if (resumed && record.data.heading !== section.heading) {
        return { status: '中止', message: `中断している間に見出しが変更されたため中止しました（着手時: ${record.data.heading}）` };
    }

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

    if (resumed) {
        log('info', '着手済みのコマンドを再開します', true);
    } else if (opts.report) {
        const start = await postStart(section, id);
        if (!start.ok) return { status: '見送り', message: start.reason, skipped: true };
        record.markStarted();
    }

    // 依頼者と依頼日時（キューページの履歴から。失敗しても処理は続ける）
    if (!record.data.request) {
        try {
            const request = await identifyRequester(bot, QUEUE_PAGE, section);
            record.setRequest(request);
            if (!request.traced) log('warning', '履歴から依頼者を特定できませんでした（古い版までさかのぼれない）');
            else if (request.signerMatches === false) log('warning', `署名（${request.signer}）と見出しを書き込んだ利用者（${request.requester}）が一致しません`);
        } catch (e) {
            log('warning', `依頼者を調べられませんでした: ${e.message}`);
        }
    }

    const targets = (await listTargets(command)).slice(0, opts.maxPages);
    const c = record.data.counts;
    // 再開のときは、前回までに処理したページの数も対象に含める（処理済みのページは移動元から外れている）
    record.setCommand(command, discussionLink, c.edited + c.unchanged + c.errors + targets.length);
    if (targets.length === 0 && !resumed) {
        return { status: '不可能', message: 'カテゴリに操作対象となる所属記事または所属カテゴリがありませんでした' };
    }

    const ctx = { id, dryRun: opts.dryRun, botUser: opts.botUser, summary: editSummary(command, discussionLink, id) };
    status.commandStart({ id, command, discussionLink, total: targets.length, request: record.data.request });
    log('info', `${section.heading}: 対象${targets.length}件${opts.dryRun ? '（dry-run）' : ''}`, true);

    let stopped = false;
    let aborted = null;
    let recordFailed = false;
    let lastCheck = Date.now();
    let missingLogged = false;
    for (const title of targets) {
        if (!opts.dryRun && await isEmergencyStopped()) {
            stopped = true;
            break;
        }
        // 長く止まっていた間に実行中の印が古いとみなされ、他の実行に取られていたら、二重に編集しないよう止める
        if (status.lockLost()) {
            log('warning', '実行中の印を他の実行に取られたため止めます');
            stopped = true;
            break;
        }
        // 着手の印のある節を定期的に確かめる。見出しの変更（「Bot:」を外す異議を含む）や他の作業者の対応があれば中止する。
        // 節が過去ログ化されただけなら依頼は有効なので続け、返信できなければ記録する
        if (record.data.started && Date.now() - lastCheck >= SECTION_CHECK_INTERVAL_MS) {
            lastCheck = Date.now();
            const check = await checkStartedSection(section, id);
            if (check.missing) {
                if (!missingLogged) log('warning', `${check.reason}。処理は続けます`);
                missingLogged = true;
            } else if (!check.ok) {
                aborted = `実行中に節が変わったため中止しました（${check.reason}）`;
                break;
            }
        }
        status.pageStart(title);
        let ev;
        let recordError = null;
        try {
            const r = await processPage(title, command, ctx);
            ev = { title, result: r.changed ? 'edited' : 'unchanged', warnings: r.warnings, revid: r.revid, oldrevid: r.oldrevid };
            recordError = r.recordError || null;
        } catch (e) {
            ev = { title, result: 'error', message: e.message || String(e) };
            log('warning', `${title}: ${ev.message}`);
        }
        if (recordError) ev.message = recordError;
        record.page(ev);
        status.pageDone(ev);
        if (recordError) {
            // 編集は成功したが取り消しの記録が残らなかった。これ以上編集すると取り消せない編集が増えるので止める
            record.log('error', `${title}: ${recordError}`);
            logger.error(taskId, `[${id}] ${title}: ${recordError}`, false);
            aborted = '取り消し用の記録を書き出せなかったため中止しました。運用者が確認します';
            recordFailed = true;
            break;
        }
    }

    log(aborted ? 'warning' : 'info', `${stopped ? '緊急停止' : aborted ? `中止（${aborted}）` : '終了'}: 編集${c.edited}件 / 変更なし${c.unchanged}件 / 要確認${c.warnings}件 / エラー${c.errors}件`, true);
    if (stopped) return { stopped: true };
    if (aborted) return { status: '中止', message: aborted, counts: { ...c }, fatal: recordFailed };

    const notes = [];
    if (command.type === 'reassign' && !opts.dryRun) {
        const info = await categoryInfo(command.from);
        if (info.size === 0) notes.push(`${catLink(command.from)}は空になりました。`);
        else notes.push(`${catLink(command.from)}にはまだ${info.size}件が所属しています。`);
    }
    return { status: '完了', counts: { ...c }, notes };
}

async function readQueuePage() {
    const page = await bot.read(QUEUE_PAGE);
    const content = page?.revisions?.[0]?.content;
    if (typeof content !== 'string') throw new Error(`${QUEUE_PAGE} を取得できませんでした`);
    return content;
}

const headingSummary = heading => heading.replace(/\[\[:?([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1');

/**
 * 着手の印を返信する。最新版で節を（見出し行と依頼文で）探し、まだ誰も対応していないことを確かめて、
 * 同じ編集で書き込む（間にキューページが変われば編集競合になり、最新版でやり直す）
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
async function postStart(section, id) {
    let reason = null;
    const res = await bot.edit(QUEUE_PAGE, rev => {
        reason = null;
        const found = queue.findByRequest(rev.content, section);
        if (found.error === 'missing') reason = '節が見つかりません（見出しの変更・過去ログ化・除去の可能性）';
        else if (found.error === 'ambiguous') reason = '同じ見出しと依頼文の節が複数あり、どれか特定できません';
        else if (queue.isHandled(found.section) || queue.startedId(found.section)) reason = '他の作業者が{{BOTREQ}}を付けました';
        if (reason) return null;
        return {
            text: queue.insertReply(rev.content, found.section, formatStart(id)),
            summary: `Bot: /* ${headingSummary(section.heading)} */ キューの処理に着手`,
            nocreate: true,
        };
    }, { ...EDIT_CONFIG });
    if (reason) return { ok: false, reason };
    if (res?.result !== 'Success') throw new Error(`着手の返信を保存できませんでした (${res?.result})`);
    return { ok: true };
}

/**
 * 着手済みの節を ID で探し、まだ続けてよいか確かめる
 * @returns {Promise<{ok: true} | {ok: false, reason: string, missing?: boolean}>}
 */
async function checkStartedSection(section, id) {
    const found = queue.findById(await readQueuePage(), id);
    if (found.error === 'missing') return { ok: false, missing: true, reason: '節が見つかりません（過去ログ化・除去された可能性）' };
    if (found.error === 'ambiguous') return { ok: false, reason: '同じ ID の着手の印が複数あります' };
    if (found.section.headingLine !== section.headingLine) return { ok: false, reason: `見出しが変更されました（現在: ${found.section.heading}）` };
    if (queue.isHandled(found.section)) return { ok: false, reason: '他の作業者が{{BOTREQ}}を付けました' };
    return { ok: true };
}

/**
 * 結果を返信する。着手済みなら ID で、そうでなければ（不受理・不可能など）見出し行と依頼文で節を探す
 */
async function postReply(section, id, started, reply) {
    const res = await bot.edit(QUEUE_PAGE, rev => {
        const found = started ? queue.findById(rev.content, id) : queue.findByRequest(rev.content, section);
        if (found.error) throw new Error('返信先の節が見つかりません（過去ログ化・除去された、または特定できない）');
        // 着手していない節（不受理・不可能）は、選んでから返信するまでに他の作業者が対応したかもしれない
        if (!started && queue.isHandled(found.section)) throw new Error('他の作業者が{{BOTREQ}}を付けたため返信しませんでした');
        return { text: queue.insertReply(rev.content, found.section, reply), summary: `Bot: /* ${headingSummary(section.heading)} */ キューの処理結果`, nocreate: true };
    }, { ...EDIT_CONFIG });
    if (res?.result !== 'Success') throw new Error(`返信を保存できませんでした (${res?.result})`);
}

/** 返信して、結果（投稿できたか・できなかった理由）を記録に残す */
async function replyAndRecord(section, record, outcome, opts) {
    const reply = formatReply(outcome);
    if (!opts.report) {
        console.log(`--- 返信（未投稿）: ${section.heading}\n${reply}\n`);
        record.setReply(reply, false, '返信しない設定で実行した（dry-run など）');
        return;
    }
    try {
        await postReply(section, record.id, record.data.started, reply);
        record.setReply(reply, true);
    } catch (e) {
        // 返信できなくても編集は済んでいる。返信文を残し、次の実行で再送する（Web にも出す）
        logger.error(taskId, `[${record.id}] 返信に失敗: ${section.heading}: ${e.message}`, false, { stack: e.stack });
        record.log('error', `キューページに返信できませんでした: ${e.message}`);
        record.setReply(reply, false, e.message);
    }
}

/**
 * 処理する節を選ぶ
 * - {{BOTREQ}} が無い節 → 新しく実行する
 * - この Bot の着手の印だけがあり、手元の記録が終わっていない（緊急停止・異常終了）→ 同じ ID で再開する
 * - 着手の印があり、記録は終わっているが返信を投稿できていない → 返信だけ再送する
 * - それ以外（他の作業者の {{BOTREQ}}、手元に記録の無い印）→ 何もしない
 */
function selectWork(content, opts) {
    const work = [];
    for (const s of queue.parseQueueSections(content)) {
        if (!queue.isBotHeading(s.heading) || queue.isHandled(s)) continue;
        if (opts.only && !s.heading.includes(opts.only)) continue;
        const id = queue.startedId(s);
        if (!id) {
            work.push({ kind: 'new', section: s });
            continue;
        }
        const found = readCommandRecord(DATA_DIR, id);
        if (!found) continue;
        const r = found.record;
        if (r.state !== 'done') work.push({ kind: 'resume', section: s, id });
        else if (r.reply && !r.reply.posted && opts.report) work.push({ kind: 'resend', section: s, id });
    }
    return work;
}

/** @returns {Promise<string>} 終わり方（実行状況に出す） */
async function runQueue(opts) {
    const { status } = opts;
    const work = selectWork(await readQueuePage(), opts);
    logger.info(taskId, `処理するキュー: ${work.length}件（新規${work.filter(w => w.kind === 'new').length}・再開${work.filter(w => w.kind === 'resume').length}・返信の再送${work.filter(w => w.kind === 'resend').length}）`);
    status.setSections(work.map(w => w.section));
    if (work.length === 0) return '未処理のキューなし';

    for (const [index, { kind, section, id }] of work.entries()) {
        status.sectionStart(index);

        if (kind === 'resend') {
            // 開き直すと状態が「実行中」になるので、終わったときの状態を先に読んでおく
            const done = readCommandRecord(DATA_DIR, id).record;
            const record = reopenCommandRecord(DATA_DIR, id, opts);
            try {
                await postReply(section, id, true, done.reply.text);
                record.setReply(done.reply.text, true);
                record.log('info', '返信を再送しました');
            } catch (e) {
                record.log('error', `返信の再送に失敗しました: ${e.message}`);
                record.setReply(done.reply.text, false, e.message);
            }
            record.finish({ status: done.status, message: done.message, notes: done.notes });
            status.sectionEnd(index, { status: done.status, id, message: '返信の再送' }, null); // 履歴には終わったときに書いてある
            continue;
        }

        // 不受理・不可能も含め、処理した節には ID を振って記録する（再開なら同じ ID の記録を開く）
        const resumed = kind === 'resume';
        const record = resumed ? reopenCommandRecord(DATA_DIR, id, opts) : new CommandRecord(DATA_DIR, newCommandId(), section, opts);
        let outcome;
        try {
            outcome = await executeSection(section, opts, record, resumed);
        } catch (e) {
            logger.error(taskId, `節「${section.heading}」の処理中にエラー: ${e.message}`, false, { stack: e.stack });
            record.log('error', `内部エラー: ${e.message}`);
            outcome = { status: '中止', message: 'Botの内部エラーにより処理を中止しました。運用者が確認します' };
        }
        outcome.id = record.id;

        if (outcome.stopped) {
            record.finish(outcome);
            status.sectionEnd(index, outcome, null); // 再開して終わったときに履歴へ書く
            logger.warning(taskId, '緊急停止しました。着手済みの節は次回同じ ID で再開します。', true);
            return '緊急停止';
        }
        if (outcome.skipped) {
            // 着手する直前に節が変わっていた（過去ログ化・見出しの変更・他の作業者の対応）。返信しない
            logger.warning(taskId, `[${record.id}] 見送り: ${section.heading}: ${outcome.message}`);
            record.log('warning', `実行を見送りました: ${outcome.message}`);
        } else {
            await replyAndRecord(section, record, outcome, opts);
        }
        record.finish(outcome);
        status.sectionEnd(index, outcome, record.summary());
        if (outcome.fatal) {
            logger.error(taskId, '取り消し用の記録を書き出せないため、残りのキューを処理せずに終了します', false);
            return '記録の失敗';
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
    // 稼働スイッチ（メタ）は本番の運用のためのもの。試験用のウィキでは見ない
    if (!opts.dryRun && SITE.taskSwitch) await checkTaskStatusAndExit(taskId);
    logger.info(taskId, `対象: ${SITE.name}（${new URL(SITE.apiUrl).hostname}） キュー: ${QUEUE_PAGE}`);

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
