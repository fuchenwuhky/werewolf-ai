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
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    writeFixture(root, 'old.test.js', ["'use strict';", 'assert.ok(true);'].join('\n'));
    const baselineFile = path.join(root, 'scripts', 'guards-baseline.json');
    fs.writeFileSync(baselineFile, guards.baselineContent(guards.scanAssertionHygiene(root).violations), 'utf8');
    const parsed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    assert.strictEqual(parsed.version, guards.BASELINE_VERSION);
    assert.strictEqual(parsed.violations.length, 1);

    const ok = runCli(['--root', root, '--assertions-only']);
    assert.strictEqual(ok.status, 0, `基线内违规不该阻断\n${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /基线内历史 1 处、基线外新增 0 处/);

    // 新增一条**不同**的违规 → 必须失败
    writeFixture(root, 'new.test.js', ["'use strict';", 'assert.ok(rows.length >= 0);'].join('\n'));
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
