/**
 * タスク台帳 (tasks.json) の読み込み・検証と、各種生成物への変換
 *
 * tasks.json を唯一の情報源とし、次を生成する:
 * - myjobs.yaml          … Toolforge jobs 定義（廃止タスクは含めない）
 * - メタウィキ用 JSON     … User:NanonaBot2/tasks.json（表示用モジュールが参照）
 *
 * 直接実行: node scripts/task-registry.js [check|jobs|wiki]
 */
const fs = require('fs');
const path = require('path');

const registryPath = path.join(__dirname, '..', 'tasks.json');
const STATUSES = ['active', 'retired'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const JST_OFFSET = 9;
// cronの各フィールドの範囲（分 時 日 月 曜日。曜日は7も日曜として許容）
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function loadRegistry(filePath = registryPath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * cron式（5フィールド、数値のみ）の書式と範囲を検証する
 * 各フィールドは * / 数値 / a-b / a,b / （*またはa-b）/n に対応
 * @param {string} schedule
 * @returns {string|null} 問題があれば理由、なければ null
 */
function validateCron(schedule) {
    const fields = String(schedule ?? '').trim().split(/\s+/);
    if (fields.length !== 5) return '5フィールドではありません';

    for (let i = 0; i < 5; i++) {
        const [lo, hi] = CRON_RANGES[i];
        for (const part of fields[i].split(',')) {
            const match = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
            if (!match) return `"${fields[i]}" を解釈できません`;
            const [, , start, end, step] = match;
            if (step !== undefined && Number(step) < 1) return `"${part}" の間隔が不正です`;
            if (start === undefined) continue;
            const a = Number(start);
            const b = end === undefined ? a : Number(end);
            if (a < lo || b > hi || a > b) return `"${part}" が範囲 ${lo}-${hi} の外です`;
        }
    }
    return null;
}

/**
 * 時刻を「午前4時」「午後1時30分」の形式にする
 */
function formatJstTime(hour, minute) {
    const label = `${hour < 12 ? '午前' : '午後'}${hour % 12}時`;
    return minute ? `${label}${minute}分` : label;
}

/**
 * UTCのcron式を日本時間の実行間隔表記に変換する
 * 対応できない書式の場合は null（tasks.json 側で execTime を明示する）
 * @param {string} schedule - 例: '0 19 * * *'
 * @returns {string|null}
 */
function cronToJst(schedule) {
    if (validateCron(schedule)) return null;
    const fields = String(schedule).trim().split(/\s+/);
    const [min, hour, dom, month, dow] = fields;
    const isNum = v => /^\d+$/.test(v);

    if (!isNum(min) || month !== '*') return null;
    const minute = Number(min);

    if (hour === '*') {
        return dom === '*' && dow === '*' ? `毎時${minute}分(JST)` : null;
    }
    if (!isNum(hour)) return null;

    const jstHour = Number(hour) + JST_OFFSET;
    const dayShift = jstHour >= 24 ? 1 : 0;
    const time = formatJstTime(jstHour % 24, minute);

    if (dom === '*' && dow === '*') {
        return `毎日${time}(JST)`;
    }
    if (dom === '*' && isNum(dow)) {
        return `毎週${WEEKDAYS[(Number(dow) + dayShift) % 7]}曜${time}(JST)`;
    }
    if (isNum(dom) && dow === '*') {
        const day = Number(dom) + dayShift;
        // 月末をまたぐ場合は日付が月によって変わるため自動変換しない
        return day <= 28 ? `毎月${day}日${time}(JST)` : null;
    }
    return null;
}

/**
 * 台帳を検証し、問題点の一覧を返す
 * @param {object} registry
 * @param {{srcDir?: string, declaredTaskIds?: Record<string, string>}} [options]
 *   declaredTaskIds: ソース内の `const taskId = '...'` から得た {taskId: 相対パス}
 * @returns {string[]}
 */
function validateRegistry(registry, { srcDir, declaredTaskIds } = {}) {
    const errors = [];
    const tasks = registry.tasks || {};
    const jobNames = new Set();

    const checkJobName = (name, owner) => {
        if (jobNames.has(name)) errors.push(`${owner}: ジョブ名 "${name}" が重複しています`);
        jobNames.add(name);
    };

    for (const [id, task] of Object.entries(tasks)) {
        if (!/^[a-z]+-[a-z]+-[A-Za-z]+\d+$/.test(id)) {
            errors.push(`${id}: タスクIDは "w-ja-nn1" の形式にしてください`);
        }
        if (!STATUSES.includes(task.status)) {
            errors.push(`${id}: status は ${STATUSES.join(' / ')} のいずれかにしてください`);
        }
        if (!task.taskname) errors.push(`${id}: taskname がありません`);
        if (!task.file) errors.push(`${id}: file がありません`);
        if (srcDir && task.file && !fs.existsSync(path.join(srcDir, task.file))) {
            errors.push(`${id}: ファイル src/${task.file} が見つかりません`);
        }
        if (declaredTaskIds && task.file) {
            const declaredFile = declaredTaskIds[id];
            if (!declaredFile) {
                errors.push(`${id}: src/${task.file} に const taskId = '${id}' がありません`);
            } else if (path.normalize(declaredFile) !== path.normalize(task.file)) {
                errors.push(`${id}: tasks.json では ${task.file}、ソースでは ${declaredFile} で宣言されています`);
            }
        }
        if (task.status === 'retired' && !task.retired?.reason) {
            errors.push(`${id}: 廃止タスクには retired.reason を書いてください`);
        }
        if (task.job) {
            if (!task.job.name || !task.job.schedule) {
                errors.push(`${id}: job には name と schedule が必要です`);
            } else {
                checkJobName(task.job.name, id);
                const cronError = validateCron(task.job.schedule);
                if (cronError) errors.push(`${id}: schedule "${task.job.schedule}" が不正です（${cronError}）`);
                if (!cronError && !task.execTime && !cronToJst(task.job.schedule)) {
                    errors.push(`${id}: schedule "${task.job.schedule}" から実行間隔を作れないため execTime を書いてください`);
                }
            }
        }
    }

    for (const [name, job] of Object.entries(registry.jobs || {})) {
        checkJobName(name, `jobs.${name}`);
        if (!job.command || !job.schedule) {
            errors.push(`jobs.${name}: command と schedule が必要です`);
        } else {
            const cronError = validateCron(job.schedule);
            if (cronError) errors.push(`jobs.${name}: schedule "${job.schedule}" が不正です（${cronError}）`);
        }
    }

    if (declaredTaskIds) {
        for (const [id, file] of Object.entries(declaredTaskIds)) {
            if (!tasks[id]) errors.push(`${id}: src/${file} で宣言されていますが tasks.json にありません`);
        }
    }

    return errors;
}

/**
 * Toolforge jobs 用の定義一覧（稼働中タスク + 共通ジョブ）
 */
function buildJobList(registry) {
    const defaults = registry.defaults || {};
    const image = defaults.image || 'node18';
    const deployDir = defaults.deployDir || 'bot';
    const logDir = defaults.logDir || 'logs';
    const jobs = [];

    for (const [name, job] of Object.entries(registry.jobs || {})) {
        jobs.push({ name, command: job.command, image: job.image || image, schedule: job.schedule });
    }
    for (const task of Object.values(registry.tasks || {})) {
        if (task.status !== 'active' || !task.job) continue;
        jobs.push({
            name: task.job.name,
            command: task.job.command || `node ${deployDir}/${task.file.replace(/\\/g, '/')}`,
            image: task.job.image || image,
            schedule: task.job.schedule
        });
    }

    return jobs
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(job => ({
            ...job,
            filelogStdout: `${logDir}/${job.name}.out`,
            filelogStderr: `${logDir}/${job.name}.err`
        }));
}

function toJobsYaml(registry) {
    // 値はJSON文字列として書く（YAMLのダブルクォート文字列と互換）
    const lines = [
        '# このファイルは scripts/build.js が tasks.json から生成します。直接編集しないでください。'
    ];
    for (const job of buildJobList(registry)) {
        lines.push(`- command: ${JSON.stringify(job.command)}`);
        lines.push(`  image: ${JSON.stringify(job.image)}`);
        lines.push(`  name: ${JSON.stringify(job.name)}`);
        lines.push(`  schedule: ${JSON.stringify(job.schedule)}`);
        lines.push(`  filelog-stdout: ${JSON.stringify(job.filelogStdout)}`);
        lines.push(`  filelog-stderr: ${JSON.stringify(job.filelogStderr)}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * メタウィキ User:NanonaBot2/tasks.json の内容を作る
 * 既存の表示モジュールと互換のキー名（taskname, execTime など）を維持する
 * @param {object} registry
 * @param {{overallVersion: string, buildDate: string, files: Record<string, {hash: string, last_updated: string}>}} build
 */
function toWikiJson(registry, { overallVersion, buildDate, files = {} }) {
    const wiki = {
        NanonaBot2: {
            overall_version: overallVersion,
            build_date: buildDate,
            schema: 2
        }
    };

    const ids = Object.keys(registry.tasks || {}).sort();
    for (const id of ids) {
        const task = registry.tasks[id];
        const file = files[id] || {};
        const entry = {
            project: id.split('-').slice(0, 2).join('-'),
            status: task.status,
            taskname: task.taskname,
            description: task.description || '',
            version: file.hash || '',
            lastupdate: file.last_updated || '',
            botstemplate: task.botstemplate ?? 'NA',
            execTime: task.execTime || (task.job ? cronToJst(task.job.schedule) : '') || '',
            reqlink: task.reqlink || ''
        };
        if (task.job) {
            entry.job = { name: task.job.name, schedule: task.job.schedule };
        }
        if (task.status === 'retired') {
            entry.retired = { date: task.retired?.date || '', reason: task.retired?.reason || '' };
        }
        wiki[id] = entry;
    }

    return wiki;
}

module.exports = {
    registryPath,
    loadRegistry,
    cronToJst,
    validateCron,
    validateRegistry,
    buildJobList,
    toJobsYaml,
    toWikiJson
};

if (require.main === module) {
    const command = process.argv[2] || 'check';
    const registry = loadRegistry();

    if (command === 'check') {
        const errors = validateRegistry(registry, { srcDir: path.join(__dirname, '..', 'src') });
        if (errors.length) {
            errors.forEach(e => console.error(`- ${e}`));
            process.exit(1);
        }
        for (const [id, task] of Object.entries(registry.tasks)) {
            const when = task.status === 'retired'
                ? `廃止 (${task.retired.date || '日付未記入'}: ${task.retired.reason})`
                : (task.job ? task.execTime || cronToJst(task.job.schedule) : '不定期');
            console.log(`${id.padEnd(10)} ${task.status.padEnd(8)} ${when}  ${task.file}`);
        }
    } else if (command === 'jobs') {
        process.stdout.write(toJobsYaml(registry));
    } else if (command === 'wiki') {
        console.log(JSON.stringify(toWikiJson(registry, { overallVersion: '(local)', buildDate: '' }), null, 2));
    } else {
        console.error('使用方法: node scripts/task-registry.js [check|jobs|wiki]');
        process.exit(1);
    }
}
