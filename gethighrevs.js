const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');
const { setTimeout } = require("node:timers/promises");
const { Mwn } = require('mwn');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { parseTemplate, splitWithContext, escapeRegex, parseSection } = require('./utils/parse.js');
const { logger } = require("./utils/logger");
const taskId = 'nnId2';
const ListminRevisions = 4000;
const ANminRevisions = 4500;
let lastedit;
/**
 * 版数4500以上のページ一覧を取得（履歴を分離したページを除外）
 * @param {Object} options - オプション
 * @param {number} options.minRevisions - 最小版数（デフォルト: 4500）
 * @param {number} options.limit - 取得件数上限（デフォルト: 500）
 * @returns {Promise<Array>} - ページ情報の配列 [{page_id, page_title, page_namespace, revision_count}]
 */
async function getHighRevisionPages(options = {}) {
    const { minRevisions = 4500, limit = 500 } = options;
    let connection;

    try {
        // データベース設定
        let config = {
            host: 'jawiki.analytics.db.svc.wikimedia.cloud',
            port: 3306,
            database: 'jawiki_p',
            charset: 'utf8mb4',
            connectTimeout: 120000,
            idleTimeout: 300000,
            multipleStatements: false
        };

        // 認証情報取得
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
                    config.password = trimmedLine.split('=')[1].trim();
                }
            }

            if (!config.user || !config.password) {
                logger.error(taskId, '認証に失敗しました。', true);
                throw new Error('認証情報を取得できませんでした');
            }
        }

        // データベース接続
        connection = await mysql.createConnection(config);


        // メインクエリ実行
        const query = `
            SELECT 
                p.page_id,
                p.page_title,
                p.page_namespace,
                COUNT(*) as revision_count
            FROM page p
            INNER JOIN revision r ON p.page_id = r.rev_page
            WHERE p.page_namespace IN (0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
              AND p.page_is_redirect = 0
              AND NOT EXISTS (
                  SELECT 1 FROM categorylinks WHERE cl_from = p.page_id AND cl_to = '履歴を分離したページ'
              )
            GROUP BY p.page_id, p.page_title, p.page_namespace
            HAVING COUNT(*) >= ?
            ORDER BY revision_count DESC
            LIMIT ?
        `;

        const [rows] = await connection.execute(query, [minRevisions, limit]);

        // 結果の整形
        return rows.map(row => ({
            page_id: row.page_id,
            page_title: Buffer.isBuffer(row.page_title) ?
                row.page_title.toString('utf8') : String(row.page_title),
            page_namespace: row.page_namespace,
            revision_count: row.revision_count
        }));

    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

/**
 * 名前空間名を取得
 * @param {number} namespace - 名前空間番号
 * @returns {string} - 名前空間名
 */
function getNamespaceName(namespace) {
    const namespaces = {
        0: '標準', 1: 'ノート', 2: '利用者', 3: '利用者‐会話',
        4: 'Wikipedia', 5: 'Wikipedia‐ノート', 6: 'ファイル', 7: 'ファイル‐ノート',
        8: 'MediaWiki', 9: 'MediaWiki‐ノート', 10: 'Template', 11: 'Template‐ノート',
        12: 'Help', 13: 'Help‐ノート', 14: 'Category', 15: 'Category‐ノート'
    };
    return namespaces[namespace] || `名前空間${namespace}`;
}


async function main() {
    //制御確認
    await checkTaskStatusAndExit(taskId);

    try {
        const bot = new Mwn({
            apiUrl: 'https://ja.wikipedia.org/w/api.php',
            username: process.env.MW_USERNAME,
            password: process.env.MW_PASSWORD,
            userAgent: 'nanonaBot2/gethighrevs 0.2.8',
            defaultParams: { format: 'json' }
        });
        //現在時刻(JST)
        const now = new Date();
        const nowtext = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log(`現在時刻: ${nowtext}`);

        const highRevPages = await getHighRevisionPages({ minRevisions: ListminRevisions, limit: 500 });
        //highRevPagesをファイルとして保存
        const outputPath = path.join(__dirname, 'highRevPages.json');
        await fs.writeFile(outputPath, JSON.stringify(highRevPages, null, 2), 'utf8');
        console.log(`ページ情報を ${outputPath} に保存しました。`);
        /*
        //highRevPages.jsonから読み込む
        const highRevPages = JSON.parse(await fs.readFile(path.join(__dirname, 'highRevPages.json'), 'utf8'));*/
        console.log(`取得したページ数: ${highRevPages.length}`);
        //所要時間
        const elapsedTime = (new Date() - now) / 1000;
        const minutes = Math.floor(elapsedTime / 60);
        const seconds = Math.floor(elapsedTime % 60);
        console.log(`所要時間: ${minutes}分${seconds}秒`);
        // Wikitable形式で出力
        let wikitable = '';
        let ANtext = `以下のページの版数が${ANminRevisions}以上のため、履歴保存を依頼します。\n${nowtext}現在\n\n`;
        if (highRevPages.length >= 500) wikitable += `版数4500以上のページは500件以上ありました。\n`;
        await bot.login();
        let ANCount = 0;
        if (highRevPages.length === 0) {
            wikitable += '版数4500以上のページはありませんでした。';
        } else {
            wikitable = `{| class="wikitable sortable"\n|-\n! ページID !! ページ名 !! 版数\n`;
            for (const page of highRevPages) {
                const namespaceName = getNamespaceName(page.page_namespace);
                //標準名前空間は[[ページ名]]、他は[[名前空間:ページ名]]
                const pageTitle = page.page_namespace === 0 ? page.page_title : `${namespaceName}:${page.page_title}`;
                wikitable += `|-\n| ${page.page_id} || [[${pageTitle}]] || ${page.revision_count}\n`;

                if (page.revision_count >= ANminRevisions) {
                    ANCount++;
                    /* ======WP:AN報告===== */

                    // 初版取得
                    const firstRevQuery = await bot.request({
                        action: 'query',
                        prop: 'revisions',
                        titles: pageTitle,
                        rvlimit: 1,
                        rvdir: 'newer',
                        rvslots: '*',
                        rvprop: 'content',
                        formatversion: 2
                    });
                    const firstText = firstRevQuery.query.pages[0].revisions[0].slots.main.content;

                    // 初版がリダイレクトかつCategory:履歴を分離したページにカテゴライズされているか判定
                    let redirectTarget = null;
                    let categorized = false;
                    const redirectMatch = firstText.match(/^#(?:REDIRECT|転送)[ \t]*\[\[([^\]]*)\]\]/i);
                    if (redirectMatch) {
                        redirectTarget = redirectMatch[1];

                        const catCheck = await bot.request({
                            action: 'query',
                            prop: 'categories',
                            titles: redirectTarget,
                            clcategories: 'Category:履歴を分離したページ',
                            formatversion: 2
                        });
                        categorized = catCheck.query.pages[0]?.categories?.length > 0;
                    }
                    ANtext += `* {{利用者:NanonaBot2/nnId2/Tmp|${page.page_id}|${page.revision_count}${categorized ? `|${redirectTarget}` : ''}}}\n`;
                }
            }
            wikitable += `|}\n`;
            ANtext += `以上${ANCount}ページ、お願いいたします。--~~~~\n`;
        }
        console.log(wikitable);
        let wikitext = `最終更新: ${nowtext}\n\n${wikitable}`;
        console.log('ログイン成功');
        const sandboxTitle = '利用者:NanonaBot2/版数の多いページ一覧';
        let ANre = await bot.edit(sandboxTitle, () => {
            return {
                text: wikitext,
                summary: 'Bot:版数の多いページ一覧を更新',
            };
        }).then(res => {
            if (res.result === 'Success') {
                logger.success(taskId, `版数の多いページ一覧を更新しました: ${sandboxTitle}`, true);
            } else {
                logger.error(taskId, `版数の多いページ一覧の更新に失敗しました: ${sandboxTitle}`, true);
            }
        }).catch(err => {
            logger.error(taskId, `版数の多いページ一覧の更新に失敗しました: ${sandboxTitle}`, true);
            return { result: 'Error', error: err };
        });
        //10秒待機
        await setTimeout(10000);

        //await bot.edit('Wikipedia:管理者伝言板/各種初期化依頼', (rev) => {
        await bot.edit('利用者:NanonaBot2/Sandbox2', (rev) => {
            let text = rev.content;
            let ANsections = parseSection(text, 3);
            let RevSection = ANsections.find(section => section.name === '履歴保存依頼' && section.seclevel === 2);
            if (!RevSection && ANCount > 0) {
                text += `\n\n== 履歴保存依頼 ==\n${ANtext}`;
                ANsections = parseSection(text, 3);
            } else if (ANCount > 0) {
                text = text.replace(RevSection.wikitext, "== 履歴保存依頼 ==\n" + ANtext);
            } else {
                text = text.replace(RevSection.wikitext, "");
            }

            return {
                text: text,
                notminor: true,
                bot: false,
                summary: highRevPages.length > 0 ? `版数の多いページの履歴保存依頼を更新しました（${ANCount}件）` : '版数の多いページの履歴保存依頼を除去しました（0件）',
            }
        }).then(res => {
            if (res.result === 'Success') {
                let ANsummary = highRevPages.length > 0 ? `Bot： 版数の多いページの履歴保存依頼 更新（${ANCount}件）` : `Bot： 版数の多いページの履歴保存依頼 除去（0件）`;
                console.log('履歴保存依頼を送信しました:', res);
                logger.success(taskId, ANsummary, true);
            } else {
                console.error('履歴保存依頼の送信に失敗しました:', res);
                logger.error(taskId, `履歴保存依頼の更新に失敗しました`, true);
            }
        }).catch(err => {
            console.error('履歴保存依頼の送信に失敗しました:', err);
            logger.error(taskId, `履歴保存依頼の更新に失敗しました`, true);
        });

    } catch (error) {
        logger.error(taskId, `エラーが発生しました`, true);
        console.error('エラー:', error.message);
    }
}

main();