const fs = require("fs");
const path = require("path");
const nodemailer = require('nodemailer');

/**
 * nanonaBot2 ログシステム
 * Toolforge環境用のログ保存関数
 */
class BotLogger {
    constructor() {
        this.logsDir = path.join(__dirname, "../logs");
        this.publicLogFile = path.join(this.logsDir, "public.jsonl");
        this.privateLogFile = path.join(this.logsDir, "private.jsonl");
        this.publicArchiveDir = path.join(this.logsDir, "public-archive");

        // ディレクトリの作成
        this.ensureDirectoryExists(this.logsDir);
        this.ensureDirectoryExists(this.publicArchiveDir);
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
     * メインのログ保存関数
     * @param {string} fileId - 実行ファイル名/ID
     * @param {string} result - 結果（成功/失敗など）
     * @param {string} message - メッセージ/引数
     * @param {boolean} isPublic - 公開ログに保存するかどうか
     * @param {Object} additionalData - 追加データ（オプション）
     */
    log(fileId, result, message, isPublic = false, additionalData = {}) {
        const timestamp = new Date().toISOString();
        //file最後の":"以前をprefixとして抽出
        const prefix = fileId.split(":").slice(0, -1).join(":");
        const logEntry = {
            timestamp,
            fileId,
            prefix,
            result,
            message,
            isPublic,
            ...additionalData
        };

        const logLine = JSON.stringify(logEntry) + "\n";

        try {
            // 常に非公開ログに保存
            fs.appendFileSync(this.privateLogFile, logLine);

            // 公開フラグがtrueの場合は公開ログにも保存
            if (isPublic) {
                fs.appendFileSync(this.publicLogFile, logLine);
            }

            console.log(`[LOG] ${timestamp} - ${fileId}: ${result} - ${message}`);
            return true;
        } catch (error) {
            console.error("ログ保存エラー:", error);
            return false;
        }
    }

    /**
     * 成功ログのヘルパー関数
     */
    success(fileId, message, isPublic = false, additionalData = {}) {
        return this.log(fileId, "成功", message, isPublic, additionalData);
    }

    /**
     * エラーログのヘルパー関数
     */
    error(fileId, message, isPublic = false, additionalData = {}) {
        if (!additionalData.nomail) {
            const transporter = nodemailer.createTransport({
                host: 'mail.tools.wmcloud.org',
                port: 25,
                secure: false
            });
            const mailOptions = {
                from: '"nanonaBot2:Error" <nanonabot2-01.error@toolforge.org>',
                to: 'nanona15dobato@toolforge.org',
                subject: `nanonaBot2-Error: ${fileId}`,
                text: `プログラムの実行中にエラーが発生しました。\n\n【エラー内容】\n${message}\n\n【スタックトレース】\n${additionalData.stack || "スタックトレースなし"}`
            };
            transporter.sendMail(mailOptions)
                .then(info => {
                    console.log('エラー通知メールを送信しました: %s', info.messageId);
                })
                .catch(mailError => {
                    console.error('エラー通知メールの送信自体に失敗しました:', mailError);
                });
        }
        return this.log(fileId, "失敗", message, isPublic, {
            ...additionalData,
            level: "error"
        });
    }

    /**
     * 警告ログのヘルパー関数
     */
    warning(fileId, message, isPublic = false, additionalData = {}) {
        return this.log(fileId, "警告", message, isPublic, {
            ...additionalData,
            level: "warning"
        });
    }

    /**
     * 情報ログのヘルパー関数
     */
    info(fileId, message, isPublic = false, additionalData = {}) {
        return this.log(fileId, "情報", message, isPublic, {
            ...additionalData,
            level: "info"
        });
    }

    /**
     * 直近一週間の公開ログを取得
     */
    getRecentPublicLogs(days = 7) {
        try {
            if (!fs.existsSync(this.publicLogFile)) {
                return [];
            }

            const content = fs.readFileSync(this.publicLogFile, "utf8");
            const lines = content.trim().split("\n").filter(line => line);
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - days);

            const logs = lines
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                })
                .filter(log => log && new Date(log.timestamp) >= oneWeekAgo)
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            return logs;
        } catch (error) {
            console.error("ログ取得エラー:", error);
            return [];
        }
    }

    /**
     * アーカイブされた公開ログを取得
     */
    getArchivedPublicLogs() {
        try {
            const archiveFiles = fs.readdirSync(this.publicArchiveDir)
                .filter(file => file.endsWith(".jsonl"))
                .sort().reverse();

            const allLogs = [];

            for (const file of archiveFiles) {
                const filePath = path.join(this.publicArchiveDir, file);
                const content = fs.readFileSync(filePath, "utf8");
                const lines = content.trim().split("\n").filter(line => line);

                const logs = lines
                    .map(line => {
                        try {
                            return JSON.parse(line);
                        } catch {
                            return null;
                        }
                    })
                    .filter(log => log);

                allLogs.push(...logs);
            }

            return allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        } catch (error) {
            console.error("アーカイブログ取得エラー:", error);
            return [];
        }
    }
}

// シングルトンインスタンスをエクスポート
const logger = new BotLogger();

module.exports = {
    BotLogger,
    logger
};
