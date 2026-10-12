const { Mwn } = require('mwn');
const { setTimeout } = require("node:timers/promises");
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { parseSection } = require('./utils/parse.js');
const { logger } = require("./utils/logger");
const taskId = 'w-ja-nn3';
const nnversion = '__FILE_HASH__';


const bot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/sandbox-clean [${nnversion}] (Toolforge)`,
    defaultParams: { format: 'json' }
});

const sandboxes = {
    /*"サンドボックス名": "初期wikitext(subst展開)",*/
    //"Wikipedia:サンドボックス": "サンドボックスの初期化",
    "Wikipedia‐ノート:サンドボックス": "ノート用サンドボックスの初期化",
    "Help:ビジュアルエディター/sandbox": "ビジュアルエディター用サンドボックスの初期化",
    "Help:VisualEditor_sandbox": "利用者:Nanona15dobato/VisualEditor sandbox 初期化用",
};

async function cleanstart() {
    await checkTaskStatusAndExit(taskId);
    await bot.login();
    let logs = {
        success: [],
        error: [],
        nochange: []
    };
    for (const [sandboxTitle, templatename] of Object.entries(sandboxes)) {
        console.log(`処理中: ${sandboxTitle} (${templatename})`);
        await setTimeout(10000);

        let revcount = 0;
        let deletedrevcount = 0;
        let oldProtection = [];

        try {
            const res = await bot.request({
                action: 'query',
                prop: 'revisions|info',
                titles: sandboxTitle,
                rvlimit: 'max',
                rvprop: 'ids',
                inprop: 'protection',
                formatversion: 2
            });
            revcount = res.query.pages[0]?.revisions?.length || 0;
            oldProtection = res.query.pages[0]?.protection || [];
            console.log('通常版数:', revcount);
        } catch (e) {
            console.error('通常版取得エラー:', e);
            logs.error.push([sandboxTitle, 0]);
            logger.error(taskId, `通常版取得エラー: ${sandboxTitle}: ${e.message}`,false,{stack:e.stack});
            logger.error(taskId, `通常版取得エラー: ${sandboxTitle}`, true);            
            continue;
        }

        try {
            const res = await bot.request({
                action: 'query',
                prop: 'deletedrevisions',
                titles: sandboxTitle,
                drvprop: 'ids',
                drvlimit: 'max',
                formatversion: 2
            });
            deletedrevcount = res.query.pages[0]?.deletedrevisions?.length || 0;
            console.log('削除済み版数:', deletedrevcount);
        } catch (e) {
            console.error('削除済み版取得エラー:', e);
            logs.error.push([sandboxTitle, 0]);
            logger.error(taskId, `削除済み版取得エラー: ${sandboxTitle}: ${e.message}`,false,{stack:e.stack});
            logger.error(taskId, `削除済み版取得エラー: ${sandboxTitle}`, true);
            continue;
        }

        const total = revcount + deletedrevcount;
        console.log(`合計 ${total} 版`);

        if (sandboxTitle !== "Wikipedia:サンドボックス") {
            const summary = `Bot： 砂場ならし（削除済みを含めた版数: ${total >= 5000 ? '5000以上' : total}）`;
            let re;
            try {
                re = await bot.save(sandboxTitle, `{{subst:${templatename}}}`, summary, {
                    minor: true,
                    bot: true
                });
            } catch (e) {
                console.error('白紙化編集エラー:', e);
                logs.error.push([sandboxTitle, total]);
                logger.error(taskId, `白紙化編集エラー: ${sandboxTitle}: ${e.message}`,false,{stack:e.stack});
                logger.error(taskId, `白紙化編集エラー: ${sandboxTitle}`, true);
                await setTimeout(10000);
                continue;
            }
            console.log(`白紙化中: ${sandboxTitle} (${templatename})`, summary);
            if (re.nochange) {
                logs.nochange.push([sandboxTitle, total]);
                logger.info(taskId, `白紙化不要: ${sandboxTitle}（版数: ${total}）`);
            } else if (re.result === 'Success') {
                logs.success.push([sandboxTitle, total]);
                logger.success(taskId, `白紙化しました: ${sandboxTitle}（版数: ${total}）`);
            } else {
                logs.error.push([sandboxTitle, total]);
                console.error(`白紙化に失敗しました: ${sandboxTitle}（版数: ${total}）`, re);
                logger.error(taskId, `白紙化に失敗しました: ${sandboxTitle}（版数: ${total}）`);
            }
        }
    }
    // ログ出力メッセージを生成 ひとつにまとめる。
    let logMessages = [];
    let logMessage = '';
    if (logs.success.length > 0) logMessages.push(`成功: ${logs.success.map(([title, count]) => `${title}（${count}版）`).join(', ')}`);
    if (logs.error.length > 0) logMessages.push(`失敗: ${logs.error.map(([title, count]) => `${title}（${count}版）`).join(', ')}`);
    if (logs.nochange.length > 0) logMessages.push(`変更なし: ${logs.nochange.map(([title, count]) => `${title}（${count}版）`).join(', ')}`);
    if (logMessages.length > 0) {
        logMessage = logMessages.join('/');
        if (logs.error.length > 0) {
            logger.error(taskId, logMessage, true);
        } else if (logs.success.length > 0) {
            logger.success(taskId, logMessage, true);
        } else {
            logger.info(taskId, logMessage, true);
        }
    }
}

cleanstart().catch(err => {
    console.error('エラー:', err);
});