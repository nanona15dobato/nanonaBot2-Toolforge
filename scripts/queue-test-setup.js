/**
 * カテゴリキュー（w-ja-nn5）の試験環境を test.wikipedia.org に用意する
 *
 *   node scripts/queue-test-setup.js           試験用のページを作る（既にあれば初期状態に戻す）
 *   node scripts/queue-test-setup.js --check   作らずに、作るページの一覧と内容を表示する
 *
 * そのあと:
 *   node dist/category-queue.js --site test --dry-run   まず編集せずに確かめる
 *   node dist/category-queue.js --site test             実際に編集・返信する
 *   node dist/category-queue.js --site test --rollback <ID>
 *
 * 試験用のページはすべて「NanonaBot2キュー試験」で始まる名前にし、他の利用者のページと重ならないようにする。
 * 認証情報は本体と同じ環境変数（MW_NBOT2_USERNAME / MW_NBOT2_PASSWORD）。
 */
const { Mwn } = require('mwn');

const API = 'https://test.wikipedia.org/w/api.php';
const QUEUE_PAGE = 'User:NanonaBot2/カテゴリキュー';
const STOP_PAGE = `${QUEUE_PAGE}/緊急停止`;
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
    [`${P}/記事5`, `{{リダイレクトの所属カテゴリ}} の引数だけでカテゴリ名を書いているページ（検索で見つけて書き換えるはず。` +
        `検索の索引に載るまで数分かかることがある）。\n\n{{リダイレクトの所属カテゴリ\n|redirect1 = ${P}/リダイレクト\n|1-1 = ${P} Name1\n|1-2 = ${P} 残る\n}}`],

    // 議論場所（編集要約にリンクされる）
    [DISCUSSION_PAGE, `== 試験 ==
${P}の試験用の議論場所。`],

    // 緊急停止ページ（「動作中」のときだけ編集する）
    [STOP_PAGE, '<!-- 止めるには「停止中」などに書き換える -->\n動作中'],

    // キュー
    [QUEUE_PAGE, [
        `${P}のキュー（試験用）。見出しが「Bot:」で始まる節を node dist/category-queue.js --site test で処理する。`,
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
    module.exports = { PAGES, QUEUE_PAGE, STOP_PAGE, P };
} else (async () => {
    if (process.argv.includes('--check')) {
        for (const [title, text] of PAGES) console.log(`===== ${title}\n${text}\n`);
        return;
    }
    const bot = new Mwn({
        apiUrl: API,
        username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
        password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
        userAgent: 'nanonaBot2/CategoryQueueTestSetup (Toolforge)',
    });
    await bot.login();
    for (const [title, text] of PAGES) {
        const res = await bot.save(title, text, 'カテゴリキュー（w-ja-nn5）の試験の準備');
        console.log(`${res.result === 'Success' ? '○' : '×'} ${title}${res.nochange ? '（変更なし）' : ''}`);
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`\n用意しました: https://test.wikipedia.org/wiki/${encodeURI(QUEUE_PAGE.replace(/ /g, '_'))}`);
})().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
