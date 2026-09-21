/**
 * brand-line-endings-pin.test.js — 「字节哈希路径必须免受行尾转换」这条元断言的 meta 测试
 *
 * 为什么要有它：这条断言的价值全在"判定得准不准"。判松了它抓不到真实缺陷
 * （2026-09-21：web/assets/icon.svg 漏钉 ⇒ 主仓库绿、干净 clone 红），判严了它会变成
 * 拦路石（把二进制资产或已经钉好的路径也报红）。所以这里把判定逻辑逐条钉住，并且
 * **与 git 本体差分**：同一批（模式 → 路径）交给 `git check-attr`，逐条比对生效属性 ——
 * 光靠"我以为覆盖了 git 的匹配语义"不算数。
 *
 * 判据本体在 scripts/brand-eol-pin-lib.js（从 check-brand-assets.js 里拆出来的独立模块）：
 * 那份 CLI 脚本是整仓装配型，测试加载它只会把整份脚本拉进覆盖率分母，测不到判据本身。
 * 模块把 root / mapping / exportDir / io 全部交给调用方注入 ⇒ 这里能逐分支钉住判据。
 *
 * ## 为什么端到端不在这里（实测记录，别再"顺手改回去"）
 * 本文件**不 require** `scripts/check-brand-assets.js`，也**不 spawn** 它：
 *   · 进程内 require ⇒ 整个 CLI 脚本进覆盖率分母（它的整仓装配部分基本不会被任何测试执行）；
 *   · spawn 子进程 ⇒ 实测在 `node --test --experimental-test-coverage` 下**子进程的覆盖会并回父进程**
 *     （跑一次就能看到 check-brand-assets.js / brand-v2-lib.js 出现在覆盖表里：74.86% / 95.35%），
 *     也就是说"改用子进程"并不能让分母干净。
 * 所以：判据在模块里被逐分支测（行覆盖 100%），CLI 的整体结论与退出码交给门禁腿
 * `npm run brand:check`（真跑真退出码），本文件只对真实仓库做两条"事故路径不许退回"的窄断言。
 *
 * 覆盖：规则优先级（后出现优先 / 逐属性覆盖）、无斜杠模式匹配任意层、含斜杠模式相对
 *       .gitattributes 所在目录、`**` 的三种位置、以 `/` 结尾的模式"不命中"这一实测语义、
 *       `?`/`[...]`/`[!...]`/未闭合 `[`/行首空白/前导 `/`/非法 `**`/转义字符、
 *       `-attr`/`!attr`/`attr=value`、`[attr]` 宏（含内置 `binary`）、下层 .gitattributes 覆盖上层、
 *       "失败文案必须含路径 + 判定依据 + 可执行修复"，以及**失败真的走 io.fail**（=退出码通道）。
 * 已知边界（不覆盖，别当已覆盖）：见 scripts/brand-eol-pin-lib.js 里 resolveAttributes 的注释。
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

const guard = require('../scripts/brand-eol-pin-lib.js');

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
  // 下面这些边界形态是"先拿真 git 探、再把 git 的答案钉进差分"的，不是"我以为 git 会这样"：
  //   探针实测（git 2.53）：` text eol=lf` 命中路径 text（git 跳过行首空白后取模式）；
  //   未闭合的 `[`（`weird[.txt`）**不匹配任何路径**（不是当字面量用）。
  ' text eol=lf',
  '\tindented.txt eol=lf',
  'weird[.txt eol=crlf',
  'lit(1).txt eol=lf',
  '/anchor/a.txt eol=lf',
  'b**c.txt eol=lf',
  'q?.txt eol=lf',
  'bare.txt',
  'cls[ab].txt eol=crlf',
  'neg[!ab].txt eol=crlf',
  'a\\ b.txt text eol=lf',
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
  'text',
  'indented.txt',
  'weird[.txt',
  'lit(1).txt',
  'anchor/a.txt',
  'bXYc.txt',
  'b/c.txt',
  'q1.txt',
  'q12.txt',
  'bare.txt',
  'clsa.txt',
  'clsz.txt',
  'negc.txt',
  'nega.txt',
  'a b.txt',
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
  const EXPORT = 'design/brand/v2/export';
  // 与真实 MAPPING 同形状的合成映射：只做文本解析的 color / adaptive-xml **不算**字节哈希，
  // 多条映射共用一个 v2 源时该源只能有一条路径、但来源说明要聚齐。
  const mapping = [
    { prod: 'app/icon.png', v2: 'icon-192.png', kind: 'png-copy', w: 192, h: 192 },
    { prod: 'app/round.png', v2: 'icon-192.png', kind: 'round', w: 192, h: 192 },
    { prod: 'app/colors.xml', kind: 'color', value: '#080D17' },
    { prod: 'app/adaptive.xml', kind: 'adaptive-xml' },
  ];
  try {
    const page = '<!doctype html>\n<script>guard();</script>\n';
    writeBytes(root, 'web/page.html', page);
    const inline = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
    writeBytes(root, 'src/static.js', `"script-src 'self' '${guard.cspHash(inline)}'"\n`);
    writeBytes(root, `${EXPORT}/manifest.json`, JSON.stringify({
      source: 'design/brand/v2/master.svg',
      files: [{ name: 'a.svg' }, { name: 'b.png' }],
    }));
    const paths = guard.collectByteHashedPaths(root, mapping, EXPORT);
    assert.ok(paths.has('design/brand/v2/master.svg'), 'manifest.source 必须在集合里');
    assert.ok(paths.has(`${EXPORT}/a.svg`), 'manifest.files[] 必须在集合里');
    assert.ok(paths.has(`${EXPORT}/b.png`), 'manifest.files[] 必须在集合里');
    assert.ok(paths.has('web/page.html'), 'CSP 白名单命中的页面必须在集合里');
    assert.ok(paths.has('app/round.png'), 'MAPPING 里参与哈希比对的条目必须在集合里');
    assert.ok(!paths.has('app/colors.xml'), 'color 只做文本解析 ⇒ 不能算成字节哈希路径（否则会凭空报红）');
    assert.ok(!paths.has('app/adaptive.xml'), 'adaptive-xml 只做文本解析 ⇒ 同上');
    assert.deepStrictEqual(
      [...paths.get(`${EXPORT}/icon-192.png`)].sort(),
      ['MAPPING · png-copy ← v2 源', 'MAPPING · round ← v2 源'],
      '同一个 v2 源被多条映射消费时，来源说明要聚齐（不是后写覆盖前写）',
    );
    assert.deepStrictEqual([...paths.get('app/round.png')], ['MAPPING · round'], '每条生产路径带自己的来源说明');
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

test('推导：manifest 缺失或坏掉只是"少一类来源"，不影响 MAPPING / CSP 两类，且不抛错', () => {
  const root = makeRoot('manifest-edge');
  const EXPORT = 'design/brand/v2/export';
  const mapping = [{ prod: 'app/icon.png', v2: 'icon-192.png', kind: 'png-copy' }];
  try {
    const noManifest = guard.collectByteHashedPaths(root, mapping, EXPORT);
    assert.deepStrictEqual([...noManifest.keys()].sort(), ['app/icon.png', `${EXPORT}/icon-192.png`]);
    writeBytes(root, `${EXPORT}/manifest.json`, '{ 这不是 JSON');
    const badManifest = guard.collectByteHashedPaths(root, mapping, EXPORT);
    assert.deepStrictEqual([...badManifest.keys()], [...noManifest.keys()], '坏 manifest 与没有 manifest 等价（都不抛错、都不带路径）');
    writeBytes(root, `${EXPORT}/manifest.json`, JSON.stringify({ source: 'design/brand/v2/master.svg' }));
    assert.deepStrictEqual(
      [...guard.collectByteHashedPaths(root, mapping, EXPORT).keys()],
      ['app/icon.png', `${EXPORT}/icon-192.png`, 'design/brand/v2/master.svg'],
      'manifest 只有 source、没有 files 时按空数组处理（不是崩掉、也不是假装有文件）',
    );
  } finally {
    cleanup(root);
  }
});

test('推导：CSP 白名单的四种边界（缺 static.js / 脚本不在白名单 / CRLF 页面按 LF 归一 / web 不是目录）', () => {
  const root = makeRoot('csp-edge');
  try {
    writeBytes(root, 'web/page.html', '<!doctype html>\n<script>guard();</script>\n');
    assert.deepStrictEqual(guard.collectCspPinnedPages(root), [], '① 没有 src/static.js ⇒ 一个页面都不算');
    writeBytes(root, 'src/static.js', `"script-src 'self' '${guard.cspHash('other();')}'"\n`);
    assert.deepStrictEqual(guard.collectCspPinnedPages(root), [], '② 白名单里是别的脚本 ⇒ 页面不算（白名单是唯一判据）');
    writeBytes(root, 'src/static.js', `"script-src 'self' '${guard.cspHash('guard();')}'"\n`);
    assert.deepStrictEqual(guard.collectCspPinnedPages(root), ['web/page.html'], '③ 命中白名单 ⇒ 算');
    writeBytes(root, 'web/page.html', '<!doctype html>\r\n<script>guard();\r\n</script>\r\n');
    writeBytes(root, 'src/static.js', `"script-src 'self' '${guard.cspHash('guard();\n')}'"\n`);
    assert.deepStrictEqual(guard.collectCspPinnedPages(root), ['web/page.html'], '④ 工作区 CRLF 时按 LF 归一后再对白名单（pin 仍成立，只是本地检出脏了）');
  } finally {
    cleanup(root);
  }
});

test('推导：listWebHtml 递归子目录、跳过 node_modules 与非 .html', () => {
  const root = makeRoot('csp-walk');
  try {
    const page = '<!doctype html>\n<script>guard();</script>\n';
    writeBytes(root, 'web/page.html', page);
    writeBytes(root, 'web/a/b/deep.html', page);
    writeBytes(root, 'web/node_modules/pkg/skip.html', page);
    writeBytes(root, 'web/style.css', 'body{}');
    assert.deepStrictEqual(guard.listWebHtml(root), ['web/a/b/deep.html', 'web/page.html']);
    // web 不是目录（readdir 抛错）⇒ 空集合，不把整条门禁带崩
    const root2 = makeRoot('csp-noweb');
    try {
      writeBytes(root2, 'web', TEXT);
      writeBytes(root2, 'src/static.js', `'${guard.cspHash('x();')}'`);
      assert.deepStrictEqual(guard.collectCspPinnedPages(root2), []);
    } finally {
      cleanup(root2);
    }
  } finally {
    cleanup(root);
  }
});

test('真实仓库：2026-09-21 事故的那两条路径至今仍被钉住（完整集合与整体退出码由门禁腿负责）', () => {
  // 只读真实仓库的 .gitattributes + 真实文件字节，**不加载**整份 CLI 脚本（理由见文件头）。
  // 完整路径集合（59 条）与整体退出码由门禁腿 npm run brand:check 负责；这里钉住的是
  // "事故路径本身再也不能退回未钉版状态"，以及"二进制判定没被改坏"。
  const repo = path.join(__dirname, '..');
  const attr = guard.resolveAttributes(repo, 'web/assets/icon.svg');
  assert.equal(guard.attrState(attr.attrs, 'text').value, true, 'web/assets/icon.svg 必须显式 text');
  assert.equal(guard.attrState(attr.attrs, 'eol').value, 'lf', '且必须固定 eol=lf');
  const first = guard.eolPinVerdict(repo, 'web/assets/icon.svg', ['真实仓库回归']);
  assert.equal(first.status, 'pinned', '事故路径 #1 必须 pinned');
  assert.equal(first.binary, false, '它必须仍是文本（二进制判定若被改坏，这条会红）');
  assert.equal(first.cr, 0, '主仓库工作区里它是 LF（若这里出现 CR，说明本机检出被 CRLF 重写过）');
  const second = guard.eolPinVerdict(repo, 'web/assets/brand/wolf-emblem.svg', ['真实仓库回归']);
  assert.equal(second.status, 'pinned', '事故路径 #2 必须 pinned');
});

// ---------------------------------------------------------------- 文案（失败要说清"凭什么"和"怎么修"）

test('文案：二进制内容被误标成 text/eol=crlf 时，文案要按"二进制"描述而不是报字节数', () => {
  const r = judge(['a/x.png'], 'a/x.png text eol=crlf\n', 'a/x.png');
  assert.equal(r.status, 'fail');
  assert.equal(r.binary, true, '内容里有 NUL ⇒ 判定为二进制');
  const msg = guard.eolPinFailMessage(r);
  assert.match(msg, /内容判定：二进制（前 8000 字节内有 NUL）/);
  assert.match(msg, /把这条规则的 eol 改成 lf/);
});

test('文案（防御性分支）：调用方自己构造的行缺 rule 时，落到"来源未知"兜底而不抛错', () => {
  // eolPinFailMessage 是导出给调用方的纯函数，输入契约里 rule 允许缺（模块内部 catch 出来的
  // attr-error 行就没有 rule）。这一条钉的是"兜底不抛错 + 明说来源未知"这个契约本身，
  // 不是在给判据判红/判绿的能力刷覆盖 —— 判据行为由上面那些真夹具用例负责。
  const msg = guard.eolPinFailMessage({
    path: 'a/b.svg', sources: ['合成'], binary: false, bytes: 4, cr: 0,
    how: '查过 .gitattributes：0 行命中该路径 ⇒ text/eol 均未指定', kind: 'eol-crlf', fixTarget: '.gitattributes',
  });
  assert.match(msg, /来源未知/);
  assert.match(msg, /修复：把这条规则的 eol 改成 lf ⇒「a\/b\.svg text eol=lf」/);
});

test('文案：text=auto 与 text 无 eol 各有独立判据与修复（不是一句通用话术）', () => {
  const auto = guard.eolPinFailMessage(judge(['a/x.svg'], 'a/x.svg text=auto\n', 'a/x.svg'));
  assert.match(auto, /text=auto ⇒ 行尾由 core\.autocrlf \/ 内容判定决定/);
  assert.match(auto, /a\/x\.svg text eol=lf/);
  const noEol = guard.eolPinFailMessage(judge(['a/x.svg'], 'a/x.svg text\n', 'a/x.svg'));
  assert.match(noEol, /text 已设但没固定 eol/);
  assert.match(noEol, /追加\/补全「a\/x\.svg text eol=lf」/);
  const unset = guard.eolPinFailMessage(judge(['a/x.txt'], 'a/x.txt -text\n', 'a/x.txt'));
  assert.match(unset, /规则与内容不符/);
});

test('文案：工作区文件已是 CRLF 时要点出"补了规则还要重新检出"，否则修完仍然红', () => {
  const root = makeRoot('crlf-note');
  try {
    writeBytes(root, '.gitattributes', '# 没有这条路径的规则\n');
    writeBytes(root, 'web/assets/icon.svg', 'a\r\nb\r\n'); // 本机检出就是 CRLF（blob 理应是 LF）
    const r = guard.eolPinVerdict(root, 'web/assets/icon.svg', ['合成夹具']);
    assert.equal(r.status, 'fail');
    assert.equal(r.cr, 2);
    const msg = guard.eolPinFailMessage(r);
    assert.match(msg, /已有 2 个 CR/);
    assert.match(msg, /重新检出该文件/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- 渲染（失败必须走 io.fail = 退出码通道）

const EXPORT_DIR = 'design/brand/v2/export';

/** 合成一棵"有字节哈希路径"的仓库：manifest(source + files) + 可选 .gitattributes */
function hashRoot(tag, { rules = '' } = {}) {
  const root = makeRoot(tag);
  writeBytes(root, 'design/brand/v2/m.svg', TEXT);
  writeBytes(root, `${EXPORT_DIR}/a.svg`, TEXT);
  writeBytes(root, `${EXPORT_DIR}/b.png`, BINARY);
  writeBytes(root, `${EXPORT_DIR}/manifest.json`, JSON.stringify({
    source: 'design/brand/v2/m.svg',
    files: [{ name: 'a.svg' }, { name: 'b.png' }],
  }));
  writeBytes(root, '.gitattributes', `design/brand/v2/m.svg text eol=lf\n${rules}`);
  return root;
}

/** 夹具里不存在的两条生产路径 ⇒ 走"跳过行尾判定：文件缺失"（与真实仓库里那几十条同形态） */
const MAPPING_STUB = [{ prod: 'app/not-there.png', v2: 'gone.png', kind: 'png-copy' }];

function render(root, mapping = MAPPING_STUB) {
  const logs = [];
  const passes = [];
  const fails = [];
  const res = guard.checkEolPinning({
    root,
    mapping,
    exportDir: EXPORT_DIR,
    io: { log: (l) => logs.push(l), pass: (l) => passes.push(l), fail: (p, w) => fails.push({ p, w }) },
  });
  return { logs, passes, fails, res };
}

test('渲染：失败走 io.fail（=退出码通道），且不再打印"0 条风险"总结', () => {
  const root = hashRoot('render-red');
  try {
    const { logs, passes, fails, res } = render(root);
    assert.deepStrictEqual(fails.map((f) => f.p), [`${EXPORT_DIR}/a.svg`], '未钉版的文本路径必须走 io.fail');
    assert.match(fails[0].w, /text eol=lf/, '失败文案必须带可执行修复');
    assert.deepStrictEqual(res.failed.map((r) => r.path), [`${EXPORT_DIR}/a.svg`], '返回值也要带失败清单');
    assert.equal(res.rows.length, 5, '逐条判定结果要全部返回（manifest: source + a.svg + b.png；MAPPING: 生产路径 + 它的 v2 源）');
    assert.ok(passes.some((l) => /design\/brand\/v2\/m\.svg · 文本 · text eol=lf（\.gitattributes:1）/.test(l)), '钉好的路径要有通过行（含规则出处）');
    assert.ok(passes.some((l) => /二进制内容 1 条/.test(l)), '二进制路径要有汇总行');
    assert.ok(logs.some((l) => /跳过行尾判定：文件不存在/.test(l)), '夹具里不存在的路径只能是"跳过"（不是红）');
    assert.ok(logs.some((l) => /按来源去重：.*MAPPING/.test(l)), '来源统计行要能看到 MAPPING 这一类');
    assert.ok(!passes.some((l) => /0 条存在行尾转换风险/.test(l)), '有失败时不许再打印"0 条风险"，否则读起来是绿的');
  } finally {
    cleanup(root);
  }
});

test('渲染：全绿时给出总结行（把"跳过"也算清楚），并打印已知边界', () => {
  const root = hashRoot('render-green', { rules: `${EXPORT_DIR}/a.svg text eol=lf\n` });
  try {
    const { logs, passes, fails } = render(root);
    assert.deepStrictEqual(fails, [], '两条文本都钉好了 ⇒ 不许有失败');
    assert.ok(
      passes.some((l) => /直接钉版 2 条、二进制内容 1 条、跳过（文件缺失）2 条 —— 0 条存在行尾转换风险/.test(l)),
      '总结行要把"跳过（文件缺失）"写清楚，不能让人以为那两条也验过了',
    );
    assert.ok(logs.some((l) => /已知边界（别当成已覆盖）/.test(l)), '已知边界必须打印出来');
  } finally {
    cleanup(root);
  }
});

test('渲染：属性判定抛错（宏自引用）收敛成 attr-error 失败，不让整条门禁崩掉', () => {
  const root = hashRoot('render-error');
  try {
    writeBytes(root, '.gitattributes', '[attr]loop loop text eol=lf\n*.svg loop\n');
    const { fails, res } = render(root);
    const attrFails = fails.filter((f) => /行尾钉版判定失败/.test(f.w));
    assert.deepStrictEqual(
      attrFails.map((f) => f.p),
      [`${EXPORT_DIR}/a.svg`, 'design/brand/v2/m.svg'],
      '命中了 `*.svg loop` 的两条路径都要被收敛成失败（b.png 不命中该规则 ⇒ 仍是"二进制、无需规则"）',
    );
    assert.match(attrFails[0].w, /宏递归过深/);
    assert.equal(res.failed.length, 2, '有失败时不许再打印"0 条风险"：失败清单就是调用方判红的依据');
    assert.ok(res.rows.some((r) => r.path === `${EXPORT_DIR}/b.png` && r.status === 'binary'), '没命中坏规则的路径不受影响');
  } finally {
    cleanup(root);
  }
});

test('渲染：缺少 io.pass / io.fail 时直接抛错（失败绝不允许在这里被吞掉）', () => {
  assert.throws(() => guard.checkEolPinning({ root: '.', mapping: [], exportDir: 'x' }), /io\.pass \/ io\.fail/);
  assert.throws(() => guard.checkEolPinning({ root: '.', mapping: [], exportDir: 'x', io: { pass: () => {} } }), /io\.pass \/ io\.fail/);
});

test('渲染：忘了注入 mapping / exportDir 时直接抛错（否则"0 条路径"会伪装成全绿）', () => {
  const io = { pass: () => {}, fail: () => {} };
  assert.throws(() => guard.checkEolPinning(), /mapping（数组）/, '连 opts 都不传也要炸');
  assert.throws(() => guard.checkEolPinning({ root: '.', exportDir: 'design/brand/v2/export', io }), /mapping（数组）/);
  assert.throws(() => guard.checkEolPinning({ root: '.', mapping: [], io }), /exportDir/);
  assert.throws(() => guard.checkEolPinning({ root: '.', mapping: [], exportDir: '', io }), /exportDir/);
});

test('渲染：没给 io.log 时落到默认 console.log（输出不许被静默吞掉）', () => {
  const root = hashRoot('render-default-log', { rules: `${EXPORT_DIR}/a.svg text eol=lf\n` });
  const real = console.log;
  const seen = [];
  try {
    console.log = (line) => seen.push(String(line));
    guard.checkEolPinning({ root, mapping: MAPPING_STUB, exportDir: EXPORT_DIR, io: { pass: () => {}, fail: () => {} } });
  } finally {
    console.log = real;
    cleanup(root);
  }
  assert.ok(seen.some((l) => /字节哈希路径 \d+ 条/.test(l)), '统计行要默认输出');
  assert.ok(seen.some((l) => /已知边界（别当成已覆盖）/.test(l)), '已知边界要默认输出（否则没人知道边界在哪）');
});

test('渲染：显式标了 -text/binary 的二进制路径也要有明细通过行（区分"明确不转换"与"忘了钉"）', () => {
  const root = hashRoot('render-binary-pin', { rules: `${EXPORT_DIR}/a.svg text eol=lf\n${EXPORT_DIR}/b.png -text\n` });
  try {
    const { passes, res } = render(root);
    assert.deepStrictEqual(res.failed, [], '文本钉住 + 二进制显式不转换 ⇒ 全绿');
    assert.ok(
      passes.some((l) => new RegExp(`${EXPORT_DIR}/b\\.png · 二进制 · -text/binary（内容确为二进制）（\\.gitattributes:3）`).test(l)),
      '显式 pin 的二进制要有明细行（能看出是第几行规则钉的）',
    );
    assert.ok(!passes.some((l) => /无需 \.gitattributes 规则/.test(l)), '显式钉版的二进制不再落进"无需规则"的汇总里');
  } finally {
    cleanup(root);
  }
});

test('渲染：钉住了但本机检出是 CRLF 时，通过行要提示"重新检出"；没有缺失路径时总结行不提"跳过"', () => {
  const root = makeRoot('render-dirty');
  try {
    writeBytes(root, '.gitattributes', 'web/assets/icon.svg text eol=lf\n');
    writeBytes(root, 'web/assets/icon.svg', 'a\r\nb\r\n'); // pin 在，但本机检出是 CRLF（注入/旧检出后的真实形态）
    const v = guard.eolPinVerdict(root, 'web/assets/icon.svg', ['合成夹具']);
    assert.equal(v.status, 'pinned', 'pin 成立就是通过 —— 判据看属性，不看本机行尾恰好对不对');
    assert.equal(v.cr, 2);
    const passes = [];
    const res = guard.checkEolPinning({
      root,
      mapping: [{ prod: 'web/assets/icon.svg', kind: 'svg-copy' }], // 夹具里存在 ⇒ 全部路径都不缺
      exportDir: EXPORT_DIR,
      io: { pass: (l) => passes.push(l), fail: () => {}, log: () => {} },
    });
    assert.deepStrictEqual(res.failed, []);
    assert.ok(
      passes.some((l) => /web\/assets\/icon\.svg · 文本 · text eol=lf（\.gitattributes:1），但当前工作区有 2 个 CR（检出早于钉版：git checkout -- web\/assets\/icon\.svg 即可）/.test(l)),
      '通过行必须告诉用户"怎么把本机检出弄回 LF"，否则他只看到一个绿勾不知道哪里不对',
    );
    const summary = passes.find((l) => /0 条存在行尾转换风险/.test(l));
    assert.ok(summary, '没有失败 ⇒ 必须有总结行');
    assert.doesNotMatch(summary, /跳过/, '一条缺失路径都没有时，总结行不许提"跳过（文件缺失）"');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- 解析与分组

test('解析：行首空白的规则 git 仍然认（跳过空白取模式）—— 别把带缩进的规则当成不存在', () => {
  // 实测 git 2.53：`  text eol=lf` 的属性落在路径 `text` 上（git 跳过行首空白）。
  assert.equal(judge(['a/x.svg'], '   a/x.svg text eol=lf\n', 'a/x.svg').status, 'pinned', '空格缩进');
  assert.equal(judge(['a/x.svg'], '\ta/x.svg text eol=lf\n', 'a/x.svg').status, 'pinned', '制表符缩进');
});

test('解析：空行 / 注释 / 只有模式没有属性 / 模式里的反斜杠，四种行都按 git 的语义处理', () => {
  assert.equal(guard.parseGitAttributesLine(''), null);
  assert.equal(guard.parseGitAttributesLine('   '), null);
  assert.equal(guard.parseGitAttributesLine('# 注释'), null);
  assert.equal(guard.parseGitAttributesLine('   # 缩进注释'), null, '缩进的注释也是注释');
  assert.deepStrictEqual(guard.parseGitAttributesLine('bare.txt'), { pattern: 'bare.txt', attrs: [] }, '只有模式 ⇒ 命中但不设任何属性');
  assert.deepStrictEqual(
    guard.parseGitAttributesLine('a\\ b.txt text eol=lf'),
    { pattern: 'a\\', attrs: [{ name: 'b.txt', state: 'set' }, { name: 'text', state: 'set' }, { name: 'eol', state: 'value', value: 'lf' }] },
    '反斜杠**不**转义空白（git 也这样：模式是 `a\\`，b.txt 成了属性名）—— 差分用例钉住了同一事实',
  );
  assert.equal(guard.parseMacroDefinition('*.txt text eol=lf'), null, '不是 [attr] 开头的行不是宏定义');
  assert.deepStrictEqual(guard.parseMacroDefinition('[attr]pinned text eol=lf'), { name: 'pinned', body: 'text eol=lf' });
});

test('分组：二进制路径按目录成组（根目录文件单列、超过上限折叠为"共 N 个"）', () => {
  const lines = guard.groupPathsByDir(['icon.svg', 'web/a/x.png', 'web/a/y.png', 'web/b/z.png']);
  assert.deepStrictEqual(lines, [
    '      ./ ⇒ icon.svg（共 1 个）',
    '      web/a/ ⇒ x.png, y.png（共 2 个）',
    '      web/b/ ⇒ z.png（共 1 个）',
  ]);
  const folded = guard.groupPathsByDir(Array.from({ length: 9 }, (_, i) => `d/f${i}.png`));
  assert.deepStrictEqual(folded, ['      d/ ⇒ f0.png, f1.png, f2.png, f3.png, f4.png, f5.png，…共 9 个']);
});
