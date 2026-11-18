-- Run from repository root: lua test/cachePurgeModule.test.lua
-- ScribuntoのAPIを最小限模したローカル動作確認。
mw = {
    text = {
        trim = function(s) return (s:gsub('^%s+', ''):gsub('%s+$', '')) end,
        nowiki = function(s) return s end
    },
    title = { new = function(s)
        if s == 'Invalid[' then return nil end
        return { prefixedText = s }
    end }
}
local module = dofile('docs/wiki/cache-purge.lua')
local count = 0
local function check(args, expected, direct)
    local frame = {
        args = direct and args or {},
        getParent = function() return { args = direct and {} or args } end
    }
    local output = module.main(frame)
    assert(output:find(expected, 1, true), output)
    count = count + 1
end
check({'Template:RfA watchlist notice', '15m', 'purge'}, '[[:Template:RfA watchlist notice|')
check({'Template:X', '30 9 * * 1', 'purge'}, 'UTC cron')
check({'Template:X', '*/5 * * * *', 'purge'}, 'UTC cron')
check({'Template:X', '1h30m', 'nulledit'}, '空編集')
check({'Template:X', '15M', 'PURGE'}, '通常のキャッシュ破棄', true)
check({'Template:X', '7 9 * * 1', 'purge'}, '5分単位')
check({'Template:X', '0,,5 9 * * 1', 'purge'}, '第1フィールドが不正')
check({'Template:X', '0 24 * * 1', 'purge'}, '第2フィールドが不正')
check({'Template:X', '0/0 9 * * 1', 'purge'}, '第1フィールドが不正')
check({'Template:X', '0 9 * * 8', 'purge'}, '第5フィールドが不正')
check({'Template:X', '4m', 'purge'}, '5分以上7日以下')
check({'Template:X', '169h', 'purge'}, '5分以上7日以下')
check({'Template:X', 'bad', 'purge'}, '第2引数は')
check({'Template:X', '15m', 'purge,nulledit'}, 'modeは')
check({'Invalid[', '15m', 'purge'}, 'ページ名が不正')
check({}, '書式:')
check({'Template:X', '15m', 'purge', 'extra'}, '3つだけ')
local noParent = module.main({args = {}, getParent = function() return nil end})
assert(noParent:find('書式:', 1, true))
print(tostring(count + 1) .. ' module checks passed')

-- Botと同じfixtureを読み、同じ受理・拒否を要求する。
local corpusCount = 0
for rawLine in io.lines('test/cases/cache-purge-validation.tsv') do
    local line = rawLine:gsub('\r$', '')
    if line ~= '' and line:sub(1, 1) ~= '#' then
        local columns = {}
        for value in (line .. '\t'):gmatch('(.-)\t') do columns[#columns + 1] = value end
        local args = {columns[2], columns[3], columns[4]}
        if columns[5] and columns[5] ~= '' then args[tonumber(columns[5]) or columns[5]] = 'x' end
        local output = module.main({args = args, getParent = function() return nil end})
        local accepted = not output:find('class="error"', 1, true)
        assert(accepted == (columns[1] == '1'), line .. '\n' .. output)
        corpusCount = corpusCount + 1
    end
end
print(tostring(corpusCount) .. ' shared validation cases passed')

-- Scribuntoが親フレームの引数を遅延展開して返す契約を模す。
local expansionCount = 0
for rawLine in io.lines('test/cases/cache-purge-expansion.tsv') do
    local line = rawLine:gsub('\r$', '')
    if line ~= '' and line:sub(1, 1) ~= '#' then
        local c = {}
        for value in (line .. '\t'):gmatch('(.-)\t') do c[#c + 1] = value end
        local expanded = {c[7], c[3], c[5]}
        local args = setmetatable({}, {
            __index = function(_, key) return expanded[key] end,
            __pairs = function() return pairs(expanded) end
        })
        local output = module.main({args = {}, getParent = function() return {args = args} end})
        assert((not output:find('class="error"', 1, true)) == (c[1] == '1'), line .. '\n' .. output)
        expansionCount = expansionCount + 1
    end
end
print(tostring(expansionCount) .. ' parent-frame expansion cases passed')
