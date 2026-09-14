# nanonaBot2-Toolforge

[m:User:NanonaBot2](https://meta.wikimedia.org/wiki/User:NanonaBot2)

日本語版Wikipediaで動作する、Node.js製のBotです。
Wikitextの解析・テンプレート展開・ページ生成・タスク状態の管理・実行ログの保存を、Wikimedia Toolforge上で運用することを想定しています。

## 主な機能

- Wikipedia APIを利用したBotタスクの実行
- カテゴリとテンプレートを対象にしたWikitext処理
- Wikimediaのレプリカデータベースを利用したページ検索
- MediaWiki上の設定ページによるタスクの稼働制御
- 公開ログ・非公開ログの保存と期間別アーカイブ
- ビルド時のバージョン情報生成とWikiへの反映

## タスク

| ファイル | task ID | 概要 |
| --- | --- | --- |
| `src/CPagemake.js` | `w-ja-nn1` | カテゴリ議論用日別ページを作成 |
| `src/old/gethighrevs.js` | `w-ja-nn2` | ~~レプリカDBを利用したページ処理~~→廃止 |
| `src/sandbox-clean.js` | `w-ja-nn3` | サンドボックスの砂場ならし |
| `src/subster.js` | `w-ja-nn4` | 自動subst展開 |
| `src/old/jawn-archiver.js` | `n-ja-nn1` | ~~自動アーカイブ処理~~→Wikinews閉鎖 |

`src/old/` 以下は旧タスクです。新規の定期実行設定に追加する場合は、処理内容を確認してから利用してください。

## 必要なもの

- Node.js 18以降を推奨
- Wikimedia Toolforgeアカウント
- BotアカウントとMediaWiki APIの認証情報
- `subster.js` と `gethighrevs.js` を利用する場合はWikimediaレプリカDBへの接続情報

## セットアップ

```sh
npm install
```

MediaWikiの認証情報は環境変数で設定します。

| 環境変数 | 用途 |
| --- | --- |
| `MW_USERNAME` | MediaWikiユーザー名 |
| `MW_PASSWORD` | MediaWikiパスワードまたはBotパスワード |
| `MW_NBOT2_USERNAME` | nanonaBot2専用ユーザー名。設定時は `MW_USERNAME` より優先 |
| `MW_NBOT2_PASSWORD` | nanonaBot2専用パスワード。設定時は `MW_PASSWORD` より優先 |
| `MW_NBOT1_USERNAME` / `MW_NBOT1_PASSWORD` | `subster.js` 用の優先認証情報 |
| `TOOL_REPLICA_USER` | レプリカDBユーザー名 |
| `TOOL_REPLICA_PASSWORD` | レプリカDBパスワード |

レプリカDBの環境変数を設定しない場合、`$HOME/replica.my.cnf`（Windowsでは `%USERPROFILE%/replica.my.cnf`）から `user` と `password` を読み込みます。


## 設定ページ

タスクの稼働状態は、Meta-Wikiの次のページから取得します。

- `User:NanonaBot2/tasks/data`

全体の稼働スイッチ `ALL` と各 `task ID` の値が `1` の場合にタスクが実行されます。タスク状態の更新は次のコマンドで実行できます。

```sh
node src/utils/getTasks.js update
```

`subster.js` は日本語版Wikipediaの次の設定ページを読み込みます。

- `利用者:NanonaBot2/w-ja-nn4/data.json`

このページには、対象カテゴリ、対象名前空間、SQL取得上限、テンプレート設定などを定義します。

## ビルド

```sh
npm run build
```

ビルドでは次の処理を行います。

- `src/` 以下のJavaScriptを `dist/` にコピー
- 各タスクのファイルハッシュを埋め込み
- `version_info.json` を生成
- `update-wiki.js` と `archive-logs.js` を `dist/` に配置
- `package.json` と `package-lock.json` を `dist/` にコピー

Toolforgeへ配置した後は、`dist/` 以下のタスクをジョブから実行します。例:

```sh
node dist/CPagemake.js
node dist/subster.js
```

ビルド後のバージョン情報をWikiへ反映する場合は、認証情報を設定したうえで実行します。

```sh
node dist/update-wiki.js
```

## ログ

ログはタスク実行ディレクトリの `logs/` に保存されます。

```text
logs/
├── public.jsonl
├── private.jsonl
├── public-archive/
└── private-archive/
```

ログのアーカイブは次のコマンドで実行します。

```sh
node dist/archive-logs.js
```

公開ログは日付別、非公開ログは年月別に整理されます。アーカイブ中のログ追記との競合を避けるため、アーカイブ処理と通常のログ追記はロックを共有します。

## 開発

タスクを追加・変更する場合は、次の点を確認してください。

1. `taskId` を定義し、`getTasks.js` の稼働制御対象にする。
2. MediaWiki APIの認証情報を環境変数から取得する。
3. 外部DBを利用する場合は、認証情報をコードへ埋め込まない。
4. `npm run build` を実行し、`dist/` の生成物を確認する。
5. Toolforgeのジョブ設定とWiki上のタスク状態を確認する。

