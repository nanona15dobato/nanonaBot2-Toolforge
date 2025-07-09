const { Mwn } = require('mwn');
const fs = require('fs');
const path = require('path');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { parseTemplate, splitWithContext, escapeRegex, parseSection } = require('./utils/parse.js');
const { logger } = require("./utils/logger");
const taskId = 'nnId3';


const revlimit = 4500; // 報告版数

const bot = new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_USERNAME,
    password: process.env.MW_PASSWORD,
    userAgent: 'nanonaBot2/sandbox-clean 0.2.0',
    defaultParams: { format: 'json' }
});

const sandboxes = {
    /*"サンドボックス名": ["初期wikitext(subst展開)", "WP:ANのセクション名"],*/
    //"Wikipedia:サンドボックス": ["サンドボックスの初期化","サンドボックスの初期化依頼"],
    "Wikipedia‐ノート:サンドボックス": ["ノート用サンドボックスの初期化", "サンドボックスの初期化依頼"],
    "Help:ビジュアルエディター/sandbox": ["ビジュアルエディター用サンドボックスの初期化", "ビジュアルエディター/sandboxの初期化依頼"],
    "Help:VisualEditor_sandbox": ["利用者:Nanona15dobato/VisualEditor sandbox 初期化用", "ビジュアルエディター/sandboxの初期化依頼"],
};

async function cleanstart() {
    await checkTaskStatusAndExit(taskId);
    await bot.login();
    let ANreq = [];
    for (const [sandboxTitle, [templatename, ANscname]] of Object.entries(sandboxes)) {
        console.log(`処理中: ${sandboxTitle} (${templatename})`);

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
            logger.error(taskId, `通常版取得エラー: ${e.message}`, true);
            process.exit(1);
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
            logger.error(taskId, `削除済み版取得エラー: ${e.message}`, true);
            process.exit(1);
        }

        const total = revcount + deletedrevcount;
        console.log(`合計 ${total} 版`);


        if (total >= revlimit) {
            ANreq.push({
                title: sandboxTitle,
                total: total,
                ANscname: ANscname
            });
            logger.info(taskId, `版数が ${revlimit} 以上のため、貝塚送りを依頼: ${sandboxTitle}（版数: ${total}）`, true);
            continue;
        }
        if (sandboxTitle !== "Wikipedia:サンドボックス") {
            const summary = `Bot： 砂場ならし（削除済みを含めた版数: ${total >= 5000 ? '5000以上' : total}）`;
            const re = await bot.save(sandboxTitle, `{{subst:${templatename}}}`, summary, {
                minor: true,
                bot: true
            });
            console.log(`白紙化中: ${sandboxTitle} (${templatename})`, summary);
            if (re.nochange) {
                logger.info(taskId, `白紙化不要: ${sandboxTitle}（版数: ${total}）`, true);
            } else if (re.result === 'Success') {
                logger.success(taskId, `白紙化しました: ${sandboxTitle}（版数: ${total}）`, true);
            } else {
                logger.error(taskId, `白紙化に失敗しました: ${sandboxTitle}（版数: ${total}）`, true);
            }
        }

    }
    if (ANreq.length > 0) {
        await bot.edit('Wikipedia:管理者伝言板/各種初期化依頼', (rev) => {
        //await bot.edit('利用者:NanonaBot2/Sandbox2', (rev) => {
            let text = rev.content;
            let newtext = '';
            let Insection = [];
            let ANsections = parseSection(text, 3);
            console.log(ANsections);
            for (const req of ANreq) {
                let sandboxSection = ANsections.find(section => section.name === req.ANscname && section.seclevel === 2);
                if (!sandboxSection && !Insection.includes(req.ANscname)) {
                    text += `\n\n== ${req.ANscname} ==\n=== ${req.title}の貝塚送り ===\n* {{Page|${req.title}}} (${req.total}版)の貝塚送りをお願い致します。--~~~~\n`;
                    ANsections = parseSection(text, 3);
                    console.log(ANsections);
                    Insection.push(req.ANscname);
                    continue;
                }
                let sandboxTitle = ANsections.find(section => section.name === `${req.title}の貝塚送り` && section.seclevel === 3);
                if (!sandboxTitle) {
                    text = text.replace(sandboxSection.wikitext, sandboxSection.wikitext + `\n=== ${req.title}の貝塚送り ===\n* {{Page|${req.title}}} (${req.total}版)の貝塚送りをお願い致します。--~~~~\n`);
                }
            }

            return {
                text: text,
                notminor: true,
                bot: false,
                summary: `Bot： サンドボックスの初期化依頼（${ANreq.length}件）`,
            }
        }).then(res => {
            if (res.result === 'Success') {
                console.log('初期化依頼を送信しました:', res);
                logger.success(taskId, `サンドボックス初期化依頼を提出しました: ${ANreq.length}件`, true);
            } else {
                console.error('初期化依頼の送信に失敗しました:', res);
                logger.error(taskId, `サンドボックス初期化依頼の提出に失敗しました`, true);
            }
        }).catch(err => {
            console.error('初期化依頼の送信に失敗しました:', err);
            logger.error(taskId, `サンドボックス初期化依頼の提出に失敗しました`, true);
        });
    }
}

cleanstart().catch(err => {
    console.error('エラー:', err);
});
