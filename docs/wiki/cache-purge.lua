-- キャッシュ破棄タスク（w-ja-nn6）設定表示・入力検証モジュール
-- 利用者:NanonaBot2/w-ja-nn6/config/temp から {{#invoke:...|main}} で呼び出す
local p = {}

local modes = {
    purge = '通常のキャッシュ破棄',
    forcelinkupdate = 'リンクテーブルも更新',
    forcerecursivelinkupdate = '参照元のリンクテーブルも更新',
    nulledit = '空編集'
}

local function trim(value)
    -- 実Scribuntoではコメント除去・展開済み。直接呼出し時もコメントを除去する。
    local text = tostring(value or ''):gsub('<!%-%-.-%-%->', '')
    return mw.text.trim(text)
end

local function showError(message)
    return '<div class="error">キャッシュ破棄設定エラー: '
        .. mw.text.nowiki(message) .. '</div>'
end

-- 空の項目も残す（",5" や "5," を見逃さない）。
local function splitComma(value)
    local parts = {}
    for part in (value .. ','):gmatch('(.-),') do
        parts[#parts + 1] = part
    end
    return parts
end

local function parseField(field, minimum, maximum)
    local ranges = {}
    for _, part in ipairs(splitComma(field)) do
        local base, stepText = part:match('^([^/]+)/(%d+)$')
        local hasStep = base ~= nil
        if not base then
            base = part
            stepText = '1'
        end
        if hasStep and base ~= '*' and not base:find('-', 1, true) then
            return nil
        end
        local first, last
        if base == '*' then
            first, last = minimum, maximum
        else
            local a, b = base:match('^(%d+)%-(%d+)$')
            if a then
                first, last = tonumber(a), tonumber(b)
            elseif base:match('^%d+$') then
                first = tonumber(base)
                last = first
            else
                return nil
            end
        end
        local step = tonumber(stepText)
        if not step or step < 1 or step == math.huge
            or first < minimum or last > maximum or first > last then
            return nil
        end
        ranges[#ranges + 1] = { first, last, step }
    end
    return ranges
end

local function validateCron(fields)
    local bounds = { {0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7} }
    local minutes
    for i = 1, 5 do
        local ranges = parseField(fields[i], bounds[i][1], bounds[i][2])
        if not ranges then
            return 'cron式の第' .. i .. 'フィールドが不正です: ' .. fields[i]
        end
        if i == 1 then minutes = ranges end
    end
    for minute = 0, 59 do
        for _, range in ipairs(minutes) do
            if minute >= range[1] and minute <= range[2]
                and (minute - range[1]) % range[3] == 0
                and minute % 5 ~= 0 then
                return 'cron式の分は5分単位（0, 5, …, 55）にしてください。'
            end
        end
    end
    return nil
end

local function validateTiming(value)
    local fields = {}
    for field in value:gmatch('%S+') do fields[#fields + 1] = field end
    if #fields == 5 then
        return validateCron(fields), 'UTC cron'
    end
    local lower = value:lower()
    local h, m = lower:match('^(%d+)h(%d+)m$')
    if not h then
        h = lower:match('^(%d+)h$')
        if h then m = '0' end
    end
    if not h then
        m = lower:match('^(%d+)m$')
        if m then h = '0' end
    end
    if not h or not m then
        return '第2引数は15m・2h・1h30m、またはUTCの5フィールドcron式にしてください。'
    end
    local total = tonumber(h) * 60 + tonumber(m)
    if total < 5 or total > 10080 then
        return '間隔は5分以上7日以下にしてください。'
    end
    return nil, '実行間隔'
end

-- BotのvalidateItemと同じ、展開を含まない絶対ページ名の制約。
local function validPage(page)
    if #page > 255 or page:find('[|{}%[%]<>#%z\1-\31\127]')
        or page:find('%%[%da-fA-F][%da-fA-F]')
        or page:find('&[%a]+;') or page:find('&#%d+;')
        or page:find('&#[xX][%da-fA-F]+;') or page:find('~~~', 1, true) then
        return false
    end
    local name = mw.text.trim(page:gsub('_', ' '))
    if name == '' or name:sub(1, 1) == ':' or name:sub(1, 1) == '/'
        or name:sub(-1) == ':' then return false end
    for part in (name .. '/'):gmatch('(.-)/') do
        local trimmedPart = mw.text.trim(part)
        if trimmedPart == '.' or trimmedPart == '..' then return false end
    end
    return true
end

function p.main(frame)
    -- #invokeへ引数を渡した場合はその引数、なければtempの引数を使う。
    local args = frame.args
    local hasDirectArgs = false
    for _ in pairs(args) do hasDirectArgs = true; break end
    if not hasDirectArgs then
        local parent = frame:getParent()
        args = parent and parent.args or {}
    end
    local page, timing, mode = trim(args[1]), trim(args[2]), trim(args[3])
    for key in pairs(args) do
        if key ~= 1 and key ~= 2 and key ~= 3 then
            return showError('引数はページ名・間隔またはUTC cron式・modeの3つだけです。')
        end
    end
    if page == '' or timing == '' or mode == '' then
        return showError('書式: {{/temp|ページ名|間隔またはUTC cron式|mode}}')
    end
    mode = mode:lower()
    if not modes[mode] then
        return showError('modeはpurge / forcelinkupdate / forcerecursivelinkupdate / nulleditのいずれか1つです。')
    end
    local message, timingLabel = validateTiming(timing)
    if message then return showError(message) end
    if not validPage(page) then
        return showError('ページ名が不正です: ' .. page)
    end
    local link = '[[:' .. mw.text.nowiki(page)
        .. '|' .. mw.text.nowiki(page) .. ']]'
    return '<div class="nanonabot2-cache-purge-item">' .. link
        .. ' — ' .. timingLabel .. ': <code>' .. mw.text.nowiki(timing)
        .. '</code> — ' .. modes[mode] .. ' (<code>' .. mode .. '</code>)</div>'
end

return p
