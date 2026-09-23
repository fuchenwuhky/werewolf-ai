#!/usr/bin/env node
/**
 * acceptance-snapshot.js —— 为**当前提交**生成一份提交级验收快照（零依赖，只用 Node 内置模块）。
 *
 * 为什么要有它：文档 final-delivery-construction-plan.md 要求 `artifacts/acceptance/<版本>-<commit>/`，
 * 但仓内此前**没有任何脚本**负责生成它 —— 目录里只有一个人工留下的 `1.5.2-bd99743`，
 * 于是"制品与提交是否一致"这件事没法复跑、只能靠人记得。本脚本把它变成一键可复跑：
 *
 *   用法：node scripts/acceptance-snapshot.js [--out <目录>] [--skip-device] [--skip-tests]
 *
 * 纪律：
 *  · 每一步都**真跑**，把完整输出落进快照目录的 logs/ 下，并把退出码与关键读数写进 MANIFEST。
 *  · 任何一步失败 ⇒ 整体退出码 1（**不把失败写成通过**）。
 *  · 工作区不干净（除白名单外有改动）⇒ 记为 ⚠ 并让整体退出码为 1 —— 否则"制品对应哪个提交"就是假的。
 *  · 设备验证需要模拟器在线；不在线时用 --skip-device 显式跳过，快照里会**明写"未跑"**，不冒充通过。
 *  · 不写用户数据（saves/ profiles/ config.json）；服务端测试一律用 WW_DATA_DIR 临时目录。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const SKIP_DEVICE = process.argv.includes('--skip-device');
const SKIP_TESTS = process.argv.includes('--skip-tests');

const git = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
};
const HEAD = git(['rev-parse', 'HEAD']);
const SHORT = git(['rev-parse', '--short', 'HEAD']);
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'unknown'; }
  catch (_) { return 'unknown'; }
})();

const OUT = path.resolve(ROOT, argOf('--out', path.join('artifacts', 'acceptance', VERSION + '-' + SHORT)));
const LOGS = path.join(OUT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const rows = [];
const record = (name, ok, readout, logFile) => {
  rows.push({ name, ok: !!ok, readout: String(readout == null ? '' : readout), log: logFile ? path.relative(OUT, logFile).replace(/\\/g, '/') : '' });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (readout ? '  — ' + String(readout).slice(0, 160) : ''));
};

/** 跑一条命令，输出落盘；返回 { ok, status, tail }。status 为 0 才算通过。 */
function step(name, cmd, args, opts) {
  const o = opts || {};
  const logFile = path.join(LOGS, o.log || (name.replace(/[^\w.-]+/g, '_') + '.log'));
  const env = Object.assign({}, process.env, o.env || {});
  if (!env.WW_DATA_DIR) env.WW_DATA_DIR = path.join(ROOT, 'logs', 'acceptance-data');
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: 'utf8', timeout: o.timeout || 1800000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  const text = [r.stdout || '', r.stderr || ''].join('\n');
  fs.writeFileSync(logFile, text, 'utf8');
  const tail = text.split('\n').filter((l) => l.trim()).slice(-3).join(' | ');
  const ok = r.status === 0;
  record(name, ok, o.readout ? o.readout(text) : ('退出码 ' + r.status + (ok ? '' : ' | ' + tail)), logFile);
  return { ok, status: r.status, text };
}

// ── 0. 提交与工作区 ──────────────────────────────────────────────────────────
const status = git(['status', '--porcelain']);
// 白名单：被本仓明确排除在设计目录之外的素材（未纳入版本库，属已知事项，不算"工作区脏"到要判红）
// 白名单分两类，都不是"源码脏改"：
//  ① design/card-frames/：设计素材未纳入版本库，属已知事项（见台账 §16.36.6）
//  ② artifacts/acceptance/：**本脚本自己的输出目录**。不豁免它，脚本第二次运行就会把上一次的产物
//     当成"工作区脏"判红——那是自指噪声，不是提交与制品不一致。快照是否入库由人决定，与"源码是否干净"无关。
const allow = [/^\?\? design\/card-frames\/?$/, /^\?\? artifacts\/acceptance\//];
const dirty = status.split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !allow.some((re) => re.test(s)));
record('提交与工作区：工作区干净（除 design/card-frames 未跟踪，见台账 §16.36.6）',
  dirty.length === 0, dirty.length ? ('未提交改动 ' + dirty.length + ' 项：' + dirty.slice(0, 3).join(' ; ')) : ('HEAD ' + SHORT));
fs.writeFileSync(path.join(LOGS, 'git-status.log'), 'commit=' + HEAD + '\nversion=' + VERSION + '\n\n' + (status || '(clean)') + '\n', 'utf8');

// ── 1. 全量测试 ─────────────────────────────────────────────────────────────
if (!SKIP_TESTS) {
  step('全量测试 node --test', 'node', ['--test'], {
    log: 'test.log', timeout: 2400000,
    readout: (t) => {
      const g = (k) => { const m = t.match(new RegExp('^\\u2139 ' + k + ' (\\d+)$', 'm')); return m ? m[1] : '?'; };
      return 'tests ' + g('tests') + ' / pass ' + g('pass') + ' / fail ' + g('fail');
    },
  });
} else {
  record('全量测试 node --test', false, '**未跑**（--skip-tests 显式跳过）');
}

// ── 2. 制品一致性（包内容与源码是否一致） ────────────────────────────────────
step('制品一致性 npm run app:verify', 'npm', ['run', 'app:verify'], {
  log: 'app-verify.log', timeout: 1800000,
  readout: (t) => (t.match(/(\d+)\s*\/\s*(\d+)/) || [])[0] || '见日志',
});

// ── 3. 证据目录像素闸门（防空白帧再混进仓） ──────────────────────────────────
const evDirs = ['B', 'C2', 'D', 'E'].map((b) => path.join(ROOT, 'docs', 'evidence', b)).filter((d) => fs.existsSync(d));
if (evDirs.length) {
  step('证据目录空白帧闸门 png-stats docs/evidence/*', 'node', ['scripts/png-stats.js', ...evDirs], {
    log: 'png-stats.log', env: { PNG_STAT_QUIET: '1' }, timeout: 600000,
    readout: (t) => (t.match(/合计[^\n]*/g) || []).slice(-1)[0] || '见日志',
  });
} else {
  record('证据目录空白帧闸门 png-stats docs/evidence/*', false, '**找不到证据目录**');
}

// ── 4. Android 真机验证（需模拟器在线） ──────────────────────────────────────
if (!SKIP_DEVICE) {
  step('Android 真机验证 device-check', 'node', ['scripts/device-check.js'], {
    log: 'device-check.log', timeout: 900000,
    readout: (t) => (t.match(/结果：[^\n]*/) || [])[0] || '见日志',
  });
} else {
  record('Android 真机验证 device-check', false, '**未跑**（--skip-device 显式跳过；设备不在线时不得冒充通过）');
}

// ── 5. 制品清单与哈希（证明"快照里的包"就是这些包） ───────────────────────
function sha256(file) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}
const patterns = [
  path.join(ROOT, 'release'),
  path.join(ROOT, 'dist'),
  path.join(ROOT, 'app', 'android', 'app', 'build', 'outputs', 'apk', 'debug'),
];
const artifacts = [];
for (const dir of patterns) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    if (!/\.(apk|exe|zip|7z)$/i.test(f)) continue;
    artifacts.push({ path: path.relative(ROOT, p).replace(/\\/g, '/'), bytes: fs.statSync(p).size, sha256: sha256(p) });
  }
}
for (const f of fs.readdirSync(ROOT)) {
  if (/\.(apk|exe)$/i.test(f)) {
    const p = path.join(ROOT, f);
    artifacts.push({ path: f, bytes: fs.statSync(p).size, sha256: sha256(p) });
  }
}
record('制品清单与 sha256（' + artifacts.length + ' 个）', artifacts.length > 0,
  artifacts.map((a) => a.path.split('/').pop() + '=' + a.bytes + 'B').join(' , ') || '**没找到任何 apk/exe**');

// ── 汇总 ────────────────────────────────────────────────────────────────────
const allOk = rows.every((r) => r.ok);
const md = [];
md.push('# 验收快照 · ' + VERSION + ' @ ' + SHORT);
md.push('');
md.push('- 提交：`' + HEAD + '`');
md.push('- 版本：`' + VERSION + '`');
md.push('- 生成时间：' + new Date().toISOString());
md.push('- **结论：' + (allOk ? '全部通过 ✅' : '存在未通过项 ❌') + '**');
md.push('');
md.push('| 检查项 | 结果 | 读数 | 日志 |');
md.push('| --- | --- | --- | --- |');
rows.forEach((r) => md.push('| ' + r.name + ' | ' + (r.ok ? '✅' : '❌') + ' | ' + r.readout.replace(/\|/g, '/') + ' | ' + (r.log ? '`' + r.log + '`' : '—') + ' |'));
md.push('');
md.push('## 制品哈希');
md.push('');
md.push('| 文件 | 字节 | sha256 |');
md.push('| --- | --- | --- |');
artifacts.forEach((a) => md.push('| `' + a.path + '` | ' + a.bytes + ' | `' + a.sha256 + '` |'));
md.push('');
md.push('> 本目录由 `node scripts/acceptance-snapshot.js` 生成，可一键复跑。');
md.push('> 每一项都是真跑：未跑的项会**显式写成"未跑"并计入未通过**，不会因为跳过而变绿。');
fs.writeFileSync(path.join(OUT, 'MANIFEST.md'), md.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ commit: HEAD, version: VERSION, at: new Date().toISOString(), allOk, rows, artifacts }, null, 2) + '\n', 'utf8');

console.log('\n快照目录：' + path.relative(ROOT, OUT).replace(/\\/g, '/'));
console.log('结论：' + (allOk ? '全部通过' : '存在未通过项') + '（' + rows.filter((r) => r.ok).length + '/' + rows.length + '）');
process.exit(allOk ? 0 : 1);
