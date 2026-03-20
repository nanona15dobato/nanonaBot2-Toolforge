const { Mwn } = require('mwn');
const fs = require('fs');
const path = require('path');
const nnversion = '__FILE_HASH__';

// MediaWiki APIクライアントの初期化
const bot = new Mwn({
    apiUrl: 'https://meta.wikimedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/getTasks [${nnversion}] (Toolforge)`,
    defaultParams: { format: 'json' }
});
const pageTitle = 'User:NanonaBot2/tasks/data';

/**
 * メタウィキからタスクデータを取得する関数
 * @returns {String}  - wikitext
 */
async function getTaskdata() {
    try {
        await bot.login();
        const page = await bot.read(pageTitle);
        return page?.revisions?.[0]?.content || '';
    } catch (error) {
        console.error('タスクデータの取得中にエラーが発生しました:', error);
        throw error;
    }
}

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
 * タスク状態をjawpへも反映
 * @param {Record<string, string>} [data] - タスク状態を含むオブジェクト
 */
async function updateTaskStatus(data) {
    //dataがない場合は取得
    if (!data) {
        const wikitext = await getTaskdata();
        data = parseTaskData(wikitext);
    }

    // ../data/lastTaskData.jsonと比較して変更がない場合は更新しない
    const lastDataPath = path.join(__dirname, '../data/lastTaskData.json');
    let lastData = {};
    try {
        const lastDataContent = fs.readFileSync(lastDataPath, 'utf-8');
        lastData = JSON.parse(lastDataContent);
    } catch (e) { }

    if (JSON.stringify(data) === JSON.stringify(lastData)) {
        console.log('タスク状態に変更がないため、更新をスキップしました。');
        return;
    }

    let wikitext = '';
    for (const [key, value] of Object.entries(data)) {
        wikitext += `'${key}'='${value}'\n`;
    }
    wikitext = "<!-- 稼働制御は[[m:"+ pageTitle + "]]にてお願い致します。-->\n" + wikitext.trimEnd();

    const jawpbot = new Mwn({
        apiUrl: 'https://ja.wikipedia.org/w/api.php',
        username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
        password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
        userAgent: 'nanonaBot2/getTasks 1.2.2',
        defaultParams: { format: 'json' }
    });
    await jawpbot.login();
    const re = await jawpbot.save('利用者:NanonaBot2/tasks/data', wikitext, 'Bot: タスク状態の更新');
    if (re.result !== 'Success') {
        console.error('タスク状態の更新に失敗しました:', re);
        return;
    }
    fs.writeFileSync(lastDataPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log('タスク状態の更新が完了しました。');
}

/**
 * 指定されたタスクIDの稼働状況を取得する関数
 * @param {string} taskId - チェックするタスクID (例: 'nnId1', 'nnId2')
 * @returns {Promise<string|null>} タスクの状態値、または null（エラー時）
 */
async function getTaskStatus(taskId) {
    try {
        const wikitext = await getTaskdata();
        if (!wikitext) {
            console.error('ページが見つからないか、読み取りに失敗しました');
            return null;
        }

        const data = parseTaskData(wikitext);
        updateTaskStatus(data);

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
 * @returns {Promise<boolean>} タスクが稼働中の場合に true を返します。それ以外の場合は process.exit() によりプロセスを終了し、呼び出し元には戻りません。
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
    const arg = process.argv[2];

    if (!arg) {
        console.error('使用方法:');
        console.error('node getTasks.js <taskId>  - タスクの状態を取得');
        console.error('node getTasks.js update    - タスク状態を更新して終了');
        process.exit(1);
    }

    if (arg === 'update') {
        // 'update' が指定された場合は updateTaskStatus を実行
        console.log('タスク状態の更新プロセスを開始します...');
        updateTaskStatus().catch(error => {
            console.error('手動更新中にエラーが発生しました:', error);
            process.exit(1);
        });
    } else {
        // それ以外は従来の taskId として処理
        getTaskStatus(arg).then(status => {
            if (status !== null) {
                console.log(`タスク ${arg} の状態: ${status}`);
            } else {
                console.error('状態の取得に失敗しました');
                process.exit(1);
            }
        });
    }
}

module.exports = {
    getTaskStatus,
    checkTaskStatusAndExit,
    updateTaskStatus
};
