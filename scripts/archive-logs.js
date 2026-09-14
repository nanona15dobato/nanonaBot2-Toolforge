#!/usr/bin/env node

/**
 * nanonaBot2 ログアーカイブ処理
 * Toolforge jobs で定期実行する用のスクリプト
 * 
 * ログ管理フロー（3段階）:
 * 1. 公開ログ (最新1週間) → 公開過去ログ (1-2週間前)
 * 2. 公開過去ログ (2週間経過) → 非公開過去ログ (年/月別ファイル)
 * 3. 非公開ログ (1週間経過) → 非公開年月別ログ (YYYY/YYYY-MM.jsonl)
 */

const fs = require("fs");
const path = require("path");

class LogArchiver {
    constructor() {
        this.logsDir = path.join(__dirname, "logs");
        this.publicLogFile = path.join(this.logsDir, "public.jsonl");
        this.privateLogFile = path.join(this.logsDir, "private.jsonl");
        this.publicArchiveDir = path.join(this.logsDir, "public-archive");
        this.privateArchiveDir = path.join(this.logsDir, "private-archive");
        
        // ディレクトリの作成
        this.ensureDirectoryExists(this.publicArchiveDir);
        this.ensureDirectoryExists(this.privateArchiveDir);
    }

    /**
     * ディレクトリが存在しない場合は作成
     */
    ensureDirectoryExists(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * 日付文字列を生成（YYYY-MM-DD形式）
     */
    getDateString(date = new Date()) {
        return date.toISOString().split('T')[0];
    }

    /**
     * 年月文字列を生成（YYYY-MM形式）
     */
    getYearMonthString(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return `${year}-${month}`;
    }

    /**
     * 年別ディレクトリパスを取得
     */
    getPrivateArchiveYearDir(year) {
        return path.join(this.privateArchiveDir, year.toString());
    }

    /**
     * ログファイルを読み込んで解析
     */
    readLogFile(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return [];
            }

            const content = fs.readFileSync(filePath, "utf8");
            const lines = content.trim().split("\n").filter(line => line);
            
            return lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch (error) {
                    console.warn(`無効なJSONログ行をスキップ: ${line}`);
                    return null;
                }
            }).filter(log => log);
        } catch (error) {
            console.error(`ログファイル読み込みエラー (${filePath}):`, error);
            return [];
        }
    }

    /**
     * ログをファイルに書き込み
     */
    writeLogFile(filePath, logs) {
        try {
            const content = logs.map(log => JSON.stringify(log)).join("\n") + "\n";
            fs.writeFileSync(filePath, content);
            return true;
        } catch (error) {
            console.error(`ログファイル書き込みエラー (${filePath}):`, error);
            return false;
        }
    }

    /**
     * ログをファイルに追加
     */
    appendLogFile(filePath, logs) {
        try {
            const content = logs.map(log => JSON.stringify(log)).join("\n") + "\n";
            fs.appendFileSync(filePath, content);
            return true;
        } catch (error) {
            console.error(`ログファイル追加エラー (${filePath}):`, error);
            return false;
        }
    }

    /**
     * 公開ログの過去ログ化処理
     */
    archivePublicLogs() {
        console.log("公開ログの過去ログ化を開始...");

        const logs = this.readLogFile(this.publicLogFile);
        if (logs.length === 0) {
            console.log("アーカイブする公開ログがありません。");
            return true;
        }

        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        const recentLogs = [];
        const oldLogs = [];

        logs.forEach(log => {
            const logDate = new Date(log.timestamp);
            if (logDate >= oneWeekAgo) {
                recentLogs.push(log);
            } else {
                oldLogs.push(log);
            }
        });

        if (oldLogs.length === 0) {
            console.log("アーカイブする古いログがありません。");
            return true;
        }

        // 古いログを日付別にグループ化
        const logsByDate = {};
        oldLogs.forEach(log => {
            const date = this.getDateString(new Date(log.timestamp));
            if (!logsByDate[date]) {
                logsByDate[date] = [];
            }
            logsByDate[date].push(log);
        });

        // 日付別にアーカイブファイルに保存
        let archivedCount = 0;
        Object.keys(logsByDate).forEach(date => {
            const archiveFile = path.join(this.publicArchiveDir, `${date}.jsonl`);
            if (this.appendLogFile(archiveFile, logsByDate[date])) {
                archivedCount += logsByDate[date].length;
            }
        });

        // 元のログファイルを直近一週間のみに更新
        if (this.writeLogFile(this.publicLogFile, recentLogs)) {
            console.log(`公開ログ: ${archivedCount}件をアーカイブ、${recentLogs.length}件を保持`);
            return true;
        }

        return false;
    }

    /**
     * アーカイブされた公開ログの非公開化処理
     * 公開過去ログ（1週間経過）を非公開過去ログに移動
     */
    archiveOldPublicLogs() {
        console.log("古い公開アーカイブログの非公開化を開始...");

        try {
            const archiveFiles = fs.readdirSync(this.publicArchiveDir)
                .filter(file => file.endsWith(".jsonl"));

            const twoWeeksAgo = new Date();
            twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14); // 2週間前

            let movedCount = 0;

            archiveFiles.forEach(file => {
                const [dateStr] = file.split('.');
                const fileDate = new Date(dateStr + 'T00:00:00.000Z');

                // 2週間より古い公開過去ログを非公開に移動
                if (fileDate < twoWeeksAgo) {
                    const publicArchivePath = path.join(this.publicArchiveDir, file);
                    
                    try {
                        const logs = this.readLogFile(publicArchivePath);
                        if (this.moveLogsToPrivateArchive(logs)) {
                            fs.unlinkSync(publicArchivePath);
                            movedCount += logs.length;
                            console.log(`${file}: ${logs.length}件を非公開アーカイブに移動`);
                        }
                    } catch (error) {
                        console.error(`ファイル移動エラー (${file}):`, error);
                    }
                }
            });

            console.log(`合計 ${movedCount}件の古いログを非公開化しました。`);
            return true;
        } catch (error) {
            console.error("古いログの非公開化エラー:", error);
            return false;
        }
    }

    /**
     * 既存の非公開ログの年月別アーカイブ処理
     * 非公開ログファイル内の1週間経過したログを年月別ファイルに分割
     */
    archivePrivateLogs() {
        console.log("非公開ログの日付別アーカイブを開始...");

        const logs = this.readLogFile(this.privateLogFile);
        if (logs.length === 0) {
            console.log("アーカイブする非公開ログがありません。");
            return true;
        }

        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        const recentLogs = [];
        const oldLogs = [];

        logs.forEach(log => {
            const logDate = new Date(log.timestamp);
            if (logDate >= oneWeekAgo) {
                recentLogs.push(log);
            } else {
                oldLogs.push(log);
            }
        });

        if (oldLogs.length === 0) {
            console.log("アーカイブする古い非公開ログがありません。");
            return true;
        }

        // 古いログを年月別にグループ化してアーカイブ
        if (this.moveLogsToPrivateArchive(oldLogs)) {
            // 元の非公開ログファイルを直近一週間のみに更新
            if (this.writeLogFile(this.privateLogFile, recentLogs)) {
                console.log(`非公開ログ: ${oldLogs.length}件をアーカイブ、${recentLogs.length}件を保持`);
                return true;
            }
        }

        return false;
    }

    /**
     * ログを非公開アーカイブに年月別で保存
     */
    moveLogsToPrivateArchive(logs) {
        if (!logs || logs.length === 0) {
            return true;
        }

        try {
            // ログを年月別にグループ化
            const logsByYearMonth = {};
            logs.forEach(log => {
                const logDate = new Date(log.timestamp);
                const year = logDate.getFullYear();
                const yearMonth = this.getYearMonthString(logDate);
                
                if (!logsByYearMonth[year]) {
                    logsByYearMonth[year] = {};
                }
                if (!logsByYearMonth[year][yearMonth]) {
                    logsByYearMonth[year][yearMonth] = [];
                }
                logsByYearMonth[year][yearMonth].push(log);
            });

            // 年月別にファイルに保存
            let totalArchived = 0;
            Object.keys(logsByYearMonth).forEach(year => {
                const yearDir = this.getPrivateArchiveYearDir(year);
                this.ensureDirectoryExists(yearDir);

                Object.keys(logsByYearMonth[year]).forEach(yearMonth => {
                    const monthFile = path.join(yearDir, `${yearMonth}.jsonl`);
                    const monthLogs = logsByYearMonth[year][yearMonth];
                    
                    if (this.appendLogFile(monthFile, monthLogs)) {
                        totalArchived += monthLogs.length;
                        console.log(`${year}/${yearMonth}: ${monthLogs.length}件をアーカイブ`);
                    }
                });
            });

            console.log(`合計 ${totalArchived}件のログを年月別アーカイブに保存しました。`);
            return totalArchived === logs.length;
        } catch (error) {
            console.error("非公開アーカイブ保存エラー:", error);
            return false;
        }
    }

    /**
     * メインの実行関数
     */
    run() {
        console.log(`=== nanonaBot2 ログアーカイブ処理開始 (${new Date().toISOString()}) ===`);

        const results = [
            this.archivePublicLogs(),        // 公開ログ → 公開過去ログ (1週間経過)
            this.archiveOldPublicLogs(),     // 公開過去ログ → 非公開過去ログ (2週間経過) 
            this.archivePrivateLogs()        // 非公開ログ → 非公開日付ログ (1週間経過)
        ];

        const success = results.every(result => result);
        
        if (success) {
            console.log("=== ログアーカイブ処理が正常に完了しました ===");
        } else {
            console.error("=== ログアーカイブ処理中にエラーが発生しました ===");
            process.exit(1);
        }
    }
}

// スクリプトとして直接実行された場合
if (require.main === module) {
    const archiver = new LogArchiver();
    archiver.run();
}

module.exports = { LogArchiver };
