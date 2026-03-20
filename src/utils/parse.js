
/**
 * 非同期処理用のスリープ関数
 * @param {number} ms - 待機時間（ミリ秒）
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * メインのテンプレートパーサー関数
 * @param {string} input - 解析する文字列
 * @param {string} tempname - テンプレート名
 * @returns {Promise<Array>} [[テンプレート内容, 引数オブジェクト], ...] の配列
 */
async function parseTemplate(input, tempname) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegex(tempname)}\\s*(\\||\\}\\})`, 'ig');
    const temps = [];
    let result;

    while ((result = pattern.exec(input)) !== null) {
        const matchInfo = await findMatchingBraces(input, result, tempname);

        if (!matchInfo.isValid) {
            throw new Error("入力文字列の中括弧が一致しません");
        }

        const tempcontent = input.substring(result.index, matchInfo.endIndex);
/*
        // nowikiチェック（元のコードと同様）
        if (tempcontent.includes('<nowiki>')) {
            return false;
        }
*/
        const content2 = await extractElements(tempcontent, tempname);
        temps.push([tempcontent, content2]);

        // パターンの次の検索位置を設定
        pattern.lastIndex = matchInfo.endIndex;

        // 非同期処理のため、適度に制御を戻す
        await sleep(0);
    }
    temps.push(['', {}]); // 最後に空のテンプレートを追加
    return temps;
}

/**
 * 対応する中括弧を見つける
 * @param {string} input - 入力文字列
 * @param {RegExpExecArray} match - 正規表現マッチ結果
 * @param {string} tempname - テンプレート名
 * @returns {Promise<Object>} 終了位置と妥当性の情報
 */
async function findMatchingBraces(input, match, tempname) {
    let openBracesCount = 2;
    let closeBracesCount = 0;
    let endIndex = match.index + 2 + tempname.length;

    for (let i = endIndex; i < input.length; i++) {
        if (input[i] === '{' && input[i + 1] === '{') {
            openBracesCount += 2;
            i++; // 次の文字をスキップ
        } else if (input[i] === '}' && input[i + 1] === '}' && closeBracesCount < openBracesCount) {
            closeBracesCount += 2;
            i++; // 次の文字をスキップ

            if (openBracesCount === closeBracesCount) {
                return { endIndex: i + 1, isValid: true };
            }
        }
    }

    return { endIndex: -1, isValid: false };
}

/**
 * テンプレート内の引数を抽出
 * @param {string} input - テンプレート文字列
 * @param {string} tempname - テンプレート名
 * @returns {Promise<Object>} 引数オブジェクト
 */
async function extractElements(input, tempname) {
    // テンプレート名と中括弧を除去
    const trimmedInput = input
        .replace(new RegExp(`^\\{\\{${escapeRegex(tempname)}[ 　\n]*`), '')
        .replace(/\}\}$/, '')
        //.trim();

    const result = {};
    const defaultArguments = [];
    const existingArguments = {};

    // パイプで分割（統一関数を使用）
    const parts = splitWithContext(trimmedInput, '|', false);

    let maxNum = 0;
    let counter = 1;

    // 各パートを処理
    for (const part of parts) {
        const [key, value] = splitWithContext(part, '=', true);

        if (value === undefined) {
            // "=" がない場合
            //trimで何も無くなる場合はtrimしない
            if (key.trim() !== '') {
                defaultArguments.push(key.trim());
            }else{
               defaultArguments.push(key);
           }
        } else {
            const trimmedKey = (key.trim() !== '') ? key.trim() : key;
            const trimmedValue = (value.trim() !== '') ? value.trim() : value;

            if (!trimmedKey) {
                // キーが空の場合
                defaultArguments.push(trimmedValue);
            } else if (/^\d+$/.test(trimmedKey)) {
                // 数値キーの場合
                const numKey = parseInt(trimmedKey, 10);
                existingArguments[numKey] = trimmedValue;
                maxNum = Math.max(maxNum, numKey);
            } else {
                // 文字列キーの場合
                result[trimmedKey] = trimmedValue;
            }
        }
    }

    // 無名引数に番号を割り当て
    for (const arg of defaultArguments) {
        while (existingArguments[counter]) {
            counter++;
        }
        result[counter] = arg;
        counter++;
    }

    // 既存の数値引数を追加
    Object.assign(result, existingArguments);

    return result;
}

/**
 * ネストされたテンプレート、リンク、HTMLコメント、nowikiタグ、HTMLタグを考慮した汎用文字分割関数
 * @param {string} input - 分割する文字列
 * @param {string} delimiter - 分割文字（'|' または '='）
 * @param {boolean} returnFirstMatch - trueの場合、最初の区切り文字で分割して[前部分, 後部分]を返す（'='用）
 * @returns {Array<string>} 分割された文字列の配列
 */
function splitWithContext(input, delimiter = '|', returnFirstMatch = false) {
    const result = [];
    let current = '';
    let depth = 0;
    let inLink = false;
    let inHtmlComment = false;
    let inNowiki = false;
    let inHtmlTag = false;
    const htmlTagStack = [];

    const validHtmlTags = ['ref', 'nowiki', 'small', 'span', 'div'];

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const nextChar = input[i + 1];

        // HTMLコメント開始
        if (char === '<' && input.slice(i, i + 4) === '<!--') {
            inHtmlComment = true;
            current += input.slice(i, i + 4);
            i += 3;
            continue;
        }

        // HTMLコメント終了
        if (inHtmlComment && char === '-' && input.slice(i, i + 3) === '-->') {
            inHtmlComment = false;
            current += input.slice(i, i + 3);
            i += 2;
            continue;
        }

        // <nowiki>開始
        if (char === '<' && input.slice(i, i + 8).toLowerCase() === '<nowiki>') {
            inNowiki = true;
            current += input.slice(i, i + 8);
            i += 7;
            continue;
        }

        // <nowiki>終了
        if (inNowiki && char === '<' && input.slice(i, i + 9).toLowerCase() === '</nowiki>') {
            inNowiki = false;
            current += input.slice(i, i + 9);
            i += 8;
            continue;
        }

        // 自閉じタグ（例: <ref />）
        const selfClosingTagMatch = input.slice(i).match(/^<([a-zA-Z]+)(\s[^>]*)?\/>/);
        if (char === '<' && selfClosingTagMatch && validHtmlTags.includes(selfClosingTagMatch[1].toLowerCase())) {
            current += selfClosingTagMatch[0];
            i += selfClosingTagMatch[0].length - 1;
            continue;
        }

        // HTMLタグ開始
        const tagMatch = input.slice(i).match(/^<([a-zA-Z]+)(\s[^>]*)?>/);
        if (char === '<' && tagMatch && validHtmlTags.includes(tagMatch[1].toLowerCase()) && !selfClosingTagMatch) {
            inHtmlTag = true;
            current += tagMatch[0];
            htmlTagStack.push(tagMatch[1].toLowerCase());
            i += tagMatch[0].length - 1;
            continue;
        }

        // HTMLタグ終了
        const endTagMatch = input.slice(i).match(/^<\/([a-zA-Z]+)>/);
        if (inHtmlTag && char === '<' && endTagMatch && htmlTagStack.includes(endTagMatch[1].toLowerCase())) {
            // 対応するタグを削除
            const tagIndex = htmlTagStack.lastIndexOf(endTagMatch[1].toLowerCase());
            htmlTagStack.splice(tagIndex, 1);
            inHtmlTag = htmlTagStack.length > 0;
            current += endTagMatch[0];
            i += endTagMatch[0].length - 1;
            continue;
        }

        // コメントや<nowiki>、HTMLタグ内はスキップ
        if (inHtmlComment || inNowiki || inHtmlTag) {
            current += char;
            continue;
        }

        // テンプレートの開始
        if (char === '{' && nextChar === '{') {
            depth++;
            current += '{{';
            i++;
        }
        // テンプレートの終了
        else if (char === '}' && nextChar === '}' && depth > 0) {
            depth--;
            current += '}}';
            i++;
        }
        // リンクの開始
        else if (char === '[' && nextChar === '[') {
            inLink = true;
            current += '[[';
            i++;
        }
        // リンクの終了
        else if (char === ']' && nextChar === ']' && inLink) {
            inLink = false;
            current += ']]';
            i++;
        }
        // 区切り文字の処理
        else if (char === delimiter && depth === 0 && !inLink) {
            if (returnFirstMatch) {
                // '='の場合：最初の出現で分割して[前部分, 後部分]を返す
                return [current, input.slice(i + 1)];
            } else {/*
                // '|'の場合：分割を続行
                if (current.trim()) {
                    result.push(current.trim());
                }*/
                if (current) result.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    // 残りの部分を追加
    if (returnFirstMatch) {
        // '='が見つからなかった場合
        return [current];
    } else {/*
        if (current.trim()) {
            result.push(current.trim());
        }*/
        if (current) result.push(current);
        return result;
    }
}

/**
 * 正規表現用の文字列をエスケープ
 * @param {string} string - エスケープする文字列
 * @returns {string} エスケープされた文字列
 */
function escapeRegex(str) {
    if (!str) return null;

    const firstChar = str[0];
    const rest = str.slice(1);
    const isAlphabet = /^[A-Za-z]$/.test(firstChar);
    const escapeRegex = /[.*+?^${}()|[\]\\]/g;

    let firstPart = firstChar;
    if (isAlphabet) {
        const upper = firstChar.toUpperCase();
        const lower = firstChar.toLowerCase();
        firstPart = `[${upper}${lower}]`;
    }else{
        firstPart = firstChar.replace(escapeRegex, '\\$&');
    }

    return firstPart + rest.replace(escapeRegex, '\\$&').replace(/ /g, '[ _]');
}

/**
 * Wikitext節パーサー関数
 * @param {string} wikitext - 解析するwikitext
 * @param {number} level - 節レベル（0の場合はすべてのレベル、1以上の場合はそのレベル以下）
 * @returns {Array<Object>} 節情報の配列
 */
function parseSection(wikitext, level = 0) {
    const sections = [];
    const lines = wikitext.split('\n');
    
    let currentSection = null;
    let currentContent = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sectionMatch = line.match(/^(=+)\s*(.+?)\s*\1\s*$/);
        
        if (sectionMatch) {
            const sectionLevel = sectionMatch[1].length;
            const sectionName = sectionMatch[2].trim();
            
            // レベルフィルタリング
            const shouldInclude = level === 0 || sectionLevel <= level;
            
            if (shouldInclude) {
                // 前の節があれば保存
                if (currentSection) {
                    currentSection.content = currentContent.join('\n');
                    sections.push(currentSection);
                }
                
                // 新しい節を開始
                currentSection = {
                    seclevel: sectionLevel,
                    wikitext: line, // 後で更新される
                    name: sectionName,
                    content: ''
                };
                currentContent = [];
            } else {
                // レベルが大きすぎる場合は内容として扱う
                if (currentSection) {
                    currentContent.push(line);
                }
            }
        } else {
            // 節ヘッダーでない行
            if (currentSection) {
                currentContent.push(line);
            }
        }
    }
    
    // 最後の節を保存
    if (currentSection) {
        currentSection.content = currentContent.join('\n');
        sections.push(currentSection);
    }
    
    // wikitextフィールドを更新（節ヘッダー + 内容）
    sections.forEach(section => {
        const headerLine = '='.repeat(section.seclevel) + ' ' + section.name + ' ' + '='.repeat(section.seclevel);
        section.wikitext = section.content ? headerLine + '\n' + section.content : headerLine;
    });
    
    return sections;
}
/**
 * {{nobots}} や {{bots|deny=ユーザー名}} などの判定関数
 * @param {string} text - wikitext
 * @param {string} user - チェックするユーザー名（省略時は "管理者"）
 * @returns {boolean} 許可する場合はtrue、拒否する場合はfalse
 */
async function allowBots(text, user = "NanonaBot2") {
    if (!new RegExp("\\{\\{\\s*(nobots|bots[^}]*)\\s*\\}\\}", "i").test(text)) return true;
    return (new RegExp("\\{\\{\\s*bots\\s*\\|\\s*deny\\s*=\\s*([^}]*,\\s*)*" + user.replace(/([\(\)\*\+\?\.\-\:\!\=\/\^\$])/g, "\\$1") + "\\s*(?=[,\\}])[^}]*\\s*\\}\\}", "i").test(text)) ? false : new RegExp("\\{\\{\\s*((?!nobots)|bots(\\s*\\|\\s*allow\\s*=\\s*((?!none)|([^}]*,\\s*)*" + user.replace(/([\(\)\*\+\?\.\-\:\!\=\/\^\$])/g, "\\$1") + "\\s*(?=[,\\}])[^}]*|all))?|bots\\s*\\|\\s*deny\\s*=\\s*(?!all)[^}]*|bots\\s*\\|\\s*optout=(?!all)[^}]*)\\s*\\}\\}", "i").test(text);
}

// CommonJS形式
module.exports = {
    parseTemplate,
    splitWithContext,
    escapeRegex,
    parseSection,
    allowBots
};