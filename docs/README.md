# nanonaBot2 ドキュメント

nanonaBot2（Toolforge ツール `nanonabot2-01`）の仕様と運用の資料です。使い方の概要はリポジトリ直下の [README](../README.md) を見てください。

| 資料 | 内容 |
| --- | --- |
| [operations.md](operations.md) | 運用の仕組み。タスク台帳・稼働スイッチ・ビルドとデプロイ・ジョブ・ログ・編集間隔制御・認証情報・データファイル |
| [category-queue.md](category-queue.md) | カテゴリキュー処理（`w-ja-nn5`）の仕様。キュー構文・実行フロー・書き換え規則・返信・安全策・取り消し |
| [parser.md](parser.md) | wikitext パーサー parse2（`src/utils/parse2.js`）の仕様。出力形式・処理方式・旧版との違い・性能 |
| [web.md](web.md) | nanonaBot2 Web（`www/js`）の画面と API。カテゴリキューの実行状況表示を含む |

## ファイル構成

```text
bot/
├── src/                     タスク本体（ビルドで dist/ にコピーされ、Toolforge では ~/bot/ に置かれる）
│   ├── CPagemake.js         w-ja-nn1 カテゴリ議論の日別ページ作成
│   ├── sandbox-clean.js     w-ja-nn3 砂場ならし
│   ├── subster.js           w-ja-nn4 自動subst展開
│   ├── category-queue.js    w-ja-nn5 カテゴリキューの処理
│   ├── old/                 廃止したタスク
│   └── utils/
│       ├── parse2.js        wikitext パーサー
│       ├── parse.js         旧来の補助関数（allowBots など）
│       ├── getTasks.js      稼働スイッチ
│       ├── editThrottle.js  編集間隔制御
│       ├── logger.js        ログ
│       └── categoryQueue/   w-ja-nn5 の部品（queue / replacer / report / status / title）
├── scripts/                 ビルド・台帳・Wiki反映・ログ整理
├── test/                    node:test のテスト（npm test）
│   ├── fixtures/            テスト用の実ページ wikitext
│   └── legacy/              比較用の旧版 parse2
├── docs/                    この資料
└── tasks.json               タスク台帳
```

## 用語

| 用語 | 意味 |
| --- | --- |
| task ID | タスクの識別子。`w-ja-nn5` のように「プロジェクト-言語-連番」。ソースの `const taskId` と `tasks.json` のキーが一致する |
| 稼働スイッチ | メタの `User:NanonaBot2/tasks/data` にある `'ALL'='1'` などの値。`1` のタスクだけ動く |
| 緊急停止ページ | カテゴリキュー専用の停止手段。`プロジェクト:カテゴリ関連/キュー/緊急停止` |
| dist | `npm run build` で作る配布物。Toolforge にはこれを置く |
