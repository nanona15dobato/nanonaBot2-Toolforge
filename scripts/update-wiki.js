const fs = require('fs');
const path = require('path');
const { Mwn } = require('mwn');
const bot = new Mwn({
    apiUrl: 'https://meta.wikimedia.org/w/api.php',
    username: process.env.WIKI_USERNAME,
    password: process.env.WIKI_PASSWORD,
    userAgent: 'nanonaBot2-Deployer/1.0 (GitHub Actions)',
    defaultParams: { format: 'json' }
});

async function updateWiki() {
    const jsonPath = path.join(__dirname, '..', 'version_info.json');
    const jsonData = fs.readFileSync(jsonPath, 'utf8');
    await bot.login();
    const pageTitle = 'User:NanonaBot2/tasks.json';
    const pageData = await bot.read(pageTitle);
    const wikiContent = pageData?.revisions[0]?.content || '';
    const wikijson = JSON.parse(wikiContent || '{}');

    wikijson['NanonaBot2'] = {
        overall_version: jsonData.overall_version || wikijson['NanonaBot2']?.overall_version || '0.0.0',
        build_date: jsonData.build_date || wikijson['NanonaBot2']?.build_date || new Date().toISOString()
    };
    Object.keys(jsonData.files || {}).forEach(taskId => {
        const fileInfo = jsonData.files[taskId];
        wikijson[taskId]['version'] = fileInfo.hash || wikijson[taskId]?.version || '0.0.0';
        wikijson[taskId]['lastupdate'] = fileInfo.last_updated || wikijson[taskId]?.lastupdate || new Date().toISOString();
    });

    try {
        await bot.save(pageTitle, JSON.stringify(wikijson), '自動デプロイ: バージョン情報を更新');
        console.log(`Successfully updated ${pageTitle}`);
    } catch (err) {
        console.error('Failed to update wiki:', err);
        process.exit(1); // Actionsのジョブを失敗扱いにするためエラー終了
    }
}

updateWiki();