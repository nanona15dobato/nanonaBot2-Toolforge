const { Mwn } = require('mwn');
const fs = require('fs');
var path = require("path");
const { checkTaskStatusAndExit } = require('./getTasks');
const bot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_USERNAME, // Botのユーザー名
    password: process.env.MW_PASSWORD, // Botのパスワード
    userAgent: 'nanonaBot2/CPagemake 1.0.3 (Toolforge)',
    defaultParams: { format: 'json' }
});


// ログを保存
function logToFile(message, p) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(path.join(__dirname, './log/logs.txt'), logMessage);
    if (p === "pub") fs.appendFileSync(path.join(__dirname, './log/publogs.txt'), logMessage);
    console.log(logMessage.trim());
}

(async () => {
    await checkTaskStatusAndExit('nnId1');
    await bot.login();
    logToFile('ログイン成功');

    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    jst.setDate(jst.getDate() + 1);

    const year = jst.getFullYear();
    const month = jst.getMonth() + 1;
    const day = jst.getDate();
    const pageTemplateTitle = 'プロジェクト:カテゴリ関連/議論/日別ページ雛形';
    const newPageTitle = `プロジェクト:カテゴリ関連/議論/${year}年/${month}月${day}日`;

    //ページの存在確認
    const pageData = await bot.read(newPageTitle);
    logToFile(`ページデータ: ${JSON.stringify(pageData)}`);
    if (pageData?.missing === undefined) {
        logToFile(`[完了] ページ ${newPageTitle} はすでに存在します。`, "pub");
        return;
    }

    // テンプレートページの取得
    const templateData = await bot.read(pageTemplateTitle);
    logToFile(`テンプレートデータ: ${JSON.stringify(templateData)}`);
    const templateContent = templateData?.revisions[0]?.content;
    if (!templateContent) {
        logToFile('[失敗] テンプレートページの取得に失敗しました。', "pub");
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

    logToFile(`ページ内容:\n${newPageContent}`);
    logToFile(JSON.stringify(reedit01));

    if (reedit01.result === "Success") { logToFile(`[成功] 議論ページの作成: ${newPageTitle}`, "pub"); } else { logToFile(`議論ページの作成: ${newPageTitle}[${reedit01.result}]`, "pub"); }
})();
