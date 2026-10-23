'use strict';

/**
 * JAWP 管理者伝言板の {{UserAN}} を確認し、ブロック等が報告後に行われていれば
 * |2= に結果を記入する Bot。mwn を使う単一ファイル版。
 *
 * 注意: 実運用前に --dry-run で十分に確認してください。
 * 設定: MW_USERNAME / MW_PASSWORD（BotPassword）環境変数。
 */
const { Mwn } = require('mwn');
const ipaddr = require('ipaddr.js');
const { applyEditThrottle } = require('./utils/editThrottle');
const { checkTaskStatusAndExit } = require('./utils/getTasks');
const { logger } = require("./utils/logger");

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const ANI = 'Wikipedia:管理者伝言板/投稿ブロック';
//const ANI = '利用者:NanonaBot2/sandbox';
const ANS = 'Wikipedia:管理者伝言板/投稿ブロック/ソックパペット';
const AN3RR = 'Wikipedia:管理者伝言板/3RR';
const nonexistingUsers = new Set();
const taskId = 'w-ja-PHP1';
const nnversion = '__FILE_HASH__';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clean(s) { return String(s ?? '').replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, ''); }
function isObjectEmpty(obj) { return !obj || Object.keys(obj).length === 0; }
function filterSet(set, predicate) { return new Set([...set].filter(predicate)); }
function logError(err) { console.error(err?.stack || err); }

// ---------- IP アドレスと CIDR ----------
function parseIP(value) {
    try {
        const text = String(value).trim();
        if (!text) return null;
        if (text.includes('/')) {
            const [addr, prefix] = ipaddr.parseCIDR(text);
            return { addr, prefix, cidr: true, text: `${addr.toString()}/${prefix}` };
        }
        const addr = ipaddr.parse(text);
        return { addr, prefix: addr.kind() === 'ipv4' ? 32 : 128, cidr: false, text: addr.toString() };
    } catch { return null; }
}
function ipEquals(a, b) {
    const x = parseIP(typeof a === 'string' ? a : a?.text);
    const y = parseIP(typeof b === 'string' ? b : b?.text);
    if (!x || !y || x.addr.kind() !== y.addr.kind()) return false;
    return x.addr.match(y.addr, Math.min(x.prefix, y.prefix)) && x.prefix === y.prefix;
}
function ipAbbreviate(value) {
    const parsed = parseIP(value);
    if (!parsed) return String(value);
    if (!parsed.cidr) return parsed.addr.toString();
    return parsed.text;
}
function cidrSuffix(target, user) {
    const range = parseIP(target);
    const addr = parseIP(user);
    return range && addr && range.cidr && !ipEquals(range.text, addr.text) ? `/${range.prefix}で` : '';
}
function isIP(value) { return !!parseIP(value); }

// ---------- 入れ子のテンプレートにも対応する wikitext 解析 ----------
const PROTECTED_TAGS = /<(nowiki|pre|source|syntaxhighlight|math|code)\b[^>]*>[\s\S]*?<\/\1\s*>/ig;
function maskProtected(text) {
    const chars = text.split('');
    const mask = (start, end) => { for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '; };
    let m;
    const comment = /<!--[\s\S]*?-->/g;
    while ((m = comment.exec(text))) mask(m.index, m.index + m[0].length);
    PROTECTED_TAGS.lastIndex = 0;
    while ((m = PROTECTED_TAGS.exec(text))) mask(m.index, m.index + m[0].length);
    return chars.join('');
}
function findTemplates(text) {
    const masked = maskProtected(text);
    const stack = [];
    const found = [];
    for (let i = 0; i < masked.length - 1; i++) {
        if (masked[i] === '{' && masked[i + 1] === '{' && masked[i + 2] !== '{') {
            stack.push(i); i++;
        } else if (masked[i] === '}' && masked[i + 1] === '}' && masked[i + 2] !== '}') {
            const start = stack.pop();
            if (start !== undefined) {
                found.push({ start, end: i + 2, raw: text.slice(start, i + 2), depth: stack.length });
            }
            i++;
        }
    }
    return found.sort((a, b) => a.start - b.start || b.end - a.end);
}
function splitTopLevel(text, delimiter) {
    const out = []; let start = 0; let braces = 0; let brackets = 0; let links = 0; let i = 0;
    const masked = maskProtected(text);
    while (i < masked.length) {
        if (masked.startsWith('{{', i)) { braces++; i += 2; continue; }
        if (masked.startsWith('}}', i) && braces) { braces--; i += 2; continue; }
        if (masked.startsWith('[[', i)) { links++; i += 2; continue; }
        if (masked.startsWith(']]', i) && links) { links--; i += 2; continue; }
        if (masked[i] === '[' && !links) brackets++;
        else if (masked[i] === ']' && brackets) brackets--;
        if (masked[i] === delimiter && !braces && !links && !brackets) {
            out.push(text.slice(start, i)); start = i + 1;
        }
        i++;
    }
    out.push(text.slice(start));
    return out;
}
function parseTemplate(raw, absoluteStart = 0) {
    const inner = raw.slice(2, -2);
    const parts = splitTopLevel(inner, '|');
    const title = clean(parts.shift() || '').replace(/_/g, ' ').replace(/\s+/g, ' ');
    const params = [];
    let positional = 1;
    for (const part of parts) {
        const eq = splitTopLevel(part, '=');
        if (eq.length > 1) {
            const key = clean(eq.shift());
            params.push({ key, value: eq.join('='), raw: part, explicit: true });
        } else {
            params.push({ key: String(positional++), value: part, raw: part, explicit: false });
        }
    }
    return { title, params, raw, start: absoluteStart, end: absoluteStart + raw.length };
}
function normalizeTemplateName(name) {
    let n = clean(name).replace(/_/g, ' ').replace(/\s+/g, ' ');
    n = n.replace(/^(?:Template|テンプレート)\s*:/i, '');
    return n.toLocaleLowerCase('ja');
}
function paramValue(temp, aliases) {
    const p = temp.params.find(p => aliases.includes(clean(p.key)));
    return p ? clean(p.value) : '';
}
function setParam(temp, key, value, { remove = false, atEnd = false } = {}) {
    const indexes = [];
    temp.params.forEach((p, i) => { if (clean(p.key) === key) indexes.push(i); });
    if (remove) {
        temp.params = temp.params.filter(p => clean(p.key) !== key);
        return;
    }
    if (indexes.length) {
        temp.params[indexes[0]].value = value;
        temp.params[indexes[0]].raw = `${temp.params[indexes[0]].key}=${value}`;
        for (const i of indexes.slice(1).reverse()) temp.params.splice(i, 1);
    } else {
        temp.params.push({ key, value, raw: `${key}=${value}`, explicit: true, atEnd });
    }
}
function stringifyTemplate(temp) {
    // 元の区切り方は保ちつつ、パラメータの値を反映する。キー名の省略形は可能な限り維持。
    const parts = [temp.title];
    for (const p of temp.params) {
        if (p.explicit || !/^\d+$/.test(p.key)) parts.push(`${p.key}=${p.value}`);
        else parts.push(p.value);
    }
    return `{{${parts.join('|')}}}`;
}
function getSections(text) {
    const lines = text.split(/(?<=\n)/);
    const sections = [];
    let offset = 0;
    const headings = [];
    for (const line of lines) {
        const m = line.match(/^\s*(={1,6})\s*(.*?)\s*\1\s*(?:\r?\n)?$/);
        if (m) headings.push({ start: offset, title: clean(m[2]), level: m[1].length });
        offset += line.length;
    }
    sections.push({ title: '', start: 0, end: headings[0]?.start ?? text.length, index: 0 });
    headings.forEach((h, i) => {
        let end = text.length;
        for (let j = i + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) { end = headings[j].start; break; }
        }
        sections.push({ title: h.title, start: h.start, end, index: i + 1 });
    });
    return sections;
}
function sectionFor(start, sections) {
    return sections.find(s => start >= s.start && start < s.end) || null;
}
function applyReplacements(text, replacements) {
    replacements.sort((a, b) => b.start - a.start);
    let result = text;
    for (const r of replacements) result = result.slice(0, r.start) + r.text + result.slice(r.end);
    return result;
}

// ---------- 日付・ブロック期間 ----------
function convertTimestampToDateUTC(str) {
    const s = String(str || '');
    let m = s.match(/20\d{2}-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ?/);
    if (m) { const d = new Date(m[0]); return Number.isNaN(d.getTime()) ? null : d; }
    m = s.match(/(?<year>20\d{2})年(?<month>[1-9]|1[0-2])月(?<day>[12]?\d|3[01])日 \([日月火水木金土]\) (?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)/);
    if (m?.groups) return new Date(Date.UTC(+m.groups.year, +m.groups.month - 1, +m.groups.day, +m.groups.hour, +m.groups.minute, 59));
    m = s.match(/(?<era>令和|平成|昭和)(?<eraYear>元|\d{1,2})年(?<month>[1-9]|1[0-2])月(?<day>[12]?\d|3[01])日 \([日月火水木金土]\) (?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)/);
    if (m?.groups) {
        const offset = { '令和': 2019, '平成': 1989, '昭和': 1926 }[m.groups.era];
        const year = offset + (m.groups.eraYear === '元' ? 1 : +m.groups.eraYear) - 1;
        return new Date(Date.UTC(year, +m.groups.month - 1, +m.groups.day, +m.groups.hour, +m.groups.minute, 59));
    }
    return null;
}
function formatDateToMDinGMT9(date) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(date);
}
const msMap = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
const units = [
    { key: 'year', label: '年', promote: Infinity, append: false },
    { key: 'month', label: 'か月', promote: 12, append: true },
    { key: 'week', label: '週間', promote: 4, append: true },
    { key: 'day', label: '日', promote: 7, append: false },
    { key: 'hour', label: '時間', promote: 24, append: true },
    { key: 'minute', label: '分', promote: 60, append: true },
    { key: 'second', label: '秒', promote: 60, append: true }
];
function getBlockDuration(start, expiry) {
    const startDate = start instanceof Date ? start : new Date(start);
    const endDate = expiry instanceof Date ? expiry : new Date(expiry);
    let rest = endDate.getTime() - startDate.getTime();
    if (!Number.isFinite(rest) || rest < 0) return '';
    const parts = [];
    for (const { key, label, promote, append } of units) {
        let n = Math.floor(rest / msMap[key]);
        if (n > 0) {
            if (parts.length) {
                if (n >= promote) { parts[0][0] += Math.floor(n / promote); n %= promote; if (!n) break; }
                if (!append) break;
            }
            parts.push([n, label]); rest -= n * msMap[key];
            if (parts.length === 2) break;
        }
        if (parts.length && n === 0) break;
    }
    const ret = parts.length ? parts.flat().join('') : '0秒';
    return ({ '1日7時間': '31時間', '6日23時間': '1週間', '13日23時間': '2週間', '20日23時間': '3週間', '27日23時間': '4週間' })[ret] || ret;
}
function isAfterRef(timestamp, refDate) {
    const time = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
    return time > refDate.date.getTime() - (refDate.type === 'bot' ? 0 : 5 * 60000);
}
function getNarrowestBlockIndex(blocks, refDate) {
    let idx = null; let narrowest = -1;
    blocks.forEach((block, i) => {
        if (!isAfterRef(block.timestamp, refDate)) return;
        const target = block.user || block.target || '';
        const m = target.match(/\/(\d{1,3})$/);
        const subnet = m ? +m[1] : target.includes('.') ? 32 : 128;
        if (subnet > narrowest) { idx = i; narrowest = subnet; }
    });
    return idx;
}
function containsJapaneseCharacter(str) { return /[\u30a0-\u30ff\u3040-\u309f\u3005-\u3006\u30e0-\u9fcf]/.test(str); }
function sanitizeUsername(username) {
    if (/^[\u10A0-\u10FF]/.test(username)) return username;
    return username ? username[0].toLocaleUpperCase('en-US') + username.slice(1) : username;
}

// ---------- mwn API ----------
const bot = applyEditThrottle(new Mwn({
    apiUrl: 'https://ja.wikipedia.org/w/api.php',
    username: process.env.MW_NBOT2_USERNAME || process.env.MW_USERNAME,
    password: process.env.MW_NBOT2_PASSWORD || process.env.MW_PASSWORD,
    userAgent: `nanonaBot2/ANreport [${nnversion}] (Toolforge)`,
    defaultParams: { formatversion: 2 },
    maxRetries: 3,
    retryPause: 1000
}));

async function api(params) {
    // mwn は query continuation / retry / API エラー処理を提供する。
    return bot.request(params);
}
async function queryAll(params, arrayName) {
    let response = await api({ action: 'query', ...params });
    let all = [...(response.query?.[arrayName] || [])];
    while (response.continue) {
        response = await api({ action: 'query', ...params, ...response.continue });
        all.push(...(response.query?.[arrayName] || []));
    }
    return all;
}
async function fetchPage(title) {
    const r = await api({ action: 'query', prop: 'revisions', titles: title, rvprop: 'ids|timestamp|content', rvslots: 'main' });
    const p = r.query.pages?.[0];
    if (!p || p.missing) throw new Error(`ページが存在しません: ${title}`);
    const rev = p.revisions?.[0];
    return { title: p.title, pageid: p.pageid, revid: rev?.revid, text: rev?.slots?.main?.content ?? rev?.slots?.main?.['*'] ?? '' };
}
async function getUserFromLogid(id) {
    const rows = await queryAll({ list: 'logevents', leids: String(id), leprop: 'user|title|timestamp', lelimit: 1 }, 'logevents');
    return rows[0]?.user || '';
}
async function getUserFromDiff(id) {
    const r = await api({ action: 'query', prop: 'revisions', revids: String(id), rvprop: 'user' });
    return r.query.pages?.[0]?.revisions?.[0]?.user || '';
}
async function queryLocalBlocks(users, ips, isANS) {
    const targets = [...users, ...ips];
    const info = Object.create(null);
    if (!targets.length) return info;
    const rows = await queryAll({ list: 'blocks', bkprop: 'user|timestamp|expiry|restrictions|flags', bklimit: 'max', bkusers: targets }, 'blocks');
    for (const b of rows) {
        if (b.automatic || !b.user) continue;
        if (isANS && !ips.has(b.user) && b.expiry !== 'infinity') continue;
        info[b.user] = b;
    }
    // 個別 IP クエリは範囲ブロックも取得するために行う。
    for (const ip of ips) {
        const ipRows = await queryAll({ list: 'blocks', bkprop: 'user|timestamp|expiry|restrictions|flags', bklimit: 'max', bkip: ip }, 'blocks');
        const matches = ipRows.filter(b => !b.automatic && b.user);
        if (matches.length === 1) info[ip] = matches[0];
        else if (matches.length > 1) info[ip] = matches;
    }
    return info;
}
async function queryGlobalLocks(users) {
    const locked = new Set();
    for (const username of users) {
        try {
            const rows = await queryAll({ list: 'globalallusers', agufrom: username, aguto: username, aguprop: 'lockinfo', agulimit: 1 }, 'globalallusers');
            if (!rows.length) { nonexistingUsers.add(username); continue; }
            if (rows[0].locked === '') locked.add(username);
        } catch (e) { logError(e); }
    }
    return locked;
}
async function queryGlobalBlocks(users, ips, isANS) {
    const info = Object.create(null);
    const targets = [...users, ...ips];
    if (!targets.length) return info;
    const rows = await queryAll({ list: 'globalblocks', bgtargets: targets, bgprop: 'target|timestamp|expiry', bglimit: 'max' }, 'globalblocks');
    for (const b of rows) {
        if (b.automatic || !b.target || !b.timestamp || !b.expiry) continue;
        if (isANS && users.has(b.target) && b.expiry !== 'infinity') continue;
        if (!info[b.target]) info[b.target] = b;
        else if (Array.isArray(info[b.target])) info[b.target].push(b);
        else info[b.target] = [info[b.target], b];
    }
    for (const ip of ips) {
        const ipRows = await queryAll({ list: 'globalblocks', bgip: ip, bgprop: 'target|timestamp|expiry', bglimit: 'max' }, 'globalblocks');
        const matches = ipRows.filter(b => !b.automatic && b.target && b.timestamp && b.expiry);
        if (matches.length === 1) info[ip] = matches[0];
        else if (matches.length > 1) info[ip] = matches;
    }
    return info;
}
async function checkReblocks(reblockMap) {
    const result = Object.create(null);
    for (const [username, refDate] of Object.entries(reblockMap)) {
        const rows = await queryAll({ list: 'logevents', letype: 'block', letitle: `利用者:${username}`, leprop: 'user|timestamp|title|details|tags', lelimit: 'max' }, 'logevents');
        let newBlock = null; let oldBlock = null;
        for (const row of rows) {
            const action = row.action;
            const params = row.params || {};
            if (!['block', 'reblock'].includes(action) || !row.timestamp) continue;
            if (action === 'reblock' && !newBlock && isAfterRef(row.timestamp, refDate)) newBlock = row;
            else if (newBlock && !oldBlock && !isAfterRef(row.timestamp, refDate) && (params.duration === 'infinity' || (params.expiry && isAfterRef(params.expiry, refDate)))) { oldBlock = row; break; }
            else if (!newBlock && action === 'block') break;
        }
        if (newBlock && oldBlock) {
            const sanitize = row => ({ duration: row.params?.duration || '', expiry: row.params?.expiry, flags: row.params?.flags || [], sitewide: !!row.params?.sitewide, restrictions: row.params?.restrictions, timestamp: row.timestamp });
            result[username] = { new: sanitize(newBlock), old: sanitize(oldBlock) };
        }
    }
    return isObjectEmpty(result) ? null : result;
}
function restrictionsDiffer(a, b) {
    if (!a || !b) return !!a !== !!b;
    const sorted = v => JSON.stringify(v == null ? null : [...v].sort());
    return sorted(a.namespaces) !== sorted(b.namespaces) || sorted(a.actions) !== sorted(b.actions) ||
        JSON.stringify((a.pages || []).map(p => p.page_title).sort()) !== JSON.stringify((b.pages || []).map(p => p.page_title).sort());
}

function generateSummaryUserLink(info) {
    const status = info.reblocked || info.domain + info.duration;
    const username = isIP(info.user) ? ipAbbreviate(info.user) : info.user;
    if (/^(user2|unl|usernolink)$/.test(info.type)) {
        const max = containsJapaneseCharacter(username) ? 10 : 20;
        return username.length > max ? `${username.substring(0, max)}.. (${status})` : `[[特別:投稿記録/${username}|${username}]] (${status})`;
    }
    if (/^(ipuser)?2$/.test(info.type) || info.type === 'ip2') return `[[特別:投稿記録/${username}|${username}]] (${status})`;
    if (/^(log|logid)$/.test(info.type)) return `[[特別:転送/logid/${info.logid}|Logid/${info.logid}]] (${status})`;
    if (/^(diff|diffid)$/.test(info.type)) return `[[特別:差分/${info.diffid}|差分/${info.diffid}]]の投稿者 (${status})`;
    return '';
}

// ---------- ページ処理 ----------
async function markupPage(page, checkGlobal = true) {
    console.log(`Checking ${page}...`);
    try {
        const pageData = await fetchPage(page);
        const original = pageData.text;
        const sections = getSections(original);
        const allTemplates = findTemplates(original).filter(t => normalizeTemplateName(parseTemplate(t.raw).title) === 'useran');
        if (!allTemplates.length) { console.log('対象の {{UserAN}} はありません。'); return false; }

        const infos = [];
        for (const occurrence of allTemplates) {
            const temp = parseTemplate(occurrence.raw, occurrence.start);
            const params = temp.params;
            let user = paramValue(temp, ['1', 'user', 'User']);
            let typeKey = params.find(p => ['t', 'type', 'Type'].includes(clean(p.key)))?.key || '';
            let type = paramValue(temp, ['t', 'type', 'Type']).toLowerCase();
            const statusParam = params.find(p => ['状態', 's', 'status', 'Status'].includes(clean(p.key)));
            let modified = false;
            const botParam = params.find(p => clean(p.key) === 'bot');
            let botDate = null;
            if (botParam) {
                const botValue = clean(botParam.value);
                if (botValue.toLowerCase() === 'no') continue;
                botDate = convertTimestampToDateUTC(botValue);
            }
            if (paramValue(temp, ['2'])) continue; // 既に閉じている
            // 既知パラメータ以外は削除し、元コードと同じくテンプレート修正として扱う。
            const known = new Set(['1', 'user', 'User', 't', 'type', 'Type', '状態', 's', 'status', 'Status', '2', 'bot']);
            const before = temp.params.length;
            temp.params = temp.params.filter(p => known.has(clean(p.key)));
            if (temp.params.length !== before) modified = true;
            const paramCount = temp.params.filter(p => !['2', 'bot'].includes(clean(p.key))).length;
            const hasStatus = !!statusParam;
            const isOpen = !!user && (paramCount === 1 || (paramCount === 2 && (!!typeKey || hasStatus)) || (paramCount === 3 && !!typeKey && hasStatus)) && (!statusParam || !clean(statusParam.value));
            if (!isOpen) continue;
            if (!isIP(user) && /[/@#<>\[\]|{}:]|^(\d{1,3}\.){3}\d{1,3}$/.test(user)) continue;
            typeKey = typeKey || 't';
            type = type || (isIP(user) ? 'ip2' : 'user2');
            let logid = ''; let diffid = '';
            if (['user2', 'unl', 'usernolink'].includes(type) && isIP(user)) { setParam(temp, typeKey, 'ip2'); type = 'ip2'; modified = true; }
            else if (['ip2', 'ipuser2'].includes(type) && !isIP(user)) { setParam(temp, 't', '', { remove: true }); type = 'user2'; modified = true; }
            else if (['log', 'logid'].includes(type) && /^\d+$/.test(user)) { logid = user; user = await getUserFromLogid(user); }
            else if (['diff', 'diffid'].includes(type) && /^\d+$/.test(user)) { diffid = user; user = await getUserFromDiff(user); }
            else if (!['user2', 'unl', 'usernolink', 'ip2', 'ipuser2', 'log', 'logid', 'diff', 'diffid'].includes(type)) {
                if (isIP(user)) { setParam(temp, typeKey, 'ip2'); type = 'ip2'; modified = true; } else user = '';
            }
            if (!user && !isIP(user) && !logid && !diffid) continue;
            const section = sectionFor(occurrence.start, sections);
            if (!section) continue;
            let refDate = { date: botDate, type: 'bot' };
            if (!refDate.date) {
                const tail = original.slice(occurrence.end, section.end);
                const sig = tail.match(/(\d{4})年(\d{1,2})月(\d{1,2})日 \(.{1}\) (\d{2}):(\d{2}) \(UTC\)/);
                if (!sig) continue;
                refDate = { date: new Date(Date.UTC(+sig[1], +sig[2] - 1, +sig[3], +sig[4], +sig[5])), type: 'report' };
            }
            infos.push({ temp, occurrence, modified, user: user ? (isIP(user) ? user : sanitizeUsername(user)) : '', type, logid, diffid, refDate, sectionTitle: section.title, domain: '', duration: '', flags: '', date: '', reblocked: '' });
        }
        if (!infos.length) { console.log('未処理の報告はありません。'); return false; }

        // Logid / diffid 解決後に利用者集合を構築。
        const users = new Set(); const ips = new Set();
        for (const info of infos) {
            if (!info.user) { info.user = info.logid ? await getUserFromLogid(info.logid) : info.diffid ? await getUserFromDiff(info.diffid) : ''; }
            if (!info.user) continue;
            if (isIP(info.user)) ips.add(parseIP(info.user).text); else if (!nonexistingUsers.has(info.user)) users.add(info.user);
        }
        const validInfos = infos.filter(i => i.user && !nonexistingUsers.has(i.user));
        if (!users.size && !ips.size) return false;

        const blockInfo = await queryLocalBlocks(users, ips, page === ANS);
        const remainingIps = filterSet(ips, ip => !blockInfo[ip]);
        if (remainingIps.size) {
            // queryLocalBlocks 内ですでに bkip を問い合わせているが、別名で返る場合もあるため再照会しない。
        }
        const reblockMap = Object.create(null);
        for (const info of validInfos) {
            const username = isIP(info.user) ? parseIP(info.user).text : info.user;
            const blocks = blockInfo[username];
            if (!blocks) continue;
            let block;
            if (Array.isArray(blocks)) {
                const idx = getNarrowestBlockIndex(blocks, info.refDate);
                if (idx === null) { reblockMap[username] = info.refDate; continue; }
                block = blocks[idx];
            } else block = blocks;
            const blockDate = new Date(block.timestamp);
            if (isAfterRef(blockDate, info.refDate)) {
                const flags = [];
                if (!block.allowusertalk) flags.push('会話×');
                if (block.noemail) flags.push('メール×');
                if (isIP(info.user) && !block.anononly) flags.push('ハードブロック');
                info.domain = block.partial ? '部分ブロック' : '';
                info.duration = (isIP(info.user) ? cidrSuffix(block.user, info.user) : '') + (block.expiry === 'infinity' ? '無期限' : getBlockDuration(blockDate, block.expiry));
                info.flags = flags.join('・'); info.date = formatDateToMDinGMT9(blockDate);
            } else reblockMap[username] = info.refDate;
        }

        if (!isObjectEmpty(reblockMap)) {
            const reblocks = await checkReblocks(reblockMap);
            if (reblocks) for (const [username, reblock] of Object.entries(reblocks)) {
                const old = reblock.old; const newer = reblock.new;
                let domain = '';
                if (old.sitewide && !newer.sitewide) domain = '部分ブロック';
                else if (!old.sitewide && newer.sitewide) domain = 'サイト全体';
                else if (!old.sitewide && !newer.sitewide && restrictionsDiffer(old.restrictions, newer.restrictions)) domain = '部分ブロック条件変更';
                const newExpiry = newer.duration === 'infinity' ? 'infinity' : newer.expiry;
                const oldExpiry = old.duration === 'infinity' ? 'infinity' : old.expiry;
                const duration = newExpiry !== oldExpiry ? newExpiry : '';
                const added = newer.flags.filter(f => !old.flags.includes(f));
                const removed = old.flags.filter(f => !newer.flags.includes(f));
                const flags = [];
                for (const [arr, isRemoved] of [[added, false], [removed, true]]) for (const f of arr) {
                    const dict = { anononly: isRemoved ? 'ハードブロック' : 'ソフトブロック', nocreate: `アカウント作成${isRemoved ? '〇' : '×'}`, noemail: `メール${isRemoved ? '〇' : '×'}`, nousertalk: `会話${isRemoved ? '〇' : '×'}`, noautoblock: `自動ブロック${isRemoved ? '有' : '無'}効化` };
                    if (dict[f]) flags.push(dict[f]);
                }
                const target = validInfos.find(i => isIP(i.user) ? ipEquals(i.user, username) : i.user === username);
                if (target) {
                    const date = new Date(newer.timestamp);
                    target.domain = domain; target.duration = duration === 'infinity' ? '無期限' : duration ? getBlockDuration(date, duration) : '';
                    target.flags = flags.join('・'); target.date = formatDateToMDinGMT9(date); target.reblocked = '条件変更';
                }
            }
        }

        if (checkGlobal) {
            const gUsers = new Set(); const gIps = new Set();
            for (const info of validInfos) {
                if (info.date || info.refDate.type === 'bot') continue;
                if (isIP(info.user)) gIps.add(parseIP(info.user).text); else gUsers.add(info.user);
            }
            const locked = gUsers.size ? await queryGlobalLocks(gUsers) : new Set();
            for (const username of locked) {
                const info = validInfos.find(i => i.user === username);
                if (info) { info.domain = 'グローバルロック'; info.date = formatDateToMDinGMT9(new Date()); }
            }
            for (const u of locked) gUsers.delete(u);
            const gblocks = await queryGlobalBlocks(gUsers, gIps, page === ANS);
            for (const info of validInfos) {
                const username = isIP(info.user) ? parseIP(info.user).text : info.user;
                const blocks = gblocks[username]; if (!blocks) continue;
                const block = Array.isArray(blocks) ? blocks[getNarrowestBlockIndex(blocks, info.refDate)] : blocks;
                if (!block) continue;
                const date = new Date(block.timestamp);
                if (!isAfterRef(date, info.refDate)) continue;
                info.domain = 'グローバルブロック';
                info.duration = (isIP(info.user) ? cidrSuffix(block.target, info.user) : '') + (block.expiry === 'infinity' ? '無期限' : getBlockDuration(date, block.expiry));
                info.date = formatDateToMDinGMT9(date);
            }
        }

        // 不要なエントリを除き、テンプレート文字列を生成する。
        const summaryMap = new Map(); const registeredLinks = []; const replacements = [];
        for (const info of validInfos) {
            if (!info.modified && !info.date) continue;
            if (!summaryMap.has(info.sectionTitle)) summaryMap.set(info.sectionTitle, []);
            if (info.date) {
                const display = [info.domain + info.duration, info.flags, `(${info.date})`].filter(Boolean).join(' ');
                setParam(info.temp, '2', display);
                setParam(info.temp, 'bot', '', { remove: true });
                const link = generateSummaryUserLink(info);
                if (link && !registeredLinks.includes(link)) { summaryMap.get(info.sectionTitle).push(link); registeredLinks.push(link); }
            }
            replacements.push({ start: info.occurrence.start, end: info.occurrence.end, text: stringifyTemplate(info.temp) });
        }
        if (!replacements.length) { console.log('編集対象なし。'); return false; }
        const newText = applyReplacements(original, replacements);
        if (newText === original) { console.log('内容に変更がありません。'); return false; }

        let summary = 'Bot(代理):';
        const modOnly = [...summaryMap.values()].every(links => links.length === 0);
        if (modOnly) summary += ' UserANの修正';
        else {
            outer: for (const [title, links] of summaryMap) {
                if (!links.length) continue;
                const first = ` /*${title}*/ ${links[0]}`;
                if (summary.length + first.length <= 497) summary += first; else { summary += ' ほか'; break; }
                for (let i = 1; i < links.length; i++) {
                    const part = (summary.endsWith(']]') ? ', ' : ' ') + links[i];
                    if (summary.length + part.length <= 497) summary += part; else { summary += ' ほか'; break outer; }
                }
            }
        }
        if (DRY_RUN) {
            console.log(`[DRY RUN] ${page}: ${summary}`);
            console.log(`変更前 ${original.length} 文字 / 変更後 ${newText.length} 文字`);
            return true;
        }
        console.log(`Editing ${page}...`);
        // baserevid を付けて、取得後に他者が編集していた場合の上書きを防ぐ。
        await bot.save(page,newText,summary, {
            baserevid: pageData.revid,
            minor: true,
            bot: false,
            nocreate: 1,
            tags: 'non-bot action by bot',
        });
        console.log('Edit done.');
        logger.success(taskId, `${summaryMap.size}件報告の処理が完了しました。`,true);
        return true;
    } catch (err) {
        logger.error(taskId, `処理中にエラーが発生しました。`, true);
        logError(err);
        return null;
    }
}

async function markupANs(checkGlobal = true) {
    for (const page of [ANI, ANS, AN3RR]) {
        await markupPage(page, checkGlobal);
        await sleep(60000);
    }
}

async function main() {
    await checkTaskStatusAndExit(taskId);
    await bot.login();
    const checkGlobal = process.env.CHECK_GLOBAL !== '0';
    const pageArg = process.argv.find(arg => arg.startsWith('--page='));
    if (pageArg) await markupPage(pageArg.slice('--page='.length), checkGlobal);
    else await markupANs(checkGlobal);
}

if (require.main === module) main().catch(err => { logError(err); process.exitCode = 1; });
module.exports = { markupANs, markupPage, findTemplates, parseTemplate, getBlockDuration, convertTimestampToDateUTC };
