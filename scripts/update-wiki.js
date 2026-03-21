const fs = require('fs');
const path = require('path');
const { Mwn } = require('mwn');
const username = process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME;
const password = process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD;
const userAgent = 'nanonaBot2-Deployer/1.0 (GitHub Actions)';
const bot = new Mwn({
    apiUrl: 'https://meta.wikimedia.org/w/api.php',
    username,
    password,
    userAgent,
    defaultParams: { format: 'json' }
});
const jawpbot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username,
    password,
    userAgent,
    defaultParams: { format: 'json' }
});

async function updateWiki() {
    const jsonPath = path.join(__dirname, 'version_info.json');
    let jsonData;
    try {
        jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
        console.error(`Failed to parse version_info.json at ${jsonPath}:`, err);
        process.exit(1);
    }
    await bot.login();
    await jawpbot.login();
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
        await jawpbot.save(pageTitle, JSON.stringify(wikijson), '自動デプロイ: バージョン情報を更新');
        console.log(`Successfully updated ${pageTitle}`);
    } catch (err) {
        console.error('Failed to update wiki:', err);
        process.exit(1);
    }
}

updateWiki();