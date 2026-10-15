/**
 * カテゴリキュー: 実行状況の書き出し（nanonaBot2 Web の /queue が読む）
 *
 *   data/category-queue/status.json   いまの実行（または最後の実行）の状況。書くたびに丸ごと置き換える
 *   data/category-queue/history.jsonl 終わったコマンドの記録（1行1コマンド）
 *   data/category-queue/run.lock/     実行中の印。二重起動を防ぐ
 *
 * 書き出しに失敗しても Bot の処理は止めない。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_EVENTS = 50;
const STALE_LOCK_MS = 30 * 60 * 1000;

function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

class QueueStatus {
    /**
     * @param {string} dir data/category-queue
     * @param {'normal'|'dry-run'|'rollback'} mode
     */
    constructor(dir, mode) {
        this.dir = dir;
        this.file = path.join(dir, 'status.json');
        this.historyFile = path.join(dir, 'history.jsonl');
        this.lockDir = path.join(dir, 'run.lock');
        this.data = {
            version: 1,
            state: 'running',
            mode,
            host: os.hostname(),
            pid: process.pid,
            startedAt: new Date().toISOString(),
            updatedAt: null,
            finishedAt: null,
            endReason: null,
            sections: [],
            current: null,
            events: [],
        };
        fs.mkdirSync(dir, { recursive: true });
    }

    /** 実行中の印を取る。他の実行が動いていれば false */
    acquireLock(retries = 2) {
        try {
            fs.mkdirSync(this.lockDir);
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            const observed = this.readLockOwner(this.lockDir);
            const st = fs.statSync(this.lockDir, { throwIfNoEntry: false });
            if (!st || Date.now() - st.mtimeMs <= STALE_LOCK_MS) return false;
            // 古い印を取り直せたら（または他の実行が先に片付けたら）もう一度取りにいく
            if (retries > 0 && this.reclaimStaleLock(observed)) return this.acquireLock(retries - 1);
            return false;
        }
        // 印に持ち主の札を入れる。古いとみなされて他の実行に取られた後で、元の実行が
        // 新しい持ち主の印を更新・削除しないよう、札が自分のものか確かめてから触る
        this.lockToken = `${os.hostname()}:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
        fs.writeFileSync(path.join(this.lockDir, 'owner'), this.lockToken);
        return true;
    }

    /** 印の持ち主の札（無ければ null） */
    readLockOwner(dir) {
        try {
            return fs.readFileSync(path.join(dir, 'owner'), 'utf8');
        } catch {
            return null;
        }
    }

    /**
     * 古いと判断した印を片付ける。判断してから消すまでの間に、他の実行がその印を片付けて新しい印を
     * 作っているかもしれないので、共有の名前のまま消さない。
     * 1. 印を自分だけの名前に rename する（原子的。同じ印を2つの実行が同時に移すことはできない）
     * 2. 移した印の札が、古いと判断したときに読んだ札と同じなら、それは古い印なので消す
     * 3. 違えば他の実行が作った新しい印を移してしまったので、元の名前に戻して諦める
     * @param {string|null} observed 古いと判断したときに読んだ札
     * @returns {boolean} 取り直しに進んでよいか
     */
    reclaimStaleLock(observed) {
        const quarantine = `${this.lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            fs.renameSync(this.lockDir, quarantine);
        } catch (e) {
            // 他の実行が先に片付けた（ENOENT）。もう一度取りにいけばよい
            return e.code === 'ENOENT';
        }
        if (this.readLockOwner(quarantine) === observed) {
            fs.rmSync(quarantine, { recursive: true, force: true });
            return true;
        }
        try {
            fs.renameSync(quarantine, this.lockDir);
        } catch {
            // 戻す前にさらに別の実行が印を作った。移した印の持ち主は lockLost() で気づいて止まる
            fs.rmSync(quarantine, { recursive: true, force: true });
        }
        return false;
    }

    /** 実行中の印がまだ自分のものか */
    ownsLock() {
        if (!this.lockToken) return false;
        try {
            return fs.readFileSync(path.join(this.lockDir, 'owner'), 'utf8') === this.lockToken;
        } catch {
            return false;
        }
    }

    /** 実行中の印を他の実行に取られたか（取られたら、それ以上編集しない） */
    lockLost() {
        return Boolean(this.lockToken) && !this.ownsLock();
    }

    releaseLock() {
        if (this.ownsLock()) fs.rmSync(this.lockDir, { recursive: true, force: true });
        this.lockToken = null;
    }

    save() {
        this.data.updatedAt = new Date().toISOString();
        // 印を取られていたら、新しい持ち主の実行状況を上書きしない
        if (this.lockLost()) return;
        try {
            writeJsonAtomic(this.file, this.data);
            // 長い実行でも印が古いと判定されないよう、書くたびに更新する
            const now = new Date();
            fs.utimesSync(this.lockDir, now, now);
        } catch (e) {
            console.warn(`実行状況を書き出せませんでした: ${e.message}`);
        }
    }

    /** @param {{heading: string}[]} sections 今回処理する節 */
    setSections(sections) {
        this.data.sections = sections.map(s => ({ heading: s.heading, state: 'pending', status: null, id: null, message: null }));
        this.save();
    }

    /** 節の処理を始めた（対象の収集前） */
    sectionStart(index) {
        const s = this.data.sections[index];
        if (s) s.state = 'running';
        this.data.current = { heading: s ? s.heading : null, phase: '確認中', startedAt: new Date().toISOString() };
        this.save();
    }

    /** コマンドが受理され、編集を始める */
    commandStart({ id, command, discussionLink, total, request = null }) {
        Object.assign(this.data.current, {
            id,
            phase: '編集中',
            type: command.type,
            from: command.from,
            to: command.to,
            namespaces: command.namespaces,
            discussionLink,
            request,
            total,
            done: 0,
            edited: 0,
            unchanged: 0,
            skipped: 0,
            warnings: 0,
            errors: 0,
            currentTitle: null,
        });
        this.save();
    }

    /** これから編集するページ */
    pageStart(title) {
        if (!this.data.current) return;
        this.data.current.currentTitle = title;
        this.save();
    }

    /**
     * 1ページの結果
     * @param {{title: string, result: 'edited'|'unchanged'|'skipped'|'error', warnings?: string[], message?: string, revid?: number, oldrevid?: number}} ev
     */
    pageDone(ev) {
        const c = this.data.current;
        if (c) {
            c.done += 1;
            c[{ edited: 'edited', unchanged: 'unchanged', skipped: 'skipped', error: 'errors' }[ev.result]] += 1;
            if (ev.warnings && ev.warnings.length > 0) c.warnings += 1;
            c.currentTitle = null;
        }
        this.data.events.unshift({ at: new Date().toISOString(), id: c ? c.id : null, ...ev });
        this.data.events.length = Math.min(this.data.events.length, MAX_EVENTS);
        this.save();
    }

    /**
     * 節の処理が終わった
     * @param {number} index
     * @param {{status?: string, message?: string, id?: string, stopped?: boolean}} outcome
     * @param {object} [record] history.jsonl に残す内容（コマンドを実行した場合）
     */
    sectionEnd(index, outcome, record) {
        const s = this.data.sections[index];
        if (s) {
            s.state = outcome.stopped ? 'stopped' : 'done';
            s.status = outcome.status || null;
            s.id = outcome.id || null;
            s.message = outcome.message || null;
        }
        // 履歴は1コマンド1行。呼び出し側は、コマンドが初めて終わったときだけ record を渡す
        // （緊急停止は再開して終わったときに、返信の再送は書かない）。念のため終わっていない記録は書かない
        if (record && record.state !== 'stopped' && record.state !== 'running') {
            try {
                fs.appendFileSync(this.historyFile, JSON.stringify({ ...record, finishedAt: new Date().toISOString() }) + '\n');
            } catch (e) {
                console.warn(`実行履歴を書き出せませんでした: ${e.message}`);
            }
        }
        this.data.current = null;
        this.save();
    }

    /** @param {string} reason 完了 / 緊急停止 / 停止中 / 対象なし / エラー など */
    finish(reason) {
        this.data.state = 'idle';
        this.data.finishedAt = new Date().toISOString();
        this.data.endReason = reason;
        this.data.current = null;
        this.save();
    }
}

module.exports = { QueueStatus };
