/**
 * brand-line-endings-pin-test.js — 「字节哈希路径必须免受行尾转换」这条元断言的 meta 测试
 *
 * 为什么要有它：这条断言的价值全在"判定得准不准"。判松了它抓不到真实缺陷
 * （2026-09-21：web/assets/icon.svg 漏钉 ⇒ 主仓库绿、干净 clone 红），判严了它会变成
 * 拦路石（把二进制资产或已经钉好的路径也报红）。所以这里把判定逻辑逐条钉住，并且
 * **与 git 本体差分**：同一批（模式 → 路径）交给 `git check-attr`，逐条比对生效属性 ——
 * 光靠"我以为覆盖了 git 的匹配语义"不算数。
 *
 * 覆盖：规则优先级（后出现优先 / 逐属性覆盖）、无斜杠模式匹配任意层、含斜杠模式相对
 *       .gitattributes 所在目录、`**` 的三种位置、以 `/` 结尾的模式"不命中"这一实测语义、
 *       `-attr`/`!attr`/`attr=value`、`[attr]` 宏（含内置 `binary`）、下层 .gitattributes 覆盖上层、
 *       以及"失败文案必须含路径 + 判定依据 + 可执行修复"。
 * 已知边界（不覆盖，别当已覆盖）：见 scripts/check-brand-assets.js 里 resolveAttributes 的注释。
 *
 * 夹具全部用 node 的**字节**读写（不经过 PowerShell 文本往返），避免中文/行尾被悄悄改掉。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = require('../scripts/check-brand-assets.js');

const TEXT = '第一行\nsecond line\n';
/** 含 NUL 的字节序列：二进制判定的最小夹具（PNG 签名 + NUL） */
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01, 0xff, 0x0a]);

function makeRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ww-eolpin-${tag}-`));
}

/** 写文件（字节）；文本用 Buffer.from(utf8) 显式编码，绝不依赖平台默认 */
function writeBytes(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
  return abs;
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

/** 合成一个仓库跑判定：files = 要落盘的文件（'.png'/'.bin' 结尾的写成二进制），rules = .gitattributes 内容 */
function judge(files, rules, target) {
  const root = makeRoot('case');
  try {
    if (rules !== null) writeBytes(root, '.gitattributes', rules);
    for (const rel of files) writeBytes(root, rel, /\.(?:png|bin|ico)$/.test(rel) ? BINARY : TEXT);
    return guard.eolPinVerdict(root, target, ['合成夹具']);
  } finally {
    cleanup(root);
  }
}

// ---------------------------------------------------------------- 判定：文本路径

test('钉版：文本路径 + `text eol=lf` ⇒ pinned（并报出是哪一行的规则）', () => {
  const r = judge(['web/assets/icon.svg'], 'web/assets/icon.svg text eol=lf\n', 'web/assets/icon.svg');
  assert.equal(r.status, 'pinned');
  assert.equal(r.via, 'text eol=lf');
  assert.equal(r.binary, false);
  assert.equal(r.rule.line, 1, '判定依据要指到具体行');
});

test('钉版：文本路径 + 没有任何规则 ⇒ fail（这正是 2026-09-21 的真实缺陷形态）', () => {
  const r = judge(['web/assets/icon.svg'], '# 只有注释\n', 'web/assets/icon.svg');
  assert.equal(r.status, 'fail');
  assert.equal(r.kind, 'uncovered-text');
  assert.match(r.how, /0 行命中该路径/);
  const msg = guard.eolPinFailMessage(r);
  assert.match(msg, /web\/assets\/icon\.svg/, '必须指名缺规则的路径');
  assert.match(msg, /0 行命中该路径/, '必须给出判定依据');
  assert.match(msg, /web\/assets\/icon\.svg text eol=lf/, '必须给出一句可执行的修复');
});

test('钉版：`eol=lf` 单独出现也算钉住（git 文档：设置 eol 即隐含 text）', () => {
  const r = judge(['a/x.svg'], 'a/x.svg eol=lf\n', 'a/x.svg');
  assert.equal(r.status, 'pinned');
});

test('钉版：text 无 eol / text=auto / eol=crlf 三种形态都要红（各有独立判据）', () => {
  const noEol = judge(['a/x.svg'], 'a/x.svg text\n', 'a/x.svg');
  assert.equal(noEol.status, 'fail');
  assert.equal(noEol.kind, 'text-no-eol');
  const auto = judge(['a/x.svg'], 'a/x.svg text=auto\n', 'a/x.svg');
  assert.equal(auto.status, 'fail');
  assert.equal(auto.kind, 'text-auto');
  const crlf = judge(['a/x.svg'], 'a/x.svg text eol=crlf\n', 'a/x.svg');
  assert.equal(crlf.status, 'fail');
  assert.equal(crlf.kind, 'eol-crlf');
  assert.match(guard.eolPinFailMessage(crlf), /把这条规则的 eol 改成 lf/);
});

// ---------------------------------------------------------------- 判定：二进制路径

test('钉版：二进制内容 + 没有任何规则 ⇒ binary（放行，但在通过行里列名，不做静默假设）', () => {
  const r = judge(['web/assets/icon-192.png'], null, 'web/assets/icon-192.png');
  assert.equal(r.status, 'binary');
  assert.equal(r.binary, true);
});

test('钉版：`binary` 内置宏 / `-text` + 二进制内容 ⇒ pinned；`-text` 用在文本上 ⇒ fail', () => {
  const viaMacro = judge(['a/x.bin'], 'a/x.bin binary\n', 'a/x.bin');
  assert.equal(viaMacro.status, 'pinned');
  assert.match(viaMacro.via, /-text\/binary/);
  const viaUnset = judge(['a/x.bin'], 'a/x.bin -text\n', 'a/x.bin');
  assert.equal(viaUnset.status, 'pinned');
  const wrongKind = judge(['a/x.txt'], 'a/x.txt -text\n', 'a/x.txt');
  assert.equal(wrongKind.status, 'fail');
  assert.equal(wrongKind.kind, 'unset-on-text');
  assert.match(guard.eolPinFailMessage(wrongKind), /内容\*\*不是\*\*二进制/);
});

test('钉版：会改写字节的属性（filter / ident / working-tree-encoding）同样要红', () => {
  for (const attr of ['filter=lfs', 'ident', 'working-tree-encoding=UTF-16LE']) {
    const r = judge(['a/x.svg'], `a/x.svg text eol=lf ${attr}\n`, 'a/x.svg');
    assert.equal(r.status, 'fail', `${attr} 会改写字节，必须红`);
    assert.equal(r.kind, 'byte-rewriting');
    assert.match(guard.eolPinFailMessage(r), /text eol=lf/);
  }
});

// ---------------------------------------------------------------- 匹配语义（git 的规则）

test('匹配：同一文件里**后出现的规则优先**，且是逐属性覆盖', () => {
  const pinned = judge(['a/x.svg'], '*.svg text eol=crlf\na/x.svg text eol=lf\n', 'a/x.svg');
  assert.equal(pinned.status, 'pinned', '后一行的 eol=lf 必须覆盖前一行的 crlf');
  const broken = judge(['a/x.svg'], 'a/x.svg text eol=lf\n*.svg text eol=crlf\n', 'a/x.svg');
  assert.equal(broken.status, 'fail', '反过来写就该红（后出现的 crlf 生效）');
});

test('匹配：不含斜杠的模式匹配任意层的**文件名**；含斜杠的模式相对 .gitattributes 所在目录', () => {
  const deep = judge(['a/b/c/x.svg'], '*.svg text eol=lf\n', 'a/b/c/x.svg');
  assert.equal(deep.status, 'pinned');
  // `a/*.svg` 不跨目录：a/b/c/x.svg 不该命中
  const notMatched = judge(['a/b/c/x.svg'], 'a/*.svg text eol=lf\n', 'a/b/c/x.svg');
  assert.equal(notMatched.status, 'fail');
});

test('匹配：`**` 的三种位置（前缀 / 中间 / 目录后缀）都要命中', () => {
  assert.equal(judge(['x/deep.txt'], '**/deep.txt text eol=lf\n', 'x/deep.txt').status, 'pinned', '**/ 前缀');
  assert.equal(judge(['a/b/deep.txt'], 'a/**/deep.txt text eol=lf\n', 'a/b/deep.txt').status, 'pinned', '中间夹层');
  assert.equal(judge(['icons/deep/x.png'], 'icons/** text eol=lf\n', 'icons/deep/x.png').status, 'pinned', '目录后缀');
});

test('匹配：以 `/` 结尾的模式在 gitattributes 里**不命中任何路径** ⇒ 不能当覆盖（实测 git check-attr）', () => {
  // 这一条是拿真 git 探出来的（见本文件末尾的差分用例）：.gitignore 的"目录规则"语义
  // **不适用于** .gitattributes —— `plain/ text=auto` 查 plain/one.txt 得到 text: unspecified。
  // 判定必须跟随 git 判"没覆盖"，否则就是把没覆盖的当覆盖。
  const under = judge(['plain/one.txt'], 'plain/ text eol=lf\n', 'plain/one.txt');
  assert.equal(under.status, 'fail');
  assert.equal(under.kind, 'uncovered-text');
  const sameName = judge(['plain.txt'], 'plain/ text eol=lf\n', 'plain.txt');
  assert.equal(sameName.status, 'fail');
});

test('匹配：`.gitattributes` 自己就是 CRLF（干净 Windows 检出实测如此，它本身没被钉版）也要解析正确', () => {
  // 实测：全新 worktree 里 .gitattributes 是 2579 字节 / 31 个 CR —— 它自己是文本且没有钉版规则。
  // 判定实现必须容忍 CRLF 的属性文件，否则干净检出上的结论会跟主仓库不一致。
  const crlf = ['# 注释行', '[attr]pinned text eol=lf', '*.svg text eol=lf', '*.pinned pinned', 'plain.txt text eol=crlf', ''].join('\r\n');
  assert.equal(judge(['a/x.svg'], crlf, 'a/x.svg').status, 'pinned', 'CRLF 属性文件里的普通规则');
  assert.equal(judge(['a/x.pinned'], crlf, 'a/x.pinned').status, 'pinned', 'CRLF 属性文件里的 [attr] 宏');
  const bad = judge(['plain.txt'], crlf, 'plain.txt');
  assert.equal(bad.status, 'fail');
  assert.equal(bad.kind, 'eol-crlf', 'CRLF 属性文件里的 eol=crlf 仍然要判红');
});

test('匹配：下层的 .gitattributes 覆盖上层', () => {
  const root = makeRoot('nested');
  try {
    writeBytes(root, '.gitattributes', '*.txt text eol=lf\n');
    writeBytes(root, 'sub/.gitattributes', 'one.txt -text\n');
    writeBytes(root, 'sub/one.txt', BINARY); // 内容二进制 + -text ⇒ 合法
    writeBytes(root, 'sub/two.txt', TEXT);
    assert.equal(guard.eolPinVerdict(root, 'sub/one.txt', ['x']).status, 'pinned', '下层规则覆盖上层');
    assert.equal(guard.eolPinVerdict(root, 'sub/two.txt', ['x']).status, 'pinned', '下层没提到的路径仍用上层规则');
  } finally {
    cleanup(root);
  }
});

test('匹配：`!text` 置回未指定（逐属性），剩下的 eol=lf 仍然生效', () => {
  const r = judge(['a/x.keep'], '*.keep !text\n*.keep eol=lf\n', 'a/x.keep');
  assert.equal(r.status, 'pinned', '!text 只清掉 text；eol=lf 还在 ⇒ git 仍按 LF 检出');
});

test('匹配：`[attr]` 宏会展开；但**用在定义之前**的宏 git 不会展开 ⇒ 点名为失败', () => {
  const ok = judge(['a/x.pinned'], '[attr]pinned text eol=lf\n*.pinned pinned\n', 'a/x.pinned');
  assert.equal(ok.status, 'pinned', '[attr] 宏必须被展开');
  const late = judge(['a/x.pinned'], '*.pinned pinned\n[attr]pinned text eol=lf\n', 'a/x.pinned');
  assert.equal(late.status, 'fail');
  assert.equal(late.kind, 'late-macro');
  assert.match(guard.eolPinFailMessage(late), /移到使用它的那行\*\*之前\*\*/);
});

test('匹配：宏自引用（递归）直接抛错，不静默放过', () => {
  const root = makeRoot('recursion');
  try {
    writeBytes(root, '.gitattributes', '[attr]loop loop text eol=lf\n*.svg loop\n');
    writeBytes(root, 'a.svg', TEXT);
    assert.throws(() => guard.resolveAttributes(root, 'a.svg'), /宏递归过深/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- 与 git 本体差分

const DIFF_RULES = [
  '*.svg text eol=lf',
  'web/**/*.svg -text',
  'web/assets/icon.svg text eol=lf',
  'docs/*.md eol=crlf',
  '**/deep.txt text eol=lf',
  'icons/** eol=lf',
  'sub/*.bin binary',
  'plain/ text=auto',
  'plain2/one.txt text',
  '[attr]pinned text eol=lf',
  '*.pinned pinned',
  '*.keep !text',
  '*.keep eol=lf',
  'a/*.svg text eol=crlf',
].join('\n') + '\n';

const DIFF_PATHS = [
  'web/assets/icon.svg',
  'web/deep/other.svg',
  'docs/readme.md',
  'docs/sub/readme.md',
  'x/deep.txt',
  'deep.txt',
  'icons/foo.png',
  'icons/deep/bar.png',
  'sub/a.bin',
  'sub/a.txt',
  'plain/one.txt',
  'plain2/one.txt',
  'x/plain2/one.txt',
  'foo.pinned',
  'foo.keep',
  'a/x.svg',
  'a/b/x.svg',
  'plain.txt',
  'icons/keep.txt',
];

const hasGit = () => !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;

/** git 本体对这批路径的 (text, eol) 生效状态 */
function gitAttrStates(root, rels) {
  const res = spawnSync('git', ['check-attr', 'text', 'eol', '--', ...rels], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, `git check-attr 失败：${res.stderr}`);
  const map = new Map();
  for (const raw of res.stdout.split('\n')) {
    if (!raw.trim()) continue;
    const m = /^(.*?): (text|eol): (.*)$/.exec(raw.replace(/\\/g, '/'));
    assert.ok(m, `看不懂 git check-attr 的输出行：${raw}`);
    if (!map.has(m[1])) map.set(m[1], {});
    map.get(m[1])[m[2]] = m[3];
  }
  return map;
}

/** 本断言的判定实现给出的 (text, eol) 生效状态（原样三态，不做 eol⇒text 的隐含推导） */
function guardAttrStates(root, rel) {
  const { attrs } = guard.resolveAttributes(root, rel);
  const norm = (name) => {
    const st = guard.attrState(attrs, name);
    if (!st.known) return 'unspecified';
    if (st.value === true) return 'set';
    if (st.value === false) return 'unset';
    return String(st.value);
  };
  return { text: norm('text'), eol: norm('eol') };
}

test('差分：本断言的匹配语义与 git check-attr 逐条一致（防"我以为覆盖了"）', (t) => {
  if (!hasGit()) return t.skip('没有 git，跳过差分');
  const root = makeRoot('diff');
  try {
    // 夹具仓库：.gitattributes（含嵌套一份）+ 所有待查路径都真实落盘
    writeBytes(root, '.gitattributes', DIFF_RULES);
    writeBytes(root, 'sub/.gitattributes', 'one.txt -text\na.txt text eol=lf\n');
    for (const rel of DIFF_PATHS) writeBytes(root, rel, rel.endsWith('.bin') ? BINARY : TEXT);
    assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);

    const theirs = gitAttrStates(root, DIFF_PATHS);
    const diffs = [];
    for (const rel of DIFF_PATHS) {
      const mine = guardAttrStates(root, rel);
      const git = theirs.get(rel);
      assert.ok(git, `git check-attr 没给出 ${rel} 的结果`);
      if (mine.text !== git.text || mine.eol !== git.eol) {
        diffs.push(`${rel}：本断言 text=${mine.text} eol=${mine.eol} ≠ git text=${git.text} eol=${git.eol}`);
      }
    }
    assert.deepStrictEqual(diffs, [], `匹配语义与 git 不一致（差异 → 修判定实现，别改这里的期望值）：\n  ${diffs.join('\n  ')}`);
    // 差分本身要有意义：至少要有 case 真的命中过规则（否则"全 unspecified 也一致"是假绿）
    assert.ok([...theirs.values()].filter((v) => v.text === 'set' || v.eol === 'lf').length >= 6, '夹具必须覆盖到真命中的规则');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- 路径集合的推导

test('推导：字节哈希路径集合来自实际数据（manifest / 导出资产 / CSP 白名单页面），不是写死的清单', () => {
  const root = makeRoot('derive');
  try {
    const page = '<!doctype html>\n<script>guard();</script>\n';
    writeBytes(root, 'web/page.html', page);
    const inline = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
    writeBytes(root, 'src/static.js', `"script-src 'self' '${guard.cspHash(inline)}'"\n`);
    writeBytes(root, 'design/brand/v2/export/manifest.json', JSON.stringify({
      source: 'design/brand/v2/master.svg',
      files: [{ name: 'a.svg' }, { name: 'b.png' }],
    }));
    const paths = guard.collectByteHashedPaths(root);
    assert.ok(paths.has('design/brand/v2/master.svg'), 'manifest.source 必须在集合里');
    assert.ok(paths.has('design/brand/v2/export/a.svg'), 'manifest.files[] 必须在集合里');
    assert.ok(paths.has('design/brand/v2/export/b.png'), 'manifest.files[] 必须在集合里');
    assert.ok(paths.has('web/page.html'), 'CSP 白名单命中的页面必须在集合里');
    const families = new Set([...paths.values()].flatMap((s) => [...s]).map((s) => s.split(' · ')[0]));
    assert.deepStrictEqual(
      [...families].sort(),
      ['MAPPING', 'src/static.js CSP 白名单', '品牌 manifest'],
      '集合必须由这三类来源推导（少了哪类，就说明推导退化成写死清单了）',
    );
  } finally {
    cleanup(root);
  }
});

test('推导：真实仓库里，6 条文本型字节哈希路径全部被 .gitattributes 钉住（本次事故的回归断言）', () => {
  const root = path.join(__dirname, '..');
  const rows = [...guard.collectByteHashedPaths(root)].map(([rel, sources]) => guard.eolPinVerdict(root, rel, sources));
  const texts = rows.filter((r) => r.status !== 'missing' && !r.binary);
  assert.ok(texts.length >= 4, `文本型字节哈希路径至少 4 条，实际 ${texts.length}`);
  const unpinned = texts.filter((r) => r.status !== 'pinned').map((r) => r.path);
  assert.deepStrictEqual(unpinned, [], `这些文本路径会被 CRLF 检出改掉字节，必须在 .gitattributes 里钉 text eol=lf：\n  ${unpinned.join('\n  ')}`);
  assert.ok(texts.some((r) => r.path === 'web/assets/icon.svg'), '2026-09-21 事故的那条路径必须在覆盖范围内');
});
