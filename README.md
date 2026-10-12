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

タスクの情報はすべて [`tasks.json`](tasks.json)（タスク台帳）で管理します。
名前・説明・実行ファイル・cron・使用申請・廃止の扱いはここだけを書き換えてください。

| task ID | ファイル | 状態 | 概要 |
| --- | --- | --- | --- |
| `w-ja-nn1` | `src/CPagemake.js` | 稼働 | カテゴリ議論用日別ページを作成 |
| `w-ja-nn2` | `src/old/gethighrevs.js` | 廃止 | 版数の多いページの抽出 |
| `w-ja-nn3` | `src/sandbox-clean.js` | 稼働 | サンドボックスの砂場ならし |
| `w-ja-nn4` | `src/subster.js` | 稼働 | 自動subst展開 |
| `n-ja-nn1` | `src/old/jawn-archiver.js` | 廃止 | 記事の自動アーカイブ（Wikinews閉鎖） |

一覧は次のコマンドで確認できます（台帳の検証も兼ねます）。

```sh
node scripts/task-registry.js check
```

### tasks.json の書き方

```jsonc
{
  "defaults": { "image": "node18", "deployDir": "bot", "logDir": "logs" },
  "tasks": {
    "w-ja-nn1": {
      "status": "active",            // active（稼働対象） / retired（廃止）
      "taskname": "種別I:...",        // メタの一覧に表示する名前（wikitext可）
      "description": "...",          // 説明（wikitext可）
      "file": "CPagemake.js",        // src/ からの相対パス。const taskId と一致させる
      "botstemplate": "NA",          // {{bots}}対応: "1" / "0" / "NA"
      "reqlink": ":w:ja:利用者:NanonaBot2/使用申請",
      "job": { "name": "cat-disc-make", "schedule": "0 19 * * *" },  // cronはUTC
      "execTime": "..."              // 省略時は schedule から「毎日午前4時(JST)」等を自動生成
    }
  },
  "jobs": {                          // タスク以外の定期ジョブ（ログ整理など）
    "archive-logs": { "command": "node bot/archive-logs.js", "schedule": "0 0 * * *" }
  }
}
```

### タスクを廃止するとき

1. `status` を `"retired"` にし、`retired` に日付と理由を書く。
   ```json
   "retired": { "date": "2026-09-14", "reason": "履歴保存の廃止に伴い終了" }
   ```
2. 必要ならファイルを `src/old/` へ移し、`file` を合わせる。`job` は記録として残してよい。

廃止したタスクは次のように扱われます。

- `myjobs.yaml` に出力されない（既存のジョブは手動で削除する。下記「ジョブ（cron）の反映」参照）
- メタの一覧で「廃止」と表示され、停止・変更リンクが出ない
- メタの稼働スイッチが `1` のままでも `checkTaskStatusAndExit` が実行前に終了する

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

全体の稼働スイッチ `ALL` と各 `task ID` の値が `1` の場合にタスクが実行されます（廃止タスクは除く）。
一時停止・再開はこのページで、恒久的な廃止は `tasks.json` で行います。タスク状態の更新は次のコマンドで実行できます。

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

- `tasks.json` を検証（ソースの `taskId` との対応、ファイルの有無、cron など）
- `src/` 以下のJavaScriptを `dist/` にコピー
- 各タスクのファイルハッシュを埋め込み
- `version_info.json` を生成（メタウィキ用JSONを含む）
- `tasks.json` を `dist/` にコピーし、`dist/myjobs.yaml` を生成
- `update-wiki.js` と `archive-logs.js` を `dist/` に配置
- `package.json` と `package-lock.json` を `dist/` にコピー

Toolforgeへ配置した後は、`dist/` 以下のタスクをジョブから実行します。例:

```sh
node dist/CPagemake.js
node dist/subster.js
```

`update-wiki.js` は `User:NanonaBot2/tasks.json`（メタ・jawp）を台帳から生成した内容で置き換えます。Wiki上で直接編集した内容は次のデプロイで上書きされるため、変更は `tasks.json` に行ってください。

```sh
node dist/update-wiki.js
```

### ジョブ（cron）の反映

デプロイ先では `bot/myjobs.yaml` が生成されます。手動で反映する場合:

```sh
toolforge jobs load bot/myjobs.yaml
```

`jobs load` はファイルにないジョブを削除しません。タスクを廃止したときは、そのジョブを手動で削除してください。

```sh
toolforge jobs delete <ジョブ名>
```

GitHubのリポジトリ変数 `TOOLFORGE_LOAD_JOBS` を `true` にすると、デプロイ時に自動で反映します。

### Webからの参照

Web（nanonaBot2Web）からは、ツールのホームにある次のファイルを読めばタスク情報を表示できます。

- `bot/tasks.json` … 台帳そのもの
- `bot/version_info.json` … バージョン・ビルド日時と、メタ表示用に整形済みの `wiki`

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

1. `taskId` を定義し、`getTasks.js` の稼働制御対象にする。`tasks.json` にも同じIDで登録する。
2. MediaWiki APIの認証情報を環境変数から取得する。
3. 外部DBを利用する場合は、認証情報をコードへ埋め込まない。
4. `npm run build` を実行し、`dist/` の生成物を確認する。
5. `myjobs.yaml` の生成結果とWiki上のタスク状態を確認する。

