/**
 * カテゴリキュー: 動かすウィキ（--site）。本体（category-queue.js）と試験の準備（scripts/queue-test-setup.js）で使う
 *
 * - ja:   本番。日本語版ウィキペディアのキュー
 * - test: 試験。test.wikipedia.org の利用者ページにキューを置き、試験用のカテゴリ・記事で実際に編集する
 * - ptw:  試験。publictestwiki.com（TestWiki）。Wikimedia のアカウントとは別なので、認証情報も別の環境変数で渡す
 * 試験用のウィキは Bot フラグが無いので assert=bot を付けず、メタの稼働スイッチも見ない。
 *
 * search: {{リダイレクトの所属カテゴリ}} の引数にだけカテゴリ名を書いたページの探し方
 *   backlinks  カテゴリにリンクしていて、テンプレートを使っているページ（テンプレートは引数のカテゴリにリンクを出す）。
 *              リンク表から読むので、検索の索引の遅れや件数の上限が無い
 *   embeddedin テンプレートを使っているページをすべて対象にする（テンプレートが無く、リンクが出ない試験用のウィキ。
 *              カテゴリ名を含まないページは「変更なし」になるだけ）
 *
 * replaceLinks: カテゴリへのリンク（[[:Category:A]]、テンプレートの引数の :Category:A など）も書き換えるか。
 *   今は無効。環境変数 CATEGORY_QUEUE_REPLACE_LINKS=1 / 0 で、コードを変えずに有効・無効を切り替えられる
 */
const SITES = {
    ja: {
        apiUrl: 'https://ja.wikipedia.org/w/api.php',
        queuePage: 'プロジェクト:カテゴリ関連/キュー',
        stopPage: 'プロジェクト:カテゴリ関連/キュー/緊急停止',
        dataDir: 'data/category-queue',
        assertBot: true,
        taskSwitch: true,
        search: 'backlinks',
        replaceLinks: false,
        credentials: ['MW_NBOT2', 'MW'],
    },
    test: {
        apiUrl: 'https://test.wikipedia.org/w/api.php',
        queuePage: 'User:NanonaBot2/カテゴリキュー',
        stopPage: 'User:NanonaBot2/カテゴリキュー/緊急停止',
        dataDir: 'data/category-queue-test',
        assertBot: false,
        taskSwitch: false,
        search: 'embeddedin', // testwiki には {{リダイレクトの所属カテゴリ}} が無い
        replaceLinks: false,
        credentials: ['MW_NBOT2', 'MW'],
    },
    ptw: {
        apiUrl: 'https://publictestwiki.com/w/api.php',
        queuePage: 'User:Nanona15dobato/カテゴリキュー',
        stopPage: 'User:Nanona15dobato/カテゴリキュー/緊急停止',
        dataDir: 'data/category-queue-ptw',
        assertBot: false,
        taskSwitch: false,
        search: 'embeddedin',
        replaceLinks: false,
        credentials: ['MW_PTW'],
    },
};

/**
 * カテゴリへのリンクも書き換えるか（環境変数 CATEGORY_QUEUE_REPLACE_LINKS が 1 / 0 なら、それを優先する）
 */
function linksEnabled(site, env = process.env) {
    const v = env.CATEGORY_QUEUE_REPLACE_LINKS;
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return Boolean(site.replaceLinks);
}

/** 試験用のウィキの記録の置き場所（Web の詳細ページが本番の次に探す） */
const TEST_DATA_DIRS = Object.values(SITES).filter(s => !s.taskSwitch).map(s => s.dataDir);

/**
 * --site / --queue-page / --stop-page を読む（Bot を作る前に呼ぶ）
 * @param {string[]} argv
 */
function resolveSite(argv) {
    const value = name => {
        const i = argv.indexOf(name);
        return i === -1 ? null : argv[i + 1];
    };
    const name = value('--site') || 'ja';
    if (!SITES[name]) throw new Error(`--site は ${Object.keys(SITES).join(' / ')} のどれかです`);
    return { name, ...SITES[name], queuePage: value('--queue-page') || SITES[name].queuePage, stopPage: value('--stop-page') || SITES[name].stopPage };
}

/**
 * ログインに使う利用者名とパスワード。credentials の接頭辞の順に <接頭辞>_USERNAME / <接頭辞>_PASSWORD を探す
 * @returns {{username: string|undefined, password: string|undefined}}
 */
function siteCredentials(site, env = process.env) {
    for (const prefix of site.credentials) {
        if (env[`${prefix}_USERNAME`]) return { username: env[`${prefix}_USERNAME`], password: env[`${prefix}_PASSWORD`] };
    }
    return { username: undefined, password: undefined };
}

module.exports = { SITES, TEST_DATA_DIRS, resolveSite, siteCredentials, linksEnabled };
