const { Mwn } = require('mwn');
const fs = require('fs');
var path = require("path");
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require("./utils/logger");
const bot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: 'nanonaBot2/CPagemake 1.1.0 (Toolforge)',
    defaultParams: { format: 'json' }
});
const taskId = 'w-ja-nn1';

(async () => {
    await checkTaskStatusAndExit(taskId);
    await bot.login();
    logger.success(taskId,'ログイン成功');

    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    jst.setDate(jst.getDate() + 1);

    const year = jst.getFullYear();
    const month = jst.getMonth() + 1;
    const day = jst.getDate();
    const pageTemplateTitle = 'プロジェクト:カテゴリ関連/議論/日別ページ雛形';
    const newPageTitle = `プロジェクト:カテゴリ関連/議論/${year}年/${month}月${day}日`;

    //ページの存在確認
    const pageData = await bot.read(newPageTitle);
    if (pageData?.missing === undefined) {
        logger.info(taskId, `ページ ${newPageTitle} はすでに存在します。`,true);
        return;
    }

    // テンプレートページの取得
    const templateData = await bot.read(pageTemplateTitle);
    const templateContent = templateData?.revisions[0]?.content;
    if (!templateContent) {
        logger.error(taskId, 'テンプレートページの取得に失敗しました。', true);
        return;
    }

    // テンプレートの置換
    const newPageContent = templateContent
        .replace(/\{year\}/g, year)
        .replace(/\{month\}/g, month)
        .replace(/\{day\}/g, day)
        .replace(/\{page_name\}/g, newPageTitle);

    // ページの作成
    const reedit01 = await bot.create(newPageTitle, newPageContent, 'Bot: 議論ページの作成');

    if (reedit01.result === "Success") { logger.success(taskId, `議論ページの作成: ${newPageTitle}`, true); } else { logger.error(taskId, `議論ページの作成: ${newPageTitle}[${reedit01.result}]`, true); }
})();