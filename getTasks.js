const { Mwn } = require('mwn');

// MediaWiki APIクライアントの初期化
const bot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_USERNAME,
    password: process.env.MW_PASSWORD,
    userAgent: 'nanonaBot2/getTasks 1.0.0 (Toolforge)'
});

/**
 * 指定されたタスクIDの稼働状況を取得する関数
 * @param {string} taskId - チェックするタスクID (例: 'nnId1', 'nnId2')
 * @returns {Promise<string|null>} タスクの状態値、または null（エラー時）
 */
async function getTaskStatus(taskId) {
    try {
        // ログイン
        await bot.login();

        // ページのwikitextを取得
        const pageTitle = '利用者:NanonaBot2/tasks';
        const page = await bot.read(pageTitle);

        if (!page || !page.revisions || !page.revisions[0]) {
            console.error('ページが見つからないか、読み取りに失敗しました');
            return null;
        }

        const wikitext = page.revisions[0].content;

        // "{{利用者:NanonaBot2/tasks/template" の出現回数をチェック
        const templatePattern = /\{\{利用者:NanonaBot2\/tasks\/template/g;
        const matches = wikitext.match(templatePattern);

        if (!matches || matches.length < 2) {
            console.log('テンプレートが2つ未満のため、更新処理をスキップします');
        } else {
            // 最後のテンプレートを抽出して更新
            await updateLastTemplate(pageTitle, wikitext);
        }

        // 現在のwikitextを再取得（更新後の可能性があるため）
        const updatedPage = await bot.read(pageTitle);
        const currentWikitext = updatedPage.revisions[0].content;

        // タスクの状態値を抽出
        const taskValue = extractTaskValue(currentWikitext, taskId);
        return taskValue;

    } catch (error) {
        console.error('タスク状態の取得中にエラーが発生しました:', error);
        return null;
    }
}

/**
 * 最後のテンプレートを抽出してページを更新する内部関数
 * @param {string} pageTitle - ページタイトル
 * @param {string} wikitext - 元のwikitext
 */
async function updateLastTemplate(pageTitle, wikitext) {
    try {
        // 最後の "{{利用者:NanonaBot2/tasks/template" を見つける
        const templateStart = '{{利用者:NanonaBot2/tasks/template';
        const lastTemplateIndex = wikitext.lastIndexOf(templateStart);

        if (lastTemplateIndex === -1) {
            return;
        }

        // 最後の "}}" を見つける
        let braceCount = 0;
        let endIndex = -1;

        for (let i = lastTemplateIndex; i < wikitext.length; i++) {
            if (wikitext.substring(i, i + 2) === '{{') {
                braceCount++;
                i++;
            } else if (wikitext.substring(i, i + 2) === '}}') {
                braceCount--;
                if (braceCount === 0) {
                    endIndex = i + 2;
                    break;
                }
                i++;
            }
        }

        if (endIndex === -1) {
            console.error('テンプレートの終了が見つかりません');
            return;
        }

        // 最後のテンプレート部分を抽出
        const lastTemplate = wikitext.substring(lastTemplateIndex, endIndex);

        // ページを上書き更新
        await bot.save(pageTitle, lastTemplate, '稼働状況更新');
        console.log('ページが正常に更新されました');

    } catch (error) {
        console.error('ページ更新中にエラーが発生しました:', error);
    }
}

/**
 * wikitextからタスクIDの値を抽出する内部関数
 * @param {string} wikitext - wikitext内容
 * @param {string} taskId - 検索するタスクID
 * @returns {string|null} タスクの値、または null
 */
function extractTaskValue(wikitext, taskId) {
    // パターン: |taskId = value
    const pattern = new RegExp(`\\|\\s*${taskId}\\s*=\\s*([^\\n\\|]+)`, 'i');
    const match = wikitext.match(pattern);

    if (match) {
        return match[1].trim();
    }

    return null;
}

/**
 * Cron用: ページの更新のみを行う関数
 * @returns {Promise<boolean>} 更新成功時true、失敗時false
 */
async function updateTasksPageOnly() {
    try {
        await bot.login();

        // ページのwikitextを取得
        const pageTitle = '利用者:NanonaBot2/tasks';
        const page = await bot.read(pageTitle);

        if (!page || !page.revisions || !page.revisions[0]) {
            console.error('ページが見つからないか、読み取りに失敗しました');
            return false;
        }

        const wikitext = page.revisions[0].content;

        // "{{利用者:NanonaBot2/tasks/template" の出現回数をチェック
        const templatePattern = /\{\{利用者:NanonaBot2\/tasks\/template/g;
        const matches = wikitext.match(templatePattern);

        if (!matches || matches.length < 2) {
            console.log('テンプレートが2つ未満のため、更新は不要です');
            return true;
        }

        // 最後のテンプレートを抽出して更新
        console.log(`${matches.length}個のテンプレートが見つかりました。最後のテンプレートで更新します。`);
        await updateLastTemplate(pageTitle, wikitext);
        return true;

    } catch (error) {
        console.error('ページ更新処理中にエラーが発生しました:', error);
        return false;
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

// コマンドライン引数での直接実行
if (require.main === module) {
    const command = process.argv[2];

    if (command === 'update') {
        // 更新のみ実行
        updateTasksPageOnly().then(success => {
            if (success) {
                console.log('ページ更新処理が完了しました');
                process.exit(0);
            } else {
                console.error('ページ更新処理に失敗しました');
                process.exit(1);
            }
        });
    } else if (command) {
        // タスクID指定でステータス取得
        const taskId = command;
        getTaskStatus(taskId).then(status => {
            if (status !== null) {
                console.log(`タスク ${taskId} の状態: ${status}`);
            } else {
                console.error('状態の取得に失敗しました');
                process.exit(1);
            }
        });
    } else {
        console.error('使用方法:');
        console.error('  node taskStatusChecker.js <taskId>  - タスクの状態を取得');
        console.error('  node taskStatusChecker.js update   - ページの更新のみ実行');
        process.exit(1);
    }
}

module.exports = {
    getTaskStatus,
    checkTaskStatusAndExit,
    updateTasksPageOnly
};
