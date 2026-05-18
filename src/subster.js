const fs = require('fs').promises;
const path = require('path');
const mysql = require('mysql2/promise');
const { Mwn } = require('mwn');
const WikitextParser = require('./utils/parse2.js');
const { allowBots } = require('./utils/parse.js');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require("./utils/logger");
const taskId = 'w-ja-nn4';
const nnversion = '__FILE_HASH__';

const bot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_NBOT1_USERNAME || process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT1_PASSWORD || process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/TemplateSubster [${nnversion}] (Toolforge)`,
    defaultParams: {
        assert: 'bot'
    }
});
const parser = new WikitextParser();

let namespaceMap = {};
let jawpconfig;

/**
 * Yesno関数
 * @param {any} val - 判定する引数
 * @returns {boolean} - 判定結果 (true または false)
 */
function Yesno(val) {
    if (val === undefined || val === '¬') return false;
    const strVal = String(val);
    if (strVal.trim() === '') return false;
    const lowerVal = strVal.toLowerCase();
    if (['no', 'n', 'false', '0'].includes(lowerVal)) return false;
    if (['yes', 'y', 'true', '1'].includes(lowerVal)) return true;
    return true;
}

// ==========================================
// ページ名
// ==========================================
function getFullTitle(namespaceId, title) {
    if (namespaceId === 0) return title;
    const namespaceName = namespaceMap[namespaceId] ? namespaceMap[namespaceId].name : '';
    return namespaceName ? `${namespaceName}:${title}` : title;
}


// ==========================================
// Templates取得
// ==========================================
async function getTemplatesInCategory() {

    let connection;
    let templates = [];
    let formattedRows = [];
    let nolimitSet;
    let nsPlaceholders;
    let queryParams;
    try {
        const jawpconfig0 = await bot.read('利用者:NanonaBot2/w-ja-nn4/data.json');
        jawpconfig = JSON.parse(jawpconfig0.revisions?.[0]?.content || '{}');
        if (!jawpconfig || !jawpconfig.subster) {
            throw new Error('設定ファイルが見つかりませんでした');
        }
        if (typeof jawpconfig.subster.targetCategory !== 'string' || jawpconfig.subster.targetCategory.trim() === '') {
            throw new Error('設定エラー: TARGET_CATEGORY は空ではない文字列である必要があります。');
        }else{
            jawpconfig.subster.targetCategory = jawpconfig.subster.targetCategory.replace(/ /g, '_');
        }
        if (!Array.isArray(jawpconfig.subster.targetNamespace) || jawpconfig.subster.targetNamespace.length === 0 || !jawpconfig.subster.targetNamespace.every(ns => Number.isInteger(ns) && ns >= 0)) {
            throw new Error('設定エラー: jawpconfig.subster.targetNamespace は0以上の整数の配列である必要があります（例: [0, 1]）。');
        }
        if (!Number.isInteger(jawpconfig.subster['sql max']) || jawpconfig.subster['sql max'] < 1) {
            throw new Error('設定エラー: jawpconfig.subster["sql max"] は1以上の整数である必要があります。');
        }
        if (!Number.isInteger(jawpconfig.subster['max transclusions']) || jawpconfig.subster['max transclusions'] < 1) {
            throw new Error('設定エラー: jawpconfig.subster["max transclusions"] は1以上の整数である必要があります。');
        }
        if (jawpconfig.Templates !== undefined) {
            if (!Array.isArray(jawpconfig.Templates)) {
                throw new Error('設定エラー: Templates は文字列の配列である必要があります。');
            }
            const invalidTemplateIndex = jawpconfig.Templates.findIndex(t => typeof t !== 'string');
            if (invalidTemplateIndex !== -1) {
                throw new Error(`設定エラー: Templates[${invalidTemplateIndex}] は文字列である必要があります。`);
            }
        }
        nolimitSet = new Set((jawpconfig.Templates || []).map(t => t.replace(/ /g, '_')));
        nsPlaceholders = jawpconfig.subster.targetNamespace.map(() => '?').join(', ');
        queryParams = [jawpconfig.subster.targetCategory, ...jawpconfig.subster.targetNamespace, jawpconfig.subster['sql max']];
    } catch (error) {
        error.message = `設定ファイルの読み込みに失敗しました: ${error.message}`;
        logger.error(taskId, error.message);
        throw error;
    }

    try {
        let config = {
            host: 'jawiki.analytics.db.svc.wikimedia.cloud',
            port: 3306,
            database: 'jawiki_p',
            charset: 'utf8mb4',
            connectTimeout: 120000,
            idleTimeout: 300000,
            multipleStatements: false
        };

        if (process.env.TOOL_REPLICA_USER && process.env.TOOL_REPLICA_PASSWORD) {
            config.user = process.env.TOOL_REPLICA_USER;
            config.password = process.env.TOOL_REPLICA_PASSWORD;
        } else {
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            const configPath = path.join(homeDir, 'replica.my.cnf');
            const configContent = await fs.readFile(configPath, 'utf8');
            const lines = configContent.split('\n');

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('user=')) {
                    config.user = trimmedLine.split('=')[1].trim();
                } else if (trimmedLine.startsWith('password=')) {
                    const parts = trimmedLine.split('=');
                    config.password = parts.slice(1).join('=').trim();
                }
            }

            if (!config.user || !config.password) {
                throw new Error('認証情報を取得できませんでした');
            }
        }

        connection = await mysql.createConnection(config);

        const query = `
            SELECT 
                p1.page_namespace, 
                p1.page_title, 
                COUNT(DISTINCT tl_from) AS ct
            FROM categorylinks
            JOIN page AS p1 
                ON cl_from = p1.page_id
            JOIN linktarget 
                ON lt_namespace = p1.page_namespace AND lt_title = p1.page_title
            JOIN templatelinks 
                ON tl_target_id = lt_id
            JOIN page AS p2 
                ON p2.page_id = tl_from
            WHERE 
                cl_target_id = (
                    SELECT lt_id 
                    FROM linktarget 
                    WHERE lt_namespace = 14 
                      AND lt_title = ?
                )
                AND p2.page_namespace IN (${nsPlaceholders})
                AND NOT (
                    p2.page_namespace = p1.page_namespace AND p2.page_title = p1.page_title
                    OR p2.page_namespace = p1.page_namespace AND p2.page_title = CONCAT(p1.page_title, '/doc')
                    OR p2.page_namespace = (p1.page_namespace | 1) AND p2.page_title = p1.page_title
                )
            GROUP BY 
                p1.page_namespace, 
                p1.page_title
            HAVING 
                ct >= 1 AND ct <= ?
            ORDER BY
                ct DESC;
        `;

        const [rows] = await connection.execute(query, queryParams);
        formattedRows = rows.map(row => ({
            namespace: row.page_namespace,
            title: Buffer.isBuffer(row.page_title) ? row.page_title.toString('utf8') : String(row.page_title),
            count: row.ct
        }));
        templates = new Set(formattedRows.filter(row => row.count <= jawpconfig.subster['max transclusions'] || nolimitSet.has(getFullTitle(row.namespace, row.title))).map(row => getFullTitle(row.namespace, row.title)));

    } catch (error) {
        logger.error(taskId, `Error fetching templates: ${error.message}`);
        error.message = `テンプレートの取得に失敗しました: ${error.message}`;
        throw error;
    } finally {
        if (connection) {
            await connection.end();
        }
    }
    return templates;
}

// ==========================================
// 対象記事取得
// ==========================================
async function getTargetPagesUsingTemplate(templates) {
    let pages = new Set();
    try {
        if (templates.size === 0) return new Set();
        for (const targetTemplate of templates) {

            const templateName = targetTemplate;

            for await (let response of bot.continuedQueryGen({
                action: 'query',
                generator: 'embeddedin',
                geititle: templateName,
                geinamespace: jawpconfig.subster.targetNamespace.join('|'),
                geilimit: 'max',
                prop: 'info'
            })) {
                const pages0 = Object.values(response?.query?.pages || {});

                pages0.forEach(page => {
                    if (page.contentmodel !== 'wikitext') return;
                    pages.add(page.title);
                });
            }
            if (pages.size === 0) continue;
        }
    } catch (error) {
        logger.error(taskId, `Error fetching target pages: ${error.message}`);
        error.message = `対象ページの取得に失敗しました: ${error.message}`;
        throw error;
    }
    return pages;
}

// ==========================================
// メイン処理
// ==========================================
(async () => {
    const now = new Date();
    let Logcount = {
        success: 0,
        failed: 0,
        noEdit: 0
    }
    try {
        await checkTaskStatusAndExit(taskId);
        await bot.login();
        const response = await bot.request({
            action: 'query',
            meta: 'siteinfo',
            siprop: 'general|namespaces|namespacealiases|interwikimap',
            formatversion: 2
        });
        const info = response.query;
        namespaceMap = info.namespaces;

        parser.setSiteInfo(info);
        logger.success(taskId, 'ログイン成功');
        const TARGET_TEMPLATES = await getTemplatesInCategory();
        console.log(TARGET_TEMPLATES);
        if (TARGET_TEMPLATES.size === 0) {
            return;
        }
        const targetPages = await getTargetPagesUsingTemplate(TARGET_TEMPLATES);
        console.log(targetPages);
        if (targetPages.size === 0) {
            logger.error(taskId, `SQLではマッチしましたが、対象ページが見つかりませんでした。`, true);
            return;
        }

        for (const title of targetPages) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            try {
                const res = await bot.edit(title, async (rev) => {
                    const text = rev.content;
                    let newtext = text;

                    if (!await allowBots(newtext, bot.options.username.split('@')[0])) {
                        Logcount.noEdit++;
                        return;
                    }

                    const result = parser.parse(text, { templates: true });
                    let matchedTemplates = [];

                    for (const template of result.templates) {
                        let isMatch = TARGET_TEMPLATES.has(template.name);
                        if (isMatch && (template.type === 'template' || template.type === 'substTemplate')) {
                            if (template.args && template.args.nosubst && Yesno(template.args.nosubst)) continue;
                            if (template.args && template.args.demo && Yesno(template.args.demo)) continue;
                            matchedTemplates.push(template);
                        }
                    }

                    if (matchedTemplates.length === 0) {
                        Logcount.noEdit++;
                        return;
                    }

                    matchedTemplates.sort((a, b) => {
                        if (a.position.start === b.position.start) return b.position.end - a.position.end;
                        return a.position.start - b.position.start;
                    });

                    let outermostTemplates = [];
                    let currentMaxEnd = -1;

                    for (const t of matchedTemplates) {
                        if (t.position.start >= currentMaxEnd) {
                            outermostTemplates.push(t);
                            currentMaxEnd = t.position.end;
                        }
                    }
                    if (outermostTemplates.length === 0) return;

                    const joinedTemplates = outermostTemplates.map(t => {
                        let original = t.original;
                        if (t.type === 'template') {
                            original = original.replace(/^\{\{/, '{{subst:');
                        }
                        return original;
                    }).join('\uE015');

                    const SubstResult = await bot.request({
                        action: 'parse',
                        text: joinedTemplates,
                        title: title,
                        pst: 1,
                        onlypst: 1,
                        format: 'json',
                        formatversion: 2
                    });

                    const SubstText = SubstResult.parse.text;
                    const substTemplates = SubstText.split('\uE015');

                    if (outermostTemplates.length !== substTemplates.length) {
                        throw new Error(`Error: Template length mismatch! Original: ${outermostTemplates.length}, Substituted: ${substTemplates.length}`);
                    }

                    let replacements = outermostTemplates.map((t, index) => ({
                        start: t.position.start,
                        end: t.position.end,
                        original: t.original,
                        substText: substTemplates[index]
                    }));

                    replacements.sort((a, b) => b.start - a.start);

                    for (const rep of replacements) {
                        const targetSubstring = newtext.substring(rep.start, rep.end);
                        if (targetSubstring === rep.original) {
                            newtext = newtext.slice(0, rep.start) + rep.substText + newtext.slice(rep.end);
                        } else {
                            console.warn(`\n[Warning] Skip substitution at index ${rep.start}.`);
                            console.warn(`Expected : ${rep.original}`);
                            console.warn(`Found    : ${targetSubstring}\n`);
                        }
                    }
                    if (newtext === text) {
                        Logcount.noEdit++;
                        return;
                    }
                    return {
                        text: newtext,
                        summary: 'Bot:自動subst展開',
                        bot: true,
                        minor: true
                    }
                });

                if (res && res.result === 'Success') {
                    Logcount.success++;
                }
            } catch (error) {
                console.error(`Error processing ${title}:`, error);
                Logcount.failed++;
            }
        }
        if (Logcount.failed > 0) {
            logger.error(taskId, `Subst展開処理完了。成功: ${Logcount.success} 件、失敗: ${Logcount.failed} 件、編集なし: ${Logcount.noEdit} 件。`, true);
        } else {
            logger.success(taskId, `Subst展開処理完了。成功: ${Logcount.success} 件、編集なし: ${Logcount.noEdit} 件。`, true);
        }
    } catch (error) {
        console.error(error);
        logger.error(taskId, `作業中にエラーが発生しました: ${error.message}`);
        logger.error(taskId, `作業中にエラーが発生しました。`, true);
    }
})();