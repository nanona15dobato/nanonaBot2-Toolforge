# nanonaBot2 Web

ツールのホームの `www/js`（Express）が Toolforge の webservice として動き、Bot の状態とログを公開します。Bot の実行ファイル（`~/bot/`）を読むだけで、Bot を操作する機能はありません。

## 1. 画面

| URL | ファイル | 内容 |
| --- | --- | --- |
| `/` | `public/index.html`・`home.js` | 概要。作業一覧（稼働状態・実行時刻・直近7日の記録数）、最近の記録、終了した作業、停止・連絡先 |
| `/logs` | `public/logs.html`・`log.js` | 実行ログ（直近7日と過去ログ） |
| `/queue` | `public/queue.html`・`queue.js`・`queue.css` | カテゴリキュー（`w-ja-nn5`）の実行状況 |
| `/log` | — | 直近7日の公開ログのテキスト版 |

クエリ付きの `/`（旧ログ画面の URL `/?tab=…`）は `/logs` へリダイレクトします。`/static/` は `public/` を返します（1時間キャッシュ）。

## 2. API

| URL | 返すもの |
| --- | --- |
| `GET /api/status` | `{ enabled, version, buildDate, tasks[] }`。`tasks.json`・`data/lastTaskData.json`・`version_info.json` と公開ログから作る |
| `GET /api/logs/recent` | 直近7日の公開ログ（新しい順） |
| `GET /api/logs/archive` | 公開過去ログ（新しい順） |
| `GET /api/category-queue` | `{ now, status, history }`（3章） |

## 3. カテゴリキューの実行状況（/queue）

Bot が書き出す `~/bot/data/category-queue/status.json` と `history.jsonl` を読みます（形式は [category-queue.md](category-queue.md#9-実行状況の表示)）。

`/api/category-queue` の応答:

| 項目 | 内容 |
| --- | --- |
| `now` | サーバーの現在時刻 |
| `status` | `status.json` の中身。無ければ null。実行中なら `stale`（10分以上更新が無い）を足す |
| `history` | `history.jsonl` の新しい30件（新しい順） |

`Cache-Control: no-store` を付けて返します。

画面の構成:

| 区画 | 内容 |
| --- | --- |
| いまの状況 | 実行中 / 待機中 / 応答なし、試験実行・取り消しの別、開始・終了時刻。実行中は処理中の節の見出し、進捗バーと件数（編集・変更なし・要確認・エラー）、操作、議論場所、ID、編集中のページ、最終更新 |
| 今回の実行で処理するキュー | 節ごとの状態（待機・処理中・終了・中断）と、返信した `{{BOTREQ}}` の状態・理由 |
| 最近処理したページ | 直近50件。時刻（日付はツールチップ）、ページ、結果、差分リンクまたは理由 |
| これまでのコマンド | 終了時刻、操作と議論場所、結果、件数、ID |

- 見出しの `[[:Category:…]]` はリンクとして表示します。外部から来る文字列はすべて `textContent` で入れます。
- 実行中は3秒ごと、それ以外は30秒ごとに取り直します。タブが見えていない間は取得せず、戻ったときに取り直します。
- 「実行中」のまま10分以上更新が無ければ、異常終了の可能性を警告します。

## 4. デザイン

共通スタイル nanona-ui（`public/nanona-ui/` に同梱）を使います。決まりは `www/js/AGENTS.md` にあります。主なもの:

- 色は `var(--nn-*)` だけ。システムフォントのみ
- 動きは 100ms の色変化だけ（進捗バーにもアニメーションを付けない）
- ダークモードとスマホ幅（360px）で確認する。表は枠内で横スクロールし、ページ全体は横にはみ出さない
