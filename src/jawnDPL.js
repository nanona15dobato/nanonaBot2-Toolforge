/**
 * Ladsgroupさんのコード
 * https://phabricator.wikimedia.org/P92102 より改変
 */

const { Mwn } = require('mwn');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require("./utils/logger");
const { allowBots } = require('./utils/parse.js');


const taskId = 'n-ja-nn2';
const nnversion = '__FILE_HASH__';


/**
 * HTMLをパースして <a> タグを [[Wikitext]] リンクに変換。
 * @param {string} htmlContent 
 * @returns {string}
 */
function convertHtmlLinksToWikitext(htmlContent) {
    const $ = cheerio.load(htmlContent);

    $('a').each((i, el) => {
        const a = $(el);
        const linkTarget = a.attr('title');
        const linkText = a.text();

        if (linkTarget) {
            const newLink = linkTarget !== linkText ? `[[${linkTarget}|${linkText}]]` : `[[${linkTarget}]]`;
            a.replaceWith(newLink);
        } else {
            const href = a.attr('href');
            if (href) {
                a.replaceWith(`[${href} ${linkText}]`);
            }
        }
    });

    return $.root().text();
}

async function processCategory() {
    const bot = await new Mwn({
        apiUrl: 'https://ja.wikinews.org/w/api.php',
        username: process.env.MW_N15_USERNAME,
        password: process.env.MW_N15_PASSWORD,
        userAgent: `DPLReplacerBot [${nnversion}] (User:nanona15dobato)`
    });
    await checkTaskStatusAndExit(taskId);
    await bot.login();

    console.log('Bot initialized.');

    const searchResults = bot.continuedQueryGen({
        action: 'query',
        list: 'search',
        srsearch: 'insource:"DynamicPageList"',
        srnamespace: '*',
        srlimit: 'max'
    });

    const dplPattern = /<DynamicPageList[^>]*>([\s\S]*?)<\/DynamicPageList\s*>/gi;

    for await (const json of searchResults) {
        for (const result of json.query.search) {
            const title = result.title;
            const titleSpaces = title.replace(/_/g, ' ');
            console.log(`Checking page: ${titleSpaces}`);

            if (titleSpaces.includes('Main page') || title.includes('Newsroom') || titleSpaces.includes('Water cooler')) {
                continue;
            }

            let text;
            try {
                const pageData = await bot.read(title);
                text = pageData.revisions[0].content;
            } catch (e) {
                console.error(`Failed to read ${title}:`, e.message);
                continue;
            }

            const matches = [...text.matchAll(dplPattern)];
            if (matches.length === 0) continue;

            let newText = text;
            let textChanged = false;

            for (const match of matches) {
                const fullTag = match[0];
                const dplContent = match[1];
                if (dplContent.includes('nowiki') || dplContent.includes('DynamicPageList') || dplContent.includes('{')) {
                    continue;
                }

                console.log("Found DPL content. Sending to API for parsing...");

                try {
                    const parseResponse = await bot.request({
                        action: 'parse',
                        text: fullTag,
                        contentmodel: 'wikitext',
                        disablelimitreport: true
                    });

                    const htmlOutput = parseResponse.parse.text;

                    if (typeof htmlOutput !== 'string') {
                        console.warn(`Warning: Unexpected API response for ${title}`);
                        continue;
                    }

                    let staticWikitext = convertHtmlLinksToWikitext(htmlOutput).trim();

                    if (staticWikitext.includes('\n')) {
                        staticWikitext = '*' + staticWikitext.split('\n').join('\n*');
                    }

                    const bracketCount = (staticWikitext.match(/\[\[/g) || []).length;
                    if (bracketCount === 1 && !staticWikitext.startsWith('*')) {
                        staticWikitext = '*' + staticWikitext;
                    }

                    console.log(staticWikitext);

                    newText = newText.replace(fullTag, staticWikitext.trim());
                    textChanged = true;

                } catch (e) {
                    console.error(`Failed to parse DPL on ${title}:`, e.message);
                }
            }

            if (textChanged && newText !== text) {/*
                const outputPath = path.join(__dirname, 'processed_pages', `${titleSpaces.replace(/\//g, '_')}.txt`);
                try {
                    await fs.writeFile(outputPath, newText, 'utf-8');
                    console.log(`Saved processed content of ${title} to ${outputPath}`);
                } catch (e) {
                    console.error(`Failed to save processed content of ${title}:`, e.message);
                }*/
                try {
                    await bot.save(title, newText, "Bot: DynamicPageList→wikitext ([[phab:T421796]]).", { minor: true, bot: true });
                    console.log(`Saved ${title} successfully.`);
                } catch (e) {
                    console.error(`Failed to save ${title}:`, e.message);
                }
            }
        }
    }
}

processCategory().catch(console.error);