# 運用の仕組み

nanonaBot2 の全タスクに共通する仕組みです。タスク固有の仕様は各資料を見てください。

## タスク台帳（tasks.json）

タスクの名前・説明・実行ファイル・cron・使用申請・廃止の扱いは `tasks.json` だけに書きます。ここから次のものが作られます（`scripts/task-registry.js`）。

| 生成物 | 使い道 |
| --- | --- |
| `dist/myjobs.yaml` | Toolforge jobs の定義。`status: active` かつ `job` のあるタスクと、`jobs` に書いた定期ジョブだけを出力する |
| `version_info.json` の `wiki` | メタ・jawp の `User:NanonaBot2/tasks.json`（タスク一覧の表示用） |

主な項目は次のとおりです。書き方の例は README を見てください。

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `status` | ○ | `active`（稼働対象）/ `retired`（廃止） |
| `taskname` / `description` | ○ | メタの一覧に出す名前と説明（wikitext 可） |
| `file` | ○ | `src/` からの相対パス。そのファイルに同じ `const taskId` が必要 |
| `botstemplate` | ○ | `{{bots}}` 対応。`"1"` / `"0"` / `"NA"` |
| `reqlink` | ○ | 使用申請へのリンク |
| `job` | | `{ name, schedule }`。schedule は UTC の cron。無いタスクは手動実行（一覧では「不定期」） |
| `execTime` | | 実行間隔の表示。省略時は schedule から「毎日午前4時(JST)」などを作る |
| `retired` | | 廃止時の `{ date, reason }` |

検証は `node scripts/task-registry.js check`（ビルド時にも実行）。次のどれかに当たるとビルドが失敗します。

- `file` が無い、`const taskId` が無い、同じ taskId が複数のファイルにある
- cron の書式・範囲が不正、ジョブ名の重複
- schedule から実行間隔を作れないのに `execTime` が無い

## 稼働スイッチ（utils/getTasks.js）

メタの `User:NanonaBot2/tasks/data` に `'ALL'='1'` `'w-ja-nn5'='1'` の形で書きます。タスクは起動時に `checkTaskStatusAndExit(taskId)` を呼び、次の場合は何もせず終了します。

| 状態 | 終了コード |
| --- | --- |
| `tasks.json` で `retired` | 0 |
| `ALL` が `1` 以外、またはそのタスクの値が `1` 以外 | 0 |
| ページを読めない・値が無い | 1 |

`node bot/utils/getTasks.js update`（ジョブ `checktasks`、毎時45分）は、メタの値が前回（`data/lastTaskData.json`）と違うときだけ jawp の `利用者:NanonaBot2/tasks/data` に写します。一時停止・再開はメタで、恒久的な廃止は `tasks.json` で行います。

## ビルドとデプロイ（scripts/build.js）

`npm run build` は次を行います。

1. `src/` 以下の `.js` を `dist/` にコピーし、`__FILE_HASH__` をファイルの MD5 先頭8桁に置き換える（User-Agent に入る）
2. `tasks.json` を検証する
3. `package.json`・`package-lock.json`・`tasks.json`・`update-wiki.js`・`archive-logs.js` を `dist/` に置く
4. `version_info.json`（バージョン・ビルド日時・各タスクのハッシュと最終更新・メタ用 JSON）と `dist/myjobs.yaml` を作る

Toolforge ではツールのホームの `bot/` に `dist/` の中身を置きます。`node dist/update-wiki.js` は `User:NanonaBot2/tasks.json`（メタ・jawp）を台帳の内容で丸ごと置き換えます。

ジョブの反映は `toolforge jobs load bot/myjobs.yaml` です。`jobs load` は台帳から消えたジョブを削除しないため、廃止したタスクのジョブは `toolforge jobs delete <名前>` で消します。GitHub のリポジトリ変数 `TOOLFORGE_LOAD_JOBS` を `true` にするとデプロイ時に自動で反映します。

## 編集間隔制御（utils/editThrottle.js）

すべてのジョブ（別プロセス・別 Pod）で共有するファイルを使い、同じウィキへの編集を **5秒以上** 空けます。

```text
data/edit-throttle/<ウィキのホスト名>/
├── edit.lock/   鍵（mkdir がアトミックなことを利用。60秒持ったままなら落ちたとみなす）
├── last-edit    最後に編集を送り始めた時刻
└── priority/    通常優先度のジョブが待っていることを示す札（10分で古いとみなす）
```

`applyEditThrottle(bot, { priority })` で mwn の `request({ action: 'edit' })` を包みます。`priority: 'low'`（subster・カテゴリキューなど大量処理）は、札が1枚でもあれば通常優先度のジョブに編集を譲ります。

## ログ（utils/logger.js・scripts/archive-logs.js）

`logger.success / info / warning / error(taskId, message, isPublic, extra)` で記録します。

| ファイル | 内容 |
| --- | --- |
| `logs/private.jsonl` | すべての記録 |
| `logs/public.jsonl` | `isPublic` が真の記録。Web の概要・ログ画面に出る |

1行1件の JSON（`timestamp` `fileId` `result` `message` `isPublic` など）です。`error` は運用者に通知メールを送ります（`extra.nomail` で抑止）。追記とアーカイブは `logs/.archive.lock` を共有します。

`archive-logs.js`（ジョブ `archive-logs`、毎日 0:00 UTC）は次のように整理します。

1. 公開ログ（1週間分）→ 公開過去ログ（日付別）
2. 公開過去ログ（2週間経過）→ 非公開過去ログ
3. 非公開ログ（1週間経過）→ 年月別（`private-archive/YYYY/YYYY-MM.jsonl`）

ジョブの標準出力 `logs/*.out` `*.err` は `logrotate`（毎月15日）で月ごとに圧縮します。

## 認証情報

コードには書かず、環境変数（Toolforge の `toolforge envvars`）から読みます。

| 環境変数 | 用途 |
| --- | --- |
| `MW_NBOT2_USERNAME` / `MW_NBOT2_PASSWORD` | nanonaBot2 の Bot パスワード（優先） |
| `MW_USERNAME` / `MW_PASSWORD` | 上が無いときの代わり |
| `MW_NBOT1_USERNAME` / `MW_NBOT1_PASSWORD` | subster.js 用の優先認証情報 |
| `TOOL_REPLICA_USER` / `TOOL_REPLICA_PASSWORD` | レプリカ DB。無ければ `~/replica.my.cnf` |

カテゴリキュー（`w-ja-nn5`）と subster は API に `assert=bot` を付け、Bot フラグの無いアカウントでは編集しません。

## データファイル（data/、デプロイ対象外）

| パス | 書くもの | 内容 |
| --- | --- | --- |
| `data/lastTaskData.json` | getTasks.js | 前回の稼働スイッチ |
| `data/edit-throttle/` | editThrottle.js | 編集間隔制御 |
| `data/category-queue/` | category-queue.js | 実行状況・履歴・編集記録（[category-queue.md](category-queue.md#8-記録と取り消し)） |

## テスト

```sh
npm test
```

`node:test` で `test/*.test.js` を実行します（ネットワークに接続しない）。Node.js 18 以降で動きます。
