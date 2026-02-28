const { Mwn } = require('mwn');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require("./utils/logger");
const { allowBots } = require('./utils/parse.js');
const bot = new Mwn({
    apiUrl: 'https://ja.wikinews.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: 'nanonaBot2/archiver 0.5.0',
    defaultParams: { format: 'json' }
});
const taskId = 'n-ja-nn1';
const summary = 'Bot: [[ウィキニュース:記事のアーカイブ|記事の自動アーカイブ]]';

async function getpageids() {
    const archivetimeUTC = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7日前
    const pages = [];
    const squery = await bot.query({
        action: 'query',
        list: 'search',
        srsearch: 'incategory:公開中 -incategory:アーカイブ済 -incategory:自動アーカイブ済',
        srnamespace: 0,
        srlimit: 10,
        srprop: 'timestamp',
        srsort: 'last_edit_asc',
        formatversion: 2
    });

    for (const item of squery.query.search) {
        const editedDate = new Date(item.timestamp);
        if (editedDate <= archivetimeUTC) {
            pages.push(item.pageid);
            console.log('アーカイブ対象ページ追加:', item.pageid, item.title, item.timestamp);
        }
    }

    return pages;
}

async function archivepage(pid) {
    let sucerr = "none";
    try {
        const res = await bot.edit(pid, async (rev) => {
            const wikitext = rev.content;
            let newtext = wikitext;
            const allow = await allowBots(wikitext, "Nanona15dobato");
            if (!allow) {
                sucerr = "テンプレート:Botsの設定で編集が拒否されました。";
                throw new Error(sucerr);
            }
            //既にアーカイブ済でないか確認
            if (/\{\{\s*(自動)?アーカイブ済\s*(\|[^\{\}]*)?\}\}/.test(wikitext)) {
                sucerr = "既にアーカイブ済のテンプレートが存在しています。";
                throw new Error(sucerr);
            }
            const templateRegex = /(((?:^|[^は])\{\{\s*公開中\s*(?:\|[^\{\}]*)?\}\})([^\S\n\r]*)(\n)?)/;
            const match = wikitext.match(templateRegex);
            if (!match) {
                sucerr = "公開中テンプレートが見つかりませんでした。";
                throw new Error(sucerr);
            }
            const endRegex = /\{\{\s*公開中\s*(?:\|[^\{\}]*)?\}\}$/;
            if (endRegex.test(wikitext)) {
                newtext = wikitext + '\n{{自動アーカイブ済}}';
            } else {
                newtext = match[4] ? wikitext.replace(templateRegex, '$1{{自動アーカイブ済}}\n') : wikitext.replace(templateRegex, '$2{{自動アーカイブ済}}$3');
            }
            return {
                text: newtext,
                minor: true,
                bot: true,
                summary: summary
            };
        });
        if (res.result === 'Success') {
            try {
                console.log(`ページ「${pid}」の編集に成功しました。保護処理を開始します。`);
                const csrfToken = await bot.getCsrfToken();
                const re = await bot.request({
                    action: 'protect',
                    protections: 'edit=sysop|move=sysop',
                    expiry: 'infinite',
                    pageid: pid,
                    reason: summary,
                    token: csrfToken
                });
                sucerr = "success";
                console.log(`ページ「${pid}」を保護しました。`);
            } catch (err) {
                sucerr = "ページ保護に失敗しました。";
                console.error(`ページ「${pid}」の保護に失敗しました:`, err);
            }
        } else {
            sucerr = "編集に失敗しました(1)。";
            console.error('送信に失敗しました:', res);
        }
    } catch (err) {
        if (sucerr === "none") sucerr = "編集に失敗しました(2)。";
        console.error('送信に失敗しました:', err);
    }
    return sucerr;
}


(async () => {
    await checkTaskStatusAndExit(taskId);
    await bot.login();
    logger.success(taskId, 'ログイン成功');

    const pages = await getpageids();
    //const pages = [45076];

    let successCount = 0;
    let failCount = 0;
    for (const pid of pages) {
        console.log('アーカイブ処理中:', pid);
        const result = await archivepage(pid);
        console.log(`アーカイブ処理結果: ${result}`);
        if (result === "success") {
            successCount++;
        } else {
            logger.error(taskId, `アーカイブ処理中にエラーが発生しました: ${pid} - ${result}`);
            failCount++;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    console.log(`アーカイブ処理完了。成功: ${successCount} 件、失敗: ${failCount} 件`);
    logger.info(taskId, `自動アーカイブ処理完了。成功: ${successCount} 件、失敗: ${failCount} 件`, true);
})();