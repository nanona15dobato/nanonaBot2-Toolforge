const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WikitextParser = require('../src/utils/parse2');
const LegacyParser = require('./legacy/parse2-v1');

const parse = (text, options) => new WikitextParser().parse(text, options);

// ==========================================
// テンプレート
// ==========================================
test('テンプレートの名前・引数・位置', () => {
    const text = '前{{Infobox 鉄道駅 |名前= 東京駅 |2|[[山手線|山手]]|備考={{仮リンク|A|en|B}}}}後';
    const [outer, inner] = parse(text).templates;
    assert.equal(outer.name, 'Template:Infobox 鉄道駅');
    assert.equal(outer.original, text.slice(1, -1));
    assert.deepEqual(outer.position, { start: 1, end: text.length - 1 });
    assert.deepEqual(outer.args, { 名前: '東京駅', 1: '2', 2: '[[山手線|山手]]', 備考: '{{仮リンク|A|en|B}}' });
    assert.equal(inner.name, 'Template:仮リンク');
    assert.equal(text.slice(outer.namePosition.start, outer.namePosition.end), 'Infobox 鉄道駅');
});

test('argsOrdered は書かれた順・重複も残し、キーと値の位置を持つ', () => {
    const text = '{{X|b=1|2|a = 3 |b=4}}';
    const t = parse(text).templates[0];
    assert.deepEqual(t.argsOrdered.map(a => [a.key, a.value, a.named]), [['b', '1', true], ['1', '2', false], ['a', '3', true], ['b', '4', true]]);
    // args（オブジェクト）は旧版どおり後の値で上書き
    assert.equal(t.args.b, '4');
    const a = t.argsOrdered[2];
    assert.equal(text.slice(a.keyPosition.start, a.keyPosition.end), 'a');
    assert.equal(text.slice(a.valuePosition.start, a.valuePosition.end), '3');
    assert.equal(text.slice(a.position.start, a.position.end), 'a = 3 ');
    assert.equal(text[a.position.start - 1], '|');
});

test('種類: パーサー関数・マジックワード・subst', () => {
    const t = parse('{{#if: x | y }}{{DEFAULTSORT:あ}}{{subst:foo|1}}').templates;
    assert.deepEqual(t.map(x => [x.type, x.name]), [['parser_function', '#if'], ['magic_word', 'DEFAULTSORT'], ['substTemplate', 'Template:Foo']]);
    assert.equal(t[0].args['1'], 'x');
    assert.equal(t[1].args['1'], 'あ');
});

test('テンプレートの絞り込み', () => {
    const t = parse('{{A|{{B}}}}{{C}}', { templates: ['B', 'Template:C'] }).templates;
    assert.deepEqual(t.map(x => x.name), ['Template:B', 'Template:C']);
});

// ==========================================
// リンク・カテゴリ・ファイル
// ==========================================
test('リンク・カテゴリ・ファイルの区別と [[:Category:X]]', () => {
    const r = parse('[[記事|表示]] [[:Category:X]] [[Category:Y| ]] [[カテゴリ:z_w|キー]] [[ファイル:A.jpg|thumb|説明 [[リンク]]]]');
    assert.deepEqual(r.wikilinks.map(l => [l.target, l.text, !!l.colon]), [['記事', '表示', false], ['Category:X', ':Category:X', true], ['リンク', 'リンク', false]]);
    assert.deepEqual(r.categories.map(c => [c.category, c.sortKey, c.sortKeyRaw]), [['Y', null, ' '], ['Z w', 'キー', 'キー']]);
    assert.equal(r.files[0].file, 'A.jpg');
    assert.deepEqual(r.files[0].options, ['thumb', '説明 [[リンク]]']);
});

test('外部リンク・ref・変数', () => {
    const r = parse('[https://example.com/a 例] <ref name="a">本文{{cite|x}}</ref><ref name=b /> {{{1|既定}}}');
    assert.deepEqual(r.extlinks.map(e => [e.url, e.text]), [['https://example.com/a', '例']]);
    assert.deepEqual(r.references.map(x => [x.attributes, x.content]), [['name="a"', '本文{{cite|x}}'], ['name=b', null]]);
    assert.deepEqual(r.variables.map(v => [v.name, v.default]), [['1', '既定']]);
});

// ==========================================
// 保護領域・壊れた入力
// ==========================================
test('コメントと nowiki の中は解析しない', () => {
    const r = parse('<!-- {{A}} [[B]] --><nowiki>{{C}}</nowiki>{{D|x<!--|-->y}}');
    assert.deepEqual(r.templates.map(t => t.name), ['Template:D']);
    assert.equal(r.templates[0].args['1'], 'x<!--|-->y');
    assert.equal(r.wikilinks.length, 0);
});

test('閉じ忘れがあっても後ろの要素は解析できる', () => {
    const r = parse('{{A|[[閉じないリンク}} {{B}} [[C]] {{閉じない');
    assert.deepEqual(r.templates.map(t => t.name), ['Template:A', 'Template:B']);
    assert.deepEqual(r.wikilinks.map(l => l.target), ['C']);
});

test('深い入れ子でも時間がかからない', () => {
    const text = '{{a|'.repeat(3000) + 'x' + '}}'.repeat(3000);
    const start = Date.now();
    assert.equal(parse(text, { templates: true }).templates.length, 3000);
    assert.ok(Date.now() - start < 3000);
});

// ==========================================
// 見出し・表・箇条書き
// ==========================================
test('見出しの位置はテンプレートやコメントを含んでも元の文字列の位置', () => {
    const text = '{{冒頭}}<!-- c -->\n== 見出し{{a}} ==\n本文\n=== 小 ===\n* 項目 [[x]]\n== 次 ==\n';
    const r = parse(text);
    const h = r.headings[0];
    assert.equal(h.title, '見出し{{a}}');
    assert.equal(text.slice(h.position.header.start, h.position.header.end), '== 見出し{{a}} ==');
    assert.equal(h.content, '本文\n=== 小 ===\n* 項目 [[x]]');
    assert.deepEqual(r.headings[1].parents.map(p => p.title), ['見出し{{a}}']);
    assert.equal(text.slice(r.lists[0].position.start, r.lists[0].position.end), '* 項目 [[x]]');
});

test('表', () => {
    const t = parse('{| class="wikitable"\n|+ 題\n! A !! B\n|-\n| 1 || {{x|2}}\n|}').tables[0];
    assert.equal(t.attributes, 'class="wikitable"');
    assert.equal(t.caption.text, '題');
    assert.deepEqual(t.rows.map(r => r.cells.map(c => c.text)), [['A', 'B'], ['1', '{{x|2}}']]);
});

test('applyEdits は後ろから適用し、重なりは拒否する', () => {
    assert.equal(WikitextParser.applyEdits('abcdef', [{ start: 0, end: 1, replacement: 'X' }, { start: 4, end: 6, replacement: '' }]), 'Xbcd');
    assert.throws(() => WikitextParser.applyEdits('abc', [{ start: 0, end: 2, replacement: '' }, { start: 1, end: 3, replacement: '' }]));
});

// ==========================================
// 旧版との一致
// ==========================================
// 実ページの wikitext（test/fixtures/*.txt / *.wiki）はリポジトリに含めない。置いたときだけ比べる
const fixtureDir = path.join(__dirname, 'fixtures');
const fixtures = fs.existsSync(fixtureDir) ? fs.readdirSync(fixtureDir).filter(f => /\.(txt|wiki)$/.test(f)) : [];

test('実ページで旧版と同じ結果になる（追加した項目と名前空間の正規化を除く）', { skip: fixtures.length === 0 && 'test/fixtures/ に wikitext がありません' }, () => {
    const dir = fixtureDir;
    // 新版で追加した項目は比べない
    const strip = ({ argsOrdered, namePosition, colon, sortKeyRaw, ...rest }) => rest;
    // 名前空間の正規化（カテゴリ:x → Category:X など）で変わる項目は比べない
    const categoryFields = c => ({ sortKey: c.sortKey, position: c.position, original: c.original });
    const isColonLink = x => /^\[\[\s*:/.test(x.original);
    for (const file of fixtures) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const a = new LegacyParser().parse(text);
        const b = new WikitextParser().parse(text);
        for (const key of ['variables', 'extlinks', 'tables', 'headings', 'references', 'lists']) {
            assert.deepEqual(b[key].map(strip), a[key], `${file}: ${key}`);
        }
        // テンプレート: 名前以外はすべて比べる。名前は、旧版で名前空間の付かない普通のテンプレート（Template:名前）
        // だったものだけ比べる（{{ファイル:x}} {{User:x}} などは新版で名前空間を正規化するため）
        assert.equal(b.templates.length, a.templates.length, `${file}: templates`);
        b.templates.forEach((t, i) => {
            const { name: newName, ...newRest } = strip(t);
            const { name: oldName, ...oldRest } = a.templates[i];
            assert.deepEqual(newRest, oldRest, `${file}: templates[${i}]`);
            if (oldName.split(':').length <= 2) assert.equal(newName, oldName, `${file}: templates[${i}].name`);
        });
        // 旧版は [[:Category:X]] をカテゴリとして扱っていた
        assert.deepEqual(b.categories.map(categoryFields), a.categories.filter(x => !isColonLink(x)).map(categoryFields), `${file}: categories`);
        assert.deepEqual(b.wikilinks.length + b.files.length + b.categories.length,
            a.wikilinks.length + a.files.length + a.categories.length, `${file}: links`);
    }
});
