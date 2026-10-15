/**
 * カテゴリキュー（w-ja-nn5）の試験環境を、試験用のウィキ（test.wikipedia.org / publictestwiki.com）に用意する
 *
 *   node scripts/queue-test-setup.js [--site test|ptw]           試験用のページを作る（既にあれば初期状態に戻す）
 *   node scripts/queue-test-setup.js [--site test|ptw] --check   作らずに、作るページの一覧と内容を表示する
 *
 * そのあと（--site は同じものを付ける）:
 *   node dist/category-queue.js --site test --dry-run   まず編集せずに確かめる
 *   node dist/category-queue.js --site test             実際に編集・返信する
 *   node dist/category-queue.js --site test --rollback <ID>
 *
 * 試験用のページはすべて「NanonaBot2キュー試験」で始まる名前にし、他の利用者のページと重ならないようにする。
 * キューページ・緊急停止ページ・認証情報は本体と同じ（utils/categoryQueue/sites.js）。
 * test は MW_NBOT2_USERNAME / MW_NBOT2_PASSWORD、ptw は MW_PTW_USERNAME / MW_PTW_PASSWORD。
 */
const { Mwn } = require('mwn');
// 手元では src/ に、Toolforge の ~/bot ではビルド済みのもの（utils/ が直下）にある
const { SITES, siteCredentials } = (() => {
    for (const dir of ['../src', '..', '../dist']) {
        try {
            return require(`${dir}/utils/categoryQueue/sites`);
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes('categoryQueue/sites')) throw e;
        }
    }
    throw new Error('utils/categoryQueue/sites.js が見つかりません（src/・ビルド済みの utils/・dist/ のどこにもない）');
})();

const SITE_NAME = (() => {
    const i = process.argv.indexOf('--site');
    return i === -1 ? 'test' : process.argv[i + 1];
})();
const SITE = SITES[SITE_NAME];
if (!SITE || SITE.taskSwitch) {
    throw new Error(`--site は試験用のウィキ（${Object.keys(SITES).filter(k => !SITES[k].taskSwitch).join(' / ')}）を指定してください`);
}
const QUEUE_PAGE = SITE.queuePage;
const STOP_PAGE = SITE.stopPage;
const P = 'NanonaBot2キュー試験';
const cat = name => `Category:${P} ${name}`;
const link = name => `[[:${cat(name)}]]`;
// 議論場所は標準名前空間のページにする（利用者ページへのリンクは署名とみなして議論場所にしない）
const DISCUSSION_PAGE = `${P}/議論`;
const DISCUSSION = `[[${DISCUSSION_PAGE}#試験]]を参照。~~~~`;

/** 作るページ（名前 → 本文）。順番どおりに作る（カテゴリ → 記事 → キューの順） */
const PAGES = [
    // カテゴリ（移動元・移動先。「存在しない」は作らない）
    [cat('Name1'), `${P}の移動元カテゴリ（試験用）。`],
    [cat('Name2'), `${P}の移動先カテゴリ（試験用）。`],
    [cat('Name3'), `${P}の除去するカテゴリ（試験用）。`],
    [cat('Name1 下位'), `${P}の下位カテゴリ（試験用）。\n[[${cat('Name1')}| ]]`],

    // 記事（移動元 Name1 に入っているもの）
    [`${P}/記事1`, `ソートキー付きのカテゴリ。\n\n[[${cat('Name1')}|きじ1]]\n[[${cat('Name3')}]]`],
    [`${P}/記事2`, `空白だけのソートキーと、他のカテゴリ。\n\n[[${cat('Name1')}| ]]\n[[Category:${P} 残る]]`],
    [`${P}/記事3`, `{{nobots}}\nBot の編集を拒否しているページ（編集できなかったとして報告されるはず）。\n\n[[${cat('Name1')}]]`],
    [`${P}/記事4`, `移動先が既にあるページ（移動元のタグを消すだけのはず）。\n\n[[${cat('Name1')}]]\n[[${cat('Name2')}]]`],
    [`${P}/記事5`, `{{リダイレクトの所属カテゴリ}} の引数だけでカテゴリ名を書いているページ（見つけて書き換えるはず。` +
        '試験用のウィキにはこのテンプレートが無いので、テンプレートを使っているページとして見つける）。' +
        `\n\n{{リダイレクトの所属カテゴリ\n|redirect1 = ${P}/リダイレクト\n|1-1 = ${P} Name1\n|1-2 = ${P} 残る\n}}`],

    // テンプレート経由（呼び出し先だけを Name1 に入れるテンプレートと、それを呼び出す記事）。
    // 記事6 は「変更なし」になり、原因のテンプレートを書き換えた後、記事6 を null edit して Name1 から外れるはず
    [`Template:${P} ナビ`, `${P}の試験用のテンプレート。呼び出したページを移動元カテゴリに入れる。<includeonly>[[${cat('Name1')}]]</includeonly>`],
    [`${P}/記事6`, `テンプレート経由でだけ移動元に入っているページ。\n\n{{${P} ナビ}}`],

    // 議論場所（編集要約にリンクされる）
    [DISCUSSION_PAGE, `== 試験 ==
${P}の試験用の議論場所。`],

    // 緊急停止ページ（「動作中」のときだけ編集する）
    [STOP_PAGE, '<!-- 止めるには「停止中」などに書き換える -->\n動作中'],

    // キュー
    [QUEUE_PAGE, [
        `${P}のキュー（試験用）。見出しが「Bot:」で始まる節を node dist/category-queue.js --site ${SITE_NAME} で処理する。`,
        '',
        `== Bot: ${link('Name1')}を${link('Name2')}へ ==`,
        `${DISCUSSION}`,
        '',
        `== Bot: (記事) ${link('Name3')}を除去 ==`,
        `${DISCUSSION}`,
        '',
        `== Bot: [[${cat('Name1')}]]を除去 ==`,
        `コロンの無いリンク（不受理になるはず）。${DISCUSSION}`,
        '',
        `== Bot: ${link('Name1')}を${link('存在しない')}へ ==`,
        `移動先が無い（不可能になるはず）。${DISCUSSION}`,
        '',
        `== Bot: ${link('Name1')}を${link('Name2')}に複製 ==`,
        `複製は受け付けない（不受理になるはず）。${DISCUSSION}`,
        '',
        `== ${link('Name1')}を除去 ==`,
        `「Bot:」の無い節（異議あり。処理されないはず）。${DISCUSSION}`,
        '',
    ].join('\n')],
];

// 試験の段取りを偽のウィキで確かめるときに読めるようにする
if (require.main !== module) {
    module.exports = { PAGES, QUEUE_PAGE, STOP_PAGE, P, SITE_NAME };
} else (async () => {
    if (process.argv.includes('--check')) {
        for (const [title, text] of PAGES) console.log(`===== ${title}\n${text}\n`);
        return;
    }
    const bot = new Mwn({
        apiUrl: SITE.apiUrl,
        ...siteCredentials(SITE),
        userAgent: 'nanonaBot2/CategoryQueueTestSetup (Toolforge)',
    });
    if (!bot.options.username) throw new Error(`認証情報がありません（環境変数 ${SITE.credentials.map(p => `${p}_USERNAME / ${p}_PASSWORD`).join(' または ')}）`);
    await bot.login();
    for (const [title, text] of PAGES) {
        const res = await bot.save(title, text, 'カテゴリキュー（w-ja-nn5）の試験の準備');
        console.log(`${res.result === 'Success' ? '○' : '×'} ${title}${res.nochange ? '（変更なし）' : ''}`);
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`\n用意しました: ${new URL(SITE.apiUrl).origin}/wiki/${encodeURI(QUEUE_PAGE.replace(/ /g, '_'))}`);
})().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
