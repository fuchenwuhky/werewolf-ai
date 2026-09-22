/**
 * guards.test.js — 「防忘记守卫」自身的 meta 测试（FIX-20 腿 3）
 *
 * 守卫必须**可被验证**：如果它抓不到违规、或者钩子里根本没接上「改 web/ 跑全量」，
 * 那它就只是一份看起来很安心的文档。这里逐条证明：
 *   ① 断言卫生扫描真会红：假测试文件里的恒真断言必须让守卫非零退出，干净的必须通过；
 *   ② 豁免（GUARD-ALLOW）必须写理由才生效，且只对**代码**生效（字符串/注释里的不算）；
 *   ③ 基线语义：基线内历史违规不阻断，基线外**新增**违规才失败；
 *   ④ 钩子模板里确实有「跑守卫」和「涉及 web/ 时跑全量」两步（读落盘文件内容断言，不靠自证）；
 *   ⑤ 安装器幂等，且**绝不覆盖**别人的 pre-push；
 *   ⑥ 基线文件格式合法、指纹可复算、条目不指向幽灵文件；
 *   ⑦ pin 清单与"pin 用例签名"一致（新增 pin 用例忘了登记 → 这里红）；
 *   ⑧ **行尾免疫**：CRLF 工作区按仓库（LF）字节复核 pin，不许假红（否则钩子会拦住每一次推送）；
 *      并且"已知假红降级"只在那两条行尾敏感的 pin 用例失败时才允许 —— 其它失败绝不放行。
 *   ⑨ **断言绑定识别**（FIX-20 漏检洞）：别名（`const a = require('node:assert'); a.ok(true)`）、
 *      解构（`const { ok } = require('node:assert'); ok(true)`）、链式（`require('assert').ok(true)`）
 *      三种写法下 6 条规则都要生效（逐条复核）；同时**不许**退化成"任何 `xx.ok()` 都算断言"，
 *      并把手里的"已知边界"（不识别 / 会多报的形态）显式钉住。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const guards = require('../scripts/check-guards.js');
const installer = require('../scripts/install-hooks.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-guards.js');
const INSTALLER = path.join(ROOT, 'scripts', 'install-hooks.js');
const BASELINE = path.join(ROOT, 'scripts', 'guards-baseline.json');

const toPosix = (p) => p.split(path.sep).join('/');

/** 临时根：自带 test/ 与 scripts/（脚本的基线默认就找 <root>/scripts/guards-baseline.json） */
function makeRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ww-guard-${tag}-`));
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const writeFixture = (root, name, body) => {
  const file = path.join(root, 'test', name);
  fs.writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return file;
};
const runCli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

/**
 * 夹具里的"豁免指令"就是普通注释文本：扫描器只在**注释**里认指令（字符串/正则先被清空），
 * 所以把 `assert.ok(true);` 这种反例写在本文件的字符串里不会误伤自己。
 */
const ALLOW_DIRECTIVE = '// GUARD-ALLOW: 该端点在两种状态下返回 0 是真实语义';
const BARE_DIRECTIVE = '// GUARD-ALLOW';

const hasGit = () => !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// ---------------------------------------------------------------- ① 真的会红 / 真的会绿

test('守卫：假测试文件里的 assert.ok(true) 必须让守卫失败（否则它就是个摆设）', () => {
  const root = makeRoot('bad');
  try {
    writeFixture(root, 'fake.test.js', [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      '',
      "test('假的用例', () => {",
      '  const x = 1;',
      '  assert.ok(true);',
      '});',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.strictEqual(scan.violations.length, 1, '应恰好抓到 1 处恒真断言');
    assert.strictEqual(scan.violations[0].rule, 'ok-literal-truthy');
    assert.strictEqual(scan.violations[0].file, 'test/fake.test.js');
    assert.strictEqual(scan.violations[0].line, 7, '行号要准（报警要能点到位）');

    const res = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(res.status, 1, `守卫必须非零退出，实际 ${res.status}\n${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /ok-literal-truthy/);
    assert.match(res.stderr, /test\/fake\.test\.js:7/);
  } finally {
    cleanup(root);
  }
});

test('守卫：干净的测试文件必须通过（守卫不能变成拦路石）', () => {
  const root = makeRoot('clean');
  try {
    writeFixture(root, 'good.test.js', [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      '',
      "test('正常的用例', () => {",
      '  const rows = [1, 2, 3];',
      '  assert.strictEqual(rows.length, 3);',
      '  assert.ok(rows.length >= 1, "非空");',
      '  assert.strictEqual(rows.indexOf(2), 1);',
      '  assert.ok(rows.indexOf(9) >= 0, "找不到才是 -1");',
      '});',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations, [], `不该误报：${JSON.stringify(scan.violations)}`);
    assert.strictEqual(scan.bareTags.length, 0);
    const res = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /守卫通过/);
  } finally {
    cleanup(root);
  }
});

test('守卫：只认代码 —— 字符串/注释里的 assert.ok(true) 不算违规', () => {
  const root = makeRoot('strings');
  try {
    writeFixture(root, 'literal.test.js', [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      '// 反例说明：有人写过 assert.ok(true); 这种恒真断言',
      'const doc = "assert.ok(true);";',
      'const rx = /assert\\.ok\\(true\\)/;',
      '',
      "test('正常', () => {",
      '  assert.strictEqual(doc.length, 16);',
      '  assert.match(doc, rx);',
      '});',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations, [], '字符串/注释里的写法不该被误报');
    assert.strictEqual(runCli(['--root', root, '--assertions-only']).status, 0);
  } finally {
    cleanup(root);
  }
});

test('守卫：多种恒真/宽容写法都要抓到（字面真值、>= 0、状态码并集、恒真兜底）', () => {
  const root = makeRoot('kinds');
  try {
    writeFixture(root, 'kinds.test.js', [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      '',
      "test('各种松断言', async () => {",
      '  const res = { status: 404 };',
      '  const rows = [];',
      '  assert.ok(true);',
      '  assert.ok(rows.length >= 0);',
      '  assert.strictEqual(res.status, 404 || 500);',
      '  assert.ok(res.status === 404 || res.status === 500);',
      '  assert.ok(rows.length !== undefined || true);',
      '});',
    ].join('\n'));

    const rules = guards.scanAssertionHygiene(root).violations.map((v) => v.rule).sort();
    assert.deepStrictEqual(rules, [
      'always-true-compare',
      'equals-alternative-literal',
      'ok-literal-truthy',
      'ok-status-disjunction',
      'ok-truthy-fallback',
    ]);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- ② 豁免必须写理由

test('守卫：GUARD-ALLOW 必须写明理由才豁免，且豁免会被打印出来（看得见的债务）', () => {
  const root = makeRoot('allow');
  try {
    writeFixture(root, 'allowed.test.js', [
      "'use strict';",
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      '',
      ALLOW_DIRECTIVE,
      'assert.ok(true);',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations, [], '写了理由的豁免不该再报违规');
    assert.strictEqual(scan.allowed.length, 1);
    assert.match(scan.allowed[0].reason, /真实语义/);

    const res = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /豁免 1 条/);
    assert.match(res.stdout, /理由：该端点在两种状态下返回 0 是真实语义/);
  } finally {
    cleanup(root);
  }
});

test('守卫：只有标记、没写理由的 GUARD-ALLOW 不生效（按违规处理并点名）', () => {
  const root = makeRoot('bare');
  try {
    writeFixture(root, 'bare.test.js', [
      "'use strict';",
      "const assert = require('node:assert');",
      BARE_DIRECTIVE,
      'assert.ok(true);',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.strictEqual(scan.violations.length, 1, '裸标记不该豁免');
    assert.strictEqual(scan.bareTags.length, 1);
    const res = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /没写理由/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- ③ 基线语义

test('守卫：基线内历史违规不阻断，基线外新增违规才失败（--update-baseline 收缩）', () => {
  const root = makeRoot('baseline');
  try {
    // 注意：夹具里必须有"真实的断言绑定"（`require('node:assert')`）——扫描按绑定生效，不再认字面前缀
    writeFixture(root, 'old.test.js', ["'use strict';", "const assert = require('node:assert');", 'assert.ok(true);'].join('\n'));
    const baselineFile = path.join(root, 'scripts', 'guards-baseline.json');
    fs.writeFileSync(baselineFile, guards.baselineContent(guards.scanAssertionHygiene(root).violations), 'utf8');
    const parsed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    assert.strictEqual(parsed.version, guards.BASELINE_VERSION);
    assert.strictEqual(parsed.violations.length, 1);

    const ok = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(ok.status, 0, `基线内违规不该阻断\n${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /基线内历史 1 处、基线外新增 0 处/);

    // 新增一条**不同**的违规 → 必须失败
    writeFixture(root, 'new.test.js', ["'use strict';", "const assert = require('node:assert');", 'assert.ok(rows.length >= 0);'].join('\n'));
    const bad = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(bad.status, 1, '基线之外的新违规必须失败');
    assert.match(bad.stderr, /test\/new\.test\.js/);
    assert.match(bad.stdout, /基线外新增 1 处/);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- ④ 钩子内容

test('钩子：模板里必须有「跑守卫」与「涉及 web/ 等高风险路径时跑全量 npm test」两步（读文件断言）', () => {
  const src = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(src, /node scripts\/check-guards\.js/, '安装器落盘的钩子必须调用守卫');
  assert.match(src, /npm test/, '涉及高风险路径时必须跑全量 npm test');
  assert.match(src, /web\/\*\|src\/static\.js\|app\/\*\|design\/brand\/\*\|desktop\/\*/, '高风险路径清单必须落进钩子');
  assert.match(src, /WW_SKIP_GUARD/, '紧急绕过开关必须存在');
  assert.match(src, /WW_GUARD_FULL/, '只跳全量的开关必须存在');

  const body = installer.HOOK_TEMPLATE;
  assert.ok(body.startsWith('#!/bin/sh'), '必须是可移植的 sh 钩子');
  assert.ok(!/\r/.test(body), '钩子内容不能带 CR（#!/bin/sh\\r 会让 sh 直接报错、钩子静默失效）');
  assert.match(body, /第 1 步[\s\S]*node scripts\/check-guards\.js/, '第 1 步必须总是跑守卫');
  assert.match(body, /第 2 步[\s\S]*npm test/, '第 2 步必须跑全量测试');
  assert.match(body, /未涉及 web\//, '不涉及高风险路径时必须显式跳过（并说明判定逻辑）');
  assert.match(body, /行尾假红|CRLF/, '必须提示本机 CRLF 假红这条已知情况');
  assert.ok(body.includes(installer.HOOK_MARKER), '必须带认领标记（否则安装器会以为是别人的钩子）');
});

test('安装器：幂等、写 LF、且绝不覆盖别人的 pre-push（--force 才覆盖）', (t) => {
  if (!hasGit()) return t.skip('没有 git，跳过');
  const root = makeRoot('hook');
  const quiet = { log() {}, logErr() {} };
  try {
    assert.strictEqual(git(root, ['init']).status, 0);
    const file = path.join(root, '.git', 'hooks', 'pre-push');

    const first = installer.install({ root, ...quiet });
    assert.strictEqual(first.installed, true);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes(installer.HOOK_MARKER));
    assert.ok(!/\r/.test(content), '必须写成 LF');

    const second = installer.install({ root, ...quiet });
    assert.strictEqual(second.reason, 'updated');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content, '重复安装必须幂等（内容逐字节一致）');

    const mine = '#!/bin/sh\necho 我自己的钩子\n';
    fs.writeFileSync(file, mine, 'utf8');
    const third = installer.install({ root, ...quiet });
    assert.strictEqual(third.installed, false, '别人的钩子不许覆盖');
    assert.strictEqual(third.reason, 'existing-custom-hook');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), mine, '别人的钩子必须原样保留');
    assert.strictEqual(installer.status(root).ours, false);

    const forced = installer.install({ root, force: true, ...quiet });
    assert.strictEqual(forced.installed, true);
    assert.ok(fs.readFileSync(file, 'utf8').includes(installer.HOOK_MARKER));
    assert.strictEqual(installer.status(root).ours, true);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------- ⑤ 基线文件本身

test('基线：格式合法、指纹可复算、条目不指向幽灵文件，且当前仓库没有基线外的新违规', () => {
  const data = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  assert.strictEqual(data.version, guards.BASELINE_VERSION, '基线版本号必须与脚本一致');
  assert.ok(Array.isArray(data.violations), 'violations 必须是数组');
  const ruleIds = new Set(guards.HYGIENE_RULES.map((r) => r.id));
  for (const v of data.violations) {
    assert.ok(ruleIds.has(v.rule), `基线里有未知规则：${v.rule}`);
    assert.ok(fs.existsSync(path.join(ROOT, v.file)), `基线条目指向的文件不存在：${v.file}`);
    assert.strictEqual(
      v.fingerprint,
      guards.fingerprintOf(v.file, v.rule, v.text),
      `指纹与行内容不符（手工改过 text？）：${v.file}:${v.line}`,
    );
  }
  // 等价于把守卫接进 npm test：新写的恒真断言会在这里被拦住
  const known = new Set(data.violations.map((v) => v.fingerprint));
  const fresh = guards.scanAssertionHygiene(ROOT).violations.filter((v) => !known.has(v.fingerprint));
  assert.deepStrictEqual(
    fresh,
    [],
    '出现基线之外的新违规（修掉它，或确有理由就写 // GUARD-ALLOW: <理由>）：\n'
      + fresh.map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n'),
  );
});

// ---------------------------------------------------------------- ⑥ pin 清单不许烂掉

test('pin 清单：与"pin 用例签名"一致（新增 pin 用例忘了登记 → 这里红），且签名仍然匹配', () => {
  // pin 用例的签名：把某个源文件/资产的内容哈希或白名单钉死在测试里的写法
  const SIGNATURES = [/sha256-/, /sourceSha256/, /SHELL_LEDGER/];
  // 本文件（meta 测试）自己就写着上面这些签名常量，不算 pin 用例 —— 显式排除，别让它自我指认
  const SELF = toPosix(path.relative(ROOT, __filename));
  const found = guards
    .listTestFiles(ROOT)
    .filter((f) => toPosix(path.relative(ROOT, f)) !== SELF)
    .filter((f) => SIGNATURES.some((re) => re.test(fs.readFileSync(f, 'utf8'))))
    .map((f) => toPosix(path.relative(ROOT, f)))
    .sort();
  const listed = guards.PIN_TESTS.map((t) => t.file).sort();
  assert.deepStrictEqual(
    found,
    listed,
    '命中 pin 签名的测试文件必须全部登记进 PIN_TESTS（否则守卫会漏跑它）：\n'
      + `  实际命中：${found.join(', ')}\n  已登记：${listed.join(', ')}`,
  );
  for (const t of guards.PIN_TESTS) {
    assert.ok(t.why && t.why.length > 5, `${t.file} 必须写明"为什么算 pin"（判定逻辑要能复核）`);
    assert.ok(Array.isArray(t.markers) && t.markers.length, `${t.file} 必须给出 pin 签名 markers`);
    assert.ok(fs.existsSync(path.join(ROOT, t.file)), `${t.file} 不存在`);
  }
  assert.deepStrictEqual(guards.verifyPinTests(ROOT), [], 'pin 签名漂移了 → 请复核 PIN_TESTS 清单');
});

// ---------------------------------------------------------------- ⑦ 行尾免疫 + 假红降级边界

test('行尾免疫：CRLF 工作区按仓库（LF）字节复核 pin，不假红，但要报出"行尾差异"', (t) => {
  if (!hasGit()) return t.skip('没有 git，跳过');
  const root = makeRoot('crlf');
  const LF_TEXT = [
    'src/static.js',
    'web/index.html',
    'web/m/index.html',
    'design/brand/v2/wolf-emblem.svg',
    'design/brand/v2/export/manifest.json',
    'design/brand/v2/export/app-icon.svg',
  ];
  try {
    // 复刻 pin 需要的最小集合（真实文件 + 真实 manifest）
    for (const rel of ['src/static.js', 'web/index.html', 'web/m/index.html']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
    }
    fs.cpSync(path.join(ROOT, 'design/brand/v2'), path.join(root, 'design/brand/v2'), { recursive: true });
    // 文本一律先归一成 LF：这样本用例在任何行尾的宿主工作区上都是确定性的
    for (const rel of LF_TEXT) {
      const p = path.join(root, rel);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'), 'utf8');
    }

    assert.strictEqual(git(root, ['init']).status, 0);
    assert.strictEqual(git(root, ['config', 'core.autocrlf', 'true']).status, 0);
    assert.strictEqual(git(root, ['add', '-A']).status, 0);
    assert.strictEqual(git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'pin fixture']).status, 0);

    // 第一遍：LF 工作区 → 与仓库字节一致，无行尾差异
    const lf = guards.pinStaticChecks(root);
    assert.deepStrictEqual(lf.failures, [], `LF 工作区不该报 pin 失败：${lf.failures.join(' / ')}`);
    assert.strictEqual(lf.drift, false);

    // 换成 CRLF（模拟 Windows 的 core.autocrlf=true 检出）
    for (const rel of ['web/index.html', 'web/m/index.html', 'design/brand/v2/wolf-emblem.svg']) {
      const p = path.join(root, rel);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
    }

    const crlf = guards.pinStaticChecks(root);
    assert.deepStrictEqual(
      crlf.failures,
      [],
      `CRLF 工作区不许把 pin 判成失败（否则 pre-push 会拦住每一次推送）：${crlf.failures.join(' / ')}`,
    );
    assert.strictEqual(crlf.drift, true, '必须报出"行尾差异"，输出才好提示"已按仓库字节校验、无需重新 pin"');

    const view = guards.ciViewBytes(root, 'web/index.html');
    assert.ok(!view.bytes.toString('utf8').includes('\r'), 'ciViewBytes 必须返回仓库（LF）字节');
    assert.strictEqual(view.drift, true);
  } finally {
    cleanup(root);
  }
});

/**
 * A3c：CSP 页面清单不许写死。
 *
 * 缺口（真缺陷，2026-09-21 实测）：清单原先是 `['web/index.html','web/m/index.html']`，
 * 而 web/offline.html 的内联脚本**也在** src/static.js 的白名单里。于是白名单里那条
 * **正在被使用**的哈希被报成"陈旧条目，同步白名单时顺手删掉" —— 真照它删，离线页的
 * "重试 / 网络恢复回首页"就会再次被 CSP 静默拦掉（test/offline-page.test.js 会判红）。
 *
 * 本用例在**临时根**上把两个方向都钉住（不碰主工作区）：
 *   ① 三个页面的哈希都在册 ⇒ 零失败、零"陈旧"警告；
 *   ② 白名单里塞一条谁都不用的哈希 ⇒ **必须**仍然报成陈旧（修误报不能把真问题一起放走）；
 *   ③ 改一个页面的内联脚本 ⇒ **必须**判红（这才是有这个守卫的理由）。
 */
test('pin 静态复核：CSP 页面清单从 web/ 推导（离线页不再被误报陈旧，真陈旧与真漂移仍判红）', () => {
  const root = makeRoot('csp-pages');
  try {
    for (const rel of ['src/static.js', 'web/index.html', 'web/m/index.html', 'web/offline.html']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
    }
    // 最小品牌 manifest（pin 腿会检查它；只放 source，不放导出资产）
    const brand = path.join(root, 'design', 'brand', 'v2');
    fs.mkdirSync(path.join(brand, 'export'), { recursive: true });
    const emblem = fs.readFileSync(path.join(ROOT, 'design', 'brand', 'v2', 'wolf-emblem.svg'));
    fs.writeFileSync(path.join(brand, 'wolf-emblem.svg'), emblem);
    fs.writeFileSync(path.join(brand, 'export', 'manifest.json'), JSON.stringify({
      source: 'design/brand/v2/wolf-emblem.svg',
      sourceSha256: crypto.createHash('sha256').update(emblem).digest('hex'),
      files: [],
    }));

    // ① 页面清单从 web/ 推导，三个带内联脚本的页面必须都在内
    const pages = guards.cspPages(root).sort();
    assert.deepStrictEqual(pages, ['web/index.html', 'web/m/index.html', 'web/offline.html'],
      'CSP 页面清单必须从 web/ 推导出全部三个带裸 <script> 的页面（写死清单就会漏掉离线页）');
    // 没有裸内联脚本的页面不许被算进来（口径：不带属性的 <script>）
    assert.ok(!pages.includes('web/ai-cast.html'), 'web/ai-cast.html 没有裸内联脚本，不该进入清单');

    const base = guards.pinStaticChecks(root);
    assert.deepStrictEqual(base.failures, [], `三个页面哈希都在册，不该有 pin 失败：${base.failures.join(' / ')}`);
    assert.deepStrictEqual(base.warnings, [],
      '三个哈希全都有人用，不许报任何"陈旧条目"（离线页被误报陈旧正是本用例要钉住的缺陷）');

    // ② 反向：白名单里塞一条谁都不用的哈希 ⇒ 仍必须报成陈旧
    const stPath = path.join(root, 'src', 'static.js');
    fs.appendFileSync(stPath, '\n// A3c 反向夹具：一条谁都不用的哈希\n// sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n');
    const stale = guards.pinStaticChecks(root);
    assert.deepStrictEqual(stale.failures, [], '多一条没用到的白名单条目只该是警告，不是失败');
    assert.ok(
      stale.warnings.some((w) => /陈旧条目/.test(w) && w.includes('sha256-AAAA')),
      `真陈旧条目必须仍然被判出来（修误报不能把真问题一起放走）：${JSON.stringify(stale.warnings)}`,
    );

    // ③ 反向：改一个页面的内联脚本（哈希随即对不上）⇒ 必须判红
    const idx = path.join(root, 'web', 'index.html');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('<script>', '<script>\n/* A3c 反向夹具 */'));
    const broken = guards.pinStaticChecks(root);
    assert.ok(
      broken.failures.some((f) => /不在 src\/static\.js 的 CSP 白名单里/.test(f)),
      `改了内联脚本必须判红（这才是这个守卫存在的理由）：${JSON.stringify(broken.failures)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('假红降级：只有"恰好那两条行尾敏感的 pin 用例失败"才放行，混进任何别的失败都不许降级', () => {
  const twoKnown = [
    '✖ CSP：index.html 的内联脚本哈希与 static.js 白名单一致（改脚本必须同步改 CSP） (2.1ms)',
    'test at test/remediation.test.js:458:1',
    '✖ brand v2: manifest pins source and every raster/icon export by SHA-256 (1.2ms)',
    'test at test/brand-v2.test.js:30:1',
    'ℹ fail 2',
  ].join('\n');
  assert.strictEqual(guards.isKnownCrlfFalseRed(guards.parseFailures(twoKnown)), true);

  // 混进一条真实失败 → 绝不降级
  const withReal = twoKnown.replace('ℹ fail 2', '✖ 真实失败：TTFT 不对 (0.5ms)\ntest at test/stream.test.js:61:1\nℹ fail 3');
  assert.strictEqual(guards.isKnownCrlfFalseRed(guards.parseFailures(withReal)), false);

  // 同文件里的**另一条**用例失败（不是行尾敏感那条）→ 绝不降级
  const otherInSameFile = [
    '✖ UX-01：移动端复盘 GET 必须携带令牌 (0.9ms)',
    'test at test/remediation.test.js:423:1',
    'ℹ fail 1',
  ].join('\n');
  assert.strictEqual(guards.isKnownCrlfFalseRed(guards.parseFailures(otherInSameFile)), false);

  // 解析不出来（node --test 输出格式变了）→ fail-safe：不降级
  assert.strictEqual(guards.isKnownCrlfFalseRed(guards.parseFailures('✖ 说不清\nℹ fail 1')), false);
  assert.strictEqual(guards.isKnownCrlfFalseRed(guards.parseFailures('')), false);
});

test('假红降级：腿 A2 只在"行尾差异 + 恰好那两条 pin 用例失败"时放行并打印说明（其余一律真红）', () => {
  const twoKnown = [
    '✖ CSP：index.html 的内联脚本哈希与 static.js 白名单一致（改脚本必须同步改 CSP） (2.1ms)',
    'test at test/remediation.test.js:458:1',
    '✖ brand v2: manifest pins source and every raster/icon export by SHA-256 (1.2ms)',
    'test at test/brand-v2.test.js:30:1',
    'ℹ fail 2',
  ].join('\n');
  // 用假的子进程结果驱动真流程：不必把工作区改成 CRLF（那会污染真实待推送内容）
  const fakeSpawn = () => ({ status: 1, stdout: twoKnown, stderr: '', error: undefined });

  const logs = [];
  const errs = [];
  const drifted = guards.runPinTests({
    root: ROOT,
    spawn: fakeSpawn,
    log: (m) => logs.push(String(m)),
    logErr: (m) => errs.push(String(m)),
    eolDrift: true,
  });
  assert.strictEqual(drifted.ok, true, '行尾假红应降级放行，否则钩子会拦住每一次推送');
  assert.strictEqual(drifted.crlfFalseRed, true);
  assert.ok(logs.some((l) => l.includes('含行尾假红降级')), '通过行要标明是降级来的');
  assert.match(errs.join('\n'), /本机行尾假红/, '必须打印醒目说明');
  assert.match(errs.join('\n'), /无需重新 pin/);

  // 同一份失败，但没有行尾差异 → 必须当真失败（降级只对行尾差异生效）
  const strict = guards.runPinTests({ root: ROOT, spawn: fakeSpawn, log() {}, logErr() {}, eolDrift: false });
  assert.strictEqual(strict.ok, false);
  assert.strictEqual(strict.crlfFalseRed, false);
});

// ---------------------------------------------------------------- ⑨ 断言绑定识别（别名/解构/链式）
/**
 * 修复前的漏检洞（实测）：扫描只认 `assert.` 这个**字面前缀**，于是
 *   `const a = require('node:assert'); a.ok(true);`        → 退出码 0（漏检）
 *   `const a = require('node:assert'); a.strictEqual(s, 404||500);` → 退出码 0（漏检）
 * 下面按 6 条规则 × 3 种绑定写法逐条复核；夹具里每行同时也是"行号必须准"的证明。
 */
const ALIAS_CASES = [
  {
    rule: 'ok-literal-truthy',
    destructure: "const { ok } = require('node:assert');",
    alias: 'a.ok(true);',
    destructured: 'ok(true);',
    chained: "require('node:assert').ok(true);",
  },
  {
    rule: 'always-true-compare',
    destructure: "const { ok } = require('node:assert');",
    alias: 'a.ok(rows.length >= 0);',
    destructured: 'ok(rows.length >= 0);',
    chained: "require('node:assert').ok(rows.length >= 0);",
  },
  {
    rule: 'equals-alternative-literal',
    destructure: "const { strictEqual } = require('node:assert/strict');",
    alias: 'a.strictEqual(res.status, 404 || 500);',
    destructured: 'strictEqual(res.status, 404 || 500);',
    chained: "require('node:assert').strictEqual(res.status, 404 || 500);",
  },
  {
    rule: 'ok-status-disjunction',
    destructure: "const { ok } = require('node:assert');",
    alias: 'a.ok(res.status === 404 || res.status === 500);',
    destructured: 'ok(res.status === 404 || res.status === 500);',
    chained: "require('node:assert').ok(res.status === 404 || res.status === 500);",
  },
  {
    rule: 'ok-tautology-disjunction',
    destructure: "const { ok } = require('node:assert');",
    alias: 'a.ok(n !== 1 || n !== 2);',
    destructured: 'ok(n !== 1 || n !== 2);',
    chained: "require('node:assert').ok(n !== 1 || n !== 2);",
  },
  {
    rule: 'ok-truthy-fallback',
    destructure: "const { ok } = require('node:assert');",
    alias: 'a.ok(x !== undefined || true);',
    destructured: 'ok(x !== undefined || true);',
    chained: "require('node:assert').ok(x !== undefined || true);",
  },
];

for (const c of ALIAS_CASES) {
  test(`守卫别名：${c.rule} 对「别名命名空间 / 解构 / 链式 require」三种写法都生效`, () => {
    const root = makeRoot(`alias-${c.rule}`);
    try {
      writeFixture(root, 'probe.test.js', [
        "'use strict';",
        "const test = require('node:test');",
        "const a = require('node:assert');",
        c.destructure,
        '',
        "test('别名写法', () => {",
        '  const res = { status: 404 };',
        '  const rows = [];',
        '  const n = 1;',
        '  const x = 1;',
        `  ${c.alias}`,
        `  ${c.destructured}`,
        `  ${c.chained}`,
        '});',
      ].join('\n'));

      const scan = guards.scanAssertionHygiene(root);
      assert.deepStrictEqual(
        scan.violations.map((v) => v.rule),
        [c.rule, c.rule, c.rule],
        `三种绑定写法都必须命中 ${c.rule}：${JSON.stringify(scan.violations)}`,
      );
      assert.deepStrictEqual(scan.violations.map((v) => v.line), [11, 12, 13], '行号要准（报警要能点到位）');
      assert.deepStrictEqual(scan.aliasBindings.map((b) => b.file), ['test/probe.test.js'], '要报出"识别到了别名/解构绑定"');

      const res = runCli(['--root', root, '--assertions-only']);
      assert.strictEqual(res.status, 1, `守卫必须非零退出，实际 ${res.status}\n${res.stdout}${res.stderr}`);
      assert.match(res.stderr, new RegExp(`probe\\.test\\.js:12\\s+\\[${c.rule}\\]`), '解构那一行必须被点名');
      assert.match(res.stdout, /识别到 assert 以外的断言绑定/);
    } finally {
      cleanup(root);
    }
  });
}

test('守卫别名：B/C 两种漏检写法的端到端反向验证（临时文件必须红，删掉必须绿）', () => {
  const root = makeRoot('alias-reverse');
  try {
    // B：const a=require('node:assert'); a.ok(true);
    writeFixture(root, 'b.test.js', ["'use strict';", "const a = require('node:assert');", 'a.ok(true);'].join('\n'));
    // C：const a=require('node:assert'); a.strictEqual(s, 404||500);
    writeFixture(root, 'c.test.js', ["'use strict';", "const a = require('node:assert');", 'a.strictEqual(s, 404 || 500);'].join('\n'));

    const red = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(red.status, 1, `B/C 两种写法都必须让守卫失败\n${red.stdout}${red.stderr}`);
    assert.match(red.stderr, /b\.test\.js:3\s+\[ok-literal-truthy\]/);
    assert.match(red.stderr, /c\.test\.js:3\s+\[equals-alternative-literal\]/);

    // 删掉两个临时文件 → 必须立刻变绿（说明红就是这两处引起的，不是别的噪音）
    for (const name of ['b.test.js', 'c.test.js']) fs.rmSync(path.join(root, 'test', name));
    const green = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(green.status, 0, `删掉违规文件后必须通过\n${green.stdout}${green.stderr}`);
  } finally {
    cleanup(root);
  }
});

test('守卫别名：绑定识别基于文件里真实的 require/解构（不是"任何 xx.ok() 都算断言"）', () => {
  // 直接复核"识别出了哪些绑定名"：这条断言是"基于真实绑定"这一设计的证明
  const code = guards.stripForScan([
    "'use strict';",
    "const assert = require('node:assert/strict');",
    "const a = require('assert');",
    "const strictNs = require('node:assert').strict;",
    'const b = a;',
    "const { ok, strictEqual: isSame, strict: s2 } = require('node:assert');",
    "const db = require('./helpers');",
    "const other = require('assert-plus');",
    "const dyn = require('node:' + 'assert');",
  ].join('\n'), { keepRequireStrings: true });

  const bindings = guards.collectAssertBindings(code);
  assert.deepStrictEqual([...bindings.namespaces].sort(), ['a', 'assert', 'b', 's2', 'strictNs']);
  assert.deepStrictEqual([...bindings.methods.get('ok')], ['ok']);
  assert.deepStrictEqual([...bindings.methods.get('strictEqual')], ['isSame']);
  assert.strictEqual(bindings.methods.has('equal'), false, '没解构出来的方法不该凭空出现');
  assert.ok(!bindings.namespaces.has('db'), "别的模块的 require 不算断言：require('./helpers')");
  assert.ok(!bindings.namespaces.has('other'), "非 assert 模块名不算断言：require('assert-plus')");
  assert.ok(!bindings.namespaces.has('dyn'), '动态 require 不识别（已知边界）');
});

test('守卫别名：对象方法 / 别的模块的 .ok() 一律不算断言（不许误报）', () => {
  const root = makeRoot('alias-false-positive');
  try {
    writeFixture(root, 'objects.test.js', [
      "'use strict';",
      'const db = { ok: () => true, strictEqual: () => true };',
      "const h = require('./helpers');",
      'db.ok(true);',
      'db.strictEqual(1, 404 || 500);',
      'h.ok(true);',
      'h.strictEqual(1, 404 || 500);',
      "require('assert-plus').ok(true);",
      "require('node:assert').strictEqual(1, 404 || 500);",
      "const a = require('node:assert');",
      'a.ok(true);',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(
      scan.violations.map((v) => [v.line, v.rule]),
      [[9, 'equals-alternative-literal'], [11, 'ok-literal-truthy']],
      `对象方法/别的模块不许误报，只有真断言要报：${JSON.stringify(scan.violations)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('守卫别名：改名解构、命名空间二次别名、.strict 绑定、链式 .strict 都要生效', () => {
  const root = makeRoot('alias-forms');
  try {
    writeFixture(root, 'forms.test.js', [
      "'use strict';",
      "const { ok: isOk, strictEqual: isSame } = require('node:assert');",
      "const base = require('assert');",
      'const alias = base;',
      "const strictNs = require('node:assert').strict;",
      "const { strict: s } = require('assert');",
      'isOk(true);',
      'isSame(404, 404 || 500);',
      'alias.ok(true);',
      'strictNs.ok(true);',
      's.ok(true);',
      "require('assert').strict.deepStrictEqual(1, 404 || 500);",
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations.map((v) => [v.line, v.rule]), [
      [7, 'ok-literal-truthy'],
      [8, 'equals-alternative-literal'],
      [9, 'ok-literal-truthy'],
      [10, 'ok-literal-truthy'],
      [11, 'ok-literal-truthy'],
      [12, 'equals-alternative-literal'],
    ], `改名/二次别名/.strict 都要生效：${JSON.stringify(scan.violations)}`);
  } finally {
    cleanup(root);
  }
});

test('守卫别名：已知边界（设计取舍，钉住以免被误当成"已覆盖"）', () => {
  const root = makeRoot('alias-boundary');
  try {
    writeFixture(root, 'boundary.test.js', [
      "'use strict';",
      "const a = require('node:assert');",
      // ① 计算成员 / 可选链：不识别（稳定写法 a.ok(...) 一定识别）
      "a['ok'](true);",
      'a?.ok(true);',
      // ② 无声明符的解构赋值 / 复杂解构形态（默认值）：不识别
      'let b;',
      "({ ok: b } = require('node:assert'));",
      'b(true);',
      "const { ok = () => {} } = require('node:assert');",
      'ok(true);',
      // ③ 把断言挂到别的对象上再用：不识别（不排除 `.assert` 就会误报 node:test 的 `t.assert.ok()`）
      'const h = { assert: a };',
      'h.assert.ok(true);',
    ].join('\n'));

    assert.deepStrictEqual(
      guards.scanAssertionHygiene(root).violations,
      [],
      '这些形态按设计漏报（宁可漏报也不误报）——若哪天识别了，请更新源码注释与本用例',
    );
  } finally {
    cleanup(root);
  }
});

test('守卫别名：已知边界（文件级近似）—— 解构名被同名参数遮蔽时会多报', () => {
  const root = makeRoot('alias-shadow');
  try {
    writeFixture(root, 'shadow.test.js', [
      "'use strict';",
      "const { ok } = require('node:assert');",
      '',
      'function notAnAssert(ok) {',
      '  ok(true);',
      '}',
      'ok(true);',
    ].join('\n'));

    // 第 5 行的 ok 其实是参数，不是断言 → 这是**已知的多报**（不做作用域分析的代价）。
    // 方向是"多报可疑行"而不是"漏掉恒真断言"；真被遮蔽时写 `// GUARD-ALLOW: <理由>` 说明即可。
    assert.deepStrictEqual(
      guards.scanAssertionHygiene(root).violations.map((v) => v.line),
      [5, 7],
      '文件级近似的已知边界：多报第 5 行；这个行为被钉住，改动识别逻辑时请显式复核',
    );
  } finally {
    cleanup(root);
  }
});

test('守卫别名：只有 require(...) 的模块名字符串被保留，字符串/正则里的别名断言仍不算违规', () => {
  const code = guards.stripForScan([
    "const a = require('node:assert');",
    'const doc = "const a = require(\'node:assert\'); a.ok(true);";',
    'const rx = /a\\.ok\\(true\\)/;',
  ].join('\n'), { keepRequireStrings: true });

  assert.match(code, /require\('node:assert'\)/, "require 的模块名字符串必须保留（绑定判定与链式 require 都要看它）");
  assert.ok(!code.includes('a.ok(true)'), `字符串/正则里的代码骨架必须照样清空：${code}`);
  // 默认形态不受影响（其它调用方依赖这个默认值）
  assert.ok(!guards.stripForScan("require('node:assert')").includes('node:assert'), '不传 keepRequireStrings 时字符串照旧清空');
});

test('守卫别名：没有识别到绑定的裸 assert.x() 不误报，但必须给出"可能漏检"提示（不阻断）', () => {
  const root = makeRoot('alias-unbound');
  try {
    // 断言库是通过"别的途径"拿到的（`const { assert } = require('./helpers')`）：识别不了 → 不报违规，
    // 但必须提示，否则语义收窄（不再认字面前缀）会**静默**丢掉这块覆盖。
    writeFixture(root, 'unbound.test.js', [
      "'use strict';",
      "const { assert } = require('./helpers');",
      'assert.ok(true);',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations, [], '识别不到绑定就不该误报（宁可漏报也不误报对象方法）');
    assert.deepStrictEqual(scan.unboundAssert.map((w) => w.file), ['test/unbound.test.js']);

    const res = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(res.status, 0, '只是提示，不阻断');
    assert.match(res.stdout, /却没识别到断言绑定/);
    assert.match(res.stdout, /test\/unbound\.test\.js/);
  } finally {
    cleanup(root);
  }
});

test('守卫别名：t.assert.x()（别的对象上的同名属性）既不算断言也不该触发提示', () => {
  const root = makeRoot('alias-tassert');
  try {
    writeFixture(root, 'node-test-ctx.test.js', [
      "'use strict';",
      "const test = require('node:test');",
      '',
      "test('用测试上下文的断言', (t) => {",
      '  t.assert.ok(true);',
      '  t.assert.strictEqual(1, 404 || 500);',
      '});',
    ].join('\n'));

    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations, [], 't.assert 不是我们识别的绑定，不该误报');
    assert.deepStrictEqual(scan.unboundAssert, [], '它没有"裸用 assert"，不该触发可能漏检提示');
  } finally {
    cleanup(root);
  }
});

test('守卫别名：没识别到绑定的 assert.ok(true) 不再算违规（字面前缀已废弃，这是有意的语义收窄）', () => {
  const root = makeRoot('alias-no-binding');
  try {
    writeFixture(root, 'nobinding.test.js', ["'use strict';", 'assert.ok(true);'].join('\n'));
    const scan = guards.scanAssertionHygiene(root);
    assert.deepStrictEqual(scan.violations, [], '没有 require/解构绑定 → 不按断言调用处理（改动前的行为靠字面前缀）');
    assert.strictEqual(scan.unboundAssert.length, 1, '但这种文件必须被点名，避免盲区静默存在');
  } finally {
    cleanup(root);
  }
});
