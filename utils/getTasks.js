const { Mwn } = require('mwn');

// MediaWiki APIクライアントの初期化
const bot = new Mwn({
    apiUrl: 'https://meta.wikimedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: 'nanonaBot2/getTasks 1.2.1',
    defaultParams: { format: 'json' }
});


/**
 * wikitextから 'key'='value' 形式を抽出してオブジェクト化
 * @param {string} wikitext
 * @returns {Record<string, string>}
 */
function parseTaskData(wikitext) {
    const data = {};
    if (!wikitext || typeof wikitext !== 'string') {
        return data;
    }

    const pattern = /'([A-Za-z0-9:_ \-]+)'='([^']*)'/g;
    for (const [, key, value] of wikitext.matchAll(pattern)) {
        data[key] = value;
    }

    return data;
}

/**
 * 指定されたタスクIDの稼働状況を取得する関数
 * @param {string} taskId - チェックするタスクID (例: 'nnId1', 'nnId2')
 * @returns {Promise<string|null>} タスクの状態値、または null（エラー時）
 */
async function getTaskStatus(taskId) {
    try {
        await bot.login();

        const pageTitle = 'User:NanonaBot2/tasks/data';
        const page = await bot.read(pageTitle);
        const wikitext = page?.revisions?.[0]?.content;

        if (!wikitext) {
            console.error('ページが見つからないか、読み取りに失敗しました');
            return null;
        }

        const data = parseTaskData(wikitext);

        if (data.ALL !== '1') {
            return '0';
        }

        return data[taskId] ?? null;
    } catch (error) {
        console.error('タスク状態の取得中にエラーが発生しました:', error);
        return null;
    }
}

/**
 * 他のファイルから呼び出される際の状態チェック関数
 * @param {string} taskId - チェックするタスクID
 * @returns {Promise<boolean>} true: 続行可能 (値が1), false: 終了すべき (値が1以外)
 */
async function checkTaskStatusAndExit(taskId) {
    const status = await getTaskStatus(taskId);

    if (status === null) {
        console.error(`タスク ${taskId} の状態を取得できませんでした`);
        process.exit(1);
    }

    if (status !== '1') {
        console.log(`タスク ${taskId} が停止状態です (値: ${status})`);
        process.exit(0);
    }

    console.log(`タスク ${taskId} は稼働中です`);
    return true;
}

// コマンドライン引数での直接実行をサポート
if (require.main === module) {
    const taskId = process.argv[2];

    if (!taskId) {
        console.error('使用方法:');
        console.error('node getTasks.js <taskId>  - タスクの状態を取得');
        process.exit(1);
    }

    getTaskStatus(taskId).then(status => {
        if (status !== null) {
            console.log(`タスク ${taskId} の状態: ${status}`);
        } else {
            console.error('状態の取得に失敗しました');
            process.exit(1);
        }
    });
}

module.exports = {
    getTaskStatus,
    checkTaskStatusAndExit
};