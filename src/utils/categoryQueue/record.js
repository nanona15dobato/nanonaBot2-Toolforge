/**
 * カテゴリキュー: コマンドごとの記録（nanonaBot2 Web の /queue/<ID> が読む）
 *
 *   data/category-queue/commands/<ID>.json        概要（依頼者・コマンド・件数・状態・実行ログ）
 *   data/category-queue/commands/<ID>.pages.jsonl 1行1ページの結果（編集・変更なし・エラー、差分の版）
 *
 * キューページへの返信は件数だけにし、ページの一覧や理由はここに残す。
 * 書き出しに失敗しても Bot の処理は止めない。
 */
const fs = require('fs');
const path = require('path');

const ID_PATTERN = /^\d{14}-[0-9a-f]{6}$/;

function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

class CommandRecord {
    /**
     * @param {string} dir data/category-queue
     * @param {string} id
     * @param {{heading: string}} section
     * @param {{dryRun: boolean}} opts
     */
    constructor(dir, id, section, { dryRun }, existing = null) {
        this.dir = path.join(dir, 'commands');
        this.file = path.join(this.dir, `${id}.json`);
        this.pagesFile = path.join(this.dir, `${id}.pages.jsonl`);
        if (existing) {
            // 緊急停止・異常終了したコマンドの再開。件数とページの結果はそのまま積み増す
            this.data = { ...existing, state: 'running', status: null, finishedAt: null, resumedAt: new Date().toISOString() };
            this.save();
            return;
        }
        this.data = {
            id,
            heading: section.heading,
            dryRun,
            state: 'running',
            status: null,
            message: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            request: null,
            command: null,
            discussionLink: null,
            total: null,
            counts: { edited: 0, unchanged: 0, warnings: 0, errors: 0 },
            notes: [],
            started: false, // キューページに着手の印（{{BOTREQ|着手}} (ID: …)）を付けたか
            reply: null,
            log: [],
        };
        try {
            fs.mkdirSync(this.dir, { recursive: true });
        } catch (e) {
            console.warn(`コマンドの記録先を作れませんでした: ${e.message}`);
        }
        this.save();
    }

    get id() { return this.data.id; }

    save() {
        try {
            writeJsonAtomic(this.file, this.data);
        } catch (e) {
            console.warn(`コマンドの記録を書き出せませんでした: ${e.message}`);
        }
    }

    /** 実行ログ（Web の詳細画面に出す）。level: info / warning / error */
    log(level, message) {
        this.data.log.push({ at: new Date().toISOString(), level, message });
    }

    /** キューページに着手の印を付けた（以後は ID で節を探す。再開もこの印で判断する） */
    markStarted() {
        this.data.started = true;
        this.log('info', 'キューページに着手を返信しました');
        this.save();
    }

    setRequest(request) {
        this.data.request = request;
        this.save();
    }

    setCommand(command, discussionLink, total) {
        Object.assign(this.data, { command, discussionLink, total });
        this.save();
    }

    /**
     * 1ページの結果
     * @param {{title: string, result: 'edited'|'unchanged'|'error', warnings?: string[], message?: string, revid?: number, oldrevid?: number}} ev
     */
    page(ev) {
        const counts = this.data.counts;
        counts[{ edited: 'edited', unchanged: 'unchanged', error: 'errors' }[ev.result]] += 1;
        if (ev.warnings && ev.warnings.length > 0) counts.warnings += 1;
        try {
            fs.appendFileSync(this.pagesFile, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
        } catch (e) {
            console.warn(`ページの結果を書き出せませんでした: ${e.message}`);
        }
    }

    /**
     * キューページへの返信（返信できなかったときは、その理由と返信文を残して Web に出す）
     * @param {string} text
     * @param {boolean} posted
     * @param {string} [error] 投稿しなかった・できなかった理由
     */
    setReply(text, posted, error = null) {
        this.data.reply = { text, posted, error };
        this.save();
    }

    /** @param {{status?: string, message?: string, notes?: string[], stopped?: boolean}} outcome */
    finish(outcome) {
        Object.assign(this.data, {
            state: outcome.stopped ? 'stopped' : 'done',
            status: outcome.stopped ? '緊急停止' : outcome.status,
            message: outcome.message || null,
            notes: outcome.notes || [],
            finishedAt: new Date().toISOString(),
        });
        this.save();
    }

    /** history.jsonl に残す1行 */
    summary() {
        const { log, notes, ...rest } = this.data;
        return rest;
    }
}

/**
 * 再開のために記録を開く（無ければ null）
 * @returns {CommandRecord|null}
 */
function reopenCommandRecord(dir, id, opts) {
    const found = readCommandRecord(dir, id);
    if (!found) return null;
    return new CommandRecord(dir, id, { heading: found.record.heading }, opts, found.record);
}

/**
 * 記録を読む（Web 用。ID の形を確かめてからファイルを開く）
 * @returns {{record: object, pages: object[]}|null}
 */
function readCommandRecord(dir, id) {
    if (!ID_PATTERN.test(String(id))) return null;
    const base = path.join(dir, 'commands', id);
    let record;
    try {
        record = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
    let pages = [];
    try {
        pages = fs.readFileSync(`${base}.pages.jsonl`, 'utf8').split('\n').filter(Boolean)
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    return { record, pages };
}

module.exports = { CommandRecord, readCommandRecord, reopenCommandRecord, ID_PATTERN };
