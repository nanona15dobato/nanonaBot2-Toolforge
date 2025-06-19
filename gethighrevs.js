const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');
const { Mwn } = require('mwn');

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
    try {
        const bot = new Mwn({
            apiUrl: 'https://ja.wikipedia.org/w/api.php',
            username: process.env.MW_USERNAME,
            password: process.env.MW_PASSWORD,
            userAgent: 'nanonaBot2/gethighrevs 0.1.0',
            defaultParams: { format: 'json' }
        });
        //現在時刻(JST)
        //const now = new Date();
        //console.log(`現在時刻: ${now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
        const highRevPages = await getHighRevisionPages();/*
        console.log(`取得したページ数: ${highRevPages.length}`);
        //所要時間
        const elapsedTime = (new Date() - now) / 1000;
        //分・秒に変換
        const minutes = Math.floor(elapsedTime / 60);
        const seconds = Math.floor(elapsedTime % 60);
        console.log(`所要時間: ${minutes}分${seconds}秒`);*/
        // Wikitable形式で出力
        let wikitable = '';
        if (highRevPages.length >= 500) wikitable += `版数4500以上のページは500件以上ありました。\n`;
        if (highRevPages.length === 0) {
            wikitable += '版数4500以上のページはありませんでした。';
        } else {
            wikitable = `{| class="wikitable sortable"\n|-\n! ページID !! ページ名 !! 版数\n`;
            for (const page of highRevPages) {
                const namespaceName = getNamespaceName(page.page_namespace);
                //標準名前空間は[[ページ名]]、他は[[名前空間:ページ名]]
                const pageTitle = page.page_namespace === 0 ? page.page_title : `${namespaceName}:${page.page_title}`;
                wikitable += `|-\n| ${page.page_id} || [[${pageTitle}]] || ${page.revision_count}\n`;
            }
            wikitable += `|}\n`;
        }
        //console.log(wikitable);
        let wikitext = `最終更新: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n\n${wikitable}`;
        await bot.login();
        //console.log('ログイン成功');
        const sandboxTitle = '利用者:NanonaBot2/版数の多いページ一覧';
        await bot.edit(sandboxTitle, () => {
            return {
                text: wikitext,
                summary: 'Bot:版数の多いページ一覧を更新',
            };
        });
        console.log(`結果を ${sandboxTitle} に保存しました。`);
    } catch (error) {
        console.error('エラー:', error.message);
    }
}

main();
