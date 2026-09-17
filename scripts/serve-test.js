#!/usr/bin/env node
/**
 * serve-test.js — 起一个**测试用应用实例**（与 scripts/playtest-fault.js 完全同款的启动方式）。
 *
 * 为什么需要它：实测发现"日志写出"取决于启动方式 —— 用 PowerShell `Start-Process` 起的实例
 * 会建出 0 字节的 server.log / game-*.log，而用 `spawn` + **整份父环境** 起的实例日志正常
 * （6327 字节的 game 日志）。P6 要用 `bench:pace` / `playtest:report` 读日志出**实测口径**，
 * 所以必须用这种方式起实例，别再手搓 Start-Process。
 *
 * 隔离（每次都做，不给"手滑"留机会）：
 *   · 数据目录 = --dir（默认 %TEMP%/ww-serve-test），`saves/` 与正式数据目录**不可见**；
 *   · 若 --config 指向已有配置则复制一份进数据目录（WW_CONFIG 只认复制件）；
 *   · 端口默认 3216，绝不占用正式 3210。
 * 注意：默认复制**正式 config.json** 是为了能跑真实对局；一旦在它上面开真局就会消耗额度，
 *       mock 局则不消耗。**不打包、不碰 saves/、不改正式 config.json。**
 *
 * 用法：
 *   node scripts/serve-test.js                       # 起在 3216，数据目录 %TEMP%/ww-serve-test
 *   node scripts/serve-test.js --port=3220 --dir=D:\tmp\ww-x
 *   node scripts/serve-test.js --config=fake.json    # 指向别的配置（例如假 LLM 的配置）
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (m) arg[m[1]] = m[2] === undefined ? true : m[2];
}
const ROOT = path.join(__dirname, '..');
const PORT = String(arg.port || 3216);
const DIR = path.resolve(arg.dir || path.join(os.tmpdir(), 'ww-serve-test'));
const SRC_CONFIG = path.resolve(arg.config || path.join(ROOT, 'config.json'));

fs.mkdirSync(DIR, { recursive: true });
if (fs.existsSync(SRC_CONFIG)) {
  fs.copyFileSync(SRC_CONFIG, path.join(DIR, 'config.json'));
} else {
  process.stdout.write(`⚠ 没找到配置 ${SRC_CONFIG}，实例会走默认配置（真实对局会因缺 Key 失败）\n`);
}

const env = {
  ...process.env,           // ← 关键：整份父环境，日志写出依赖它（实测 0 字节 vs 6327 字节的差异就在这里）
  PORT,
  NO_OPEN: '1',
  WW_DATA_DIR: DIR,
  WW_CONFIG: path.join(DIR, 'config.json'),
};
const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'inherit' });

process.stdout.write(`测试实例：http://127.0.0.1:${PORT}\n`);
process.stdout.write(`数据目录：${DIR}（已隔离，saves/ 与正式 config.json 不可见）\n`);
process.stdout.write(`日志将写往：${path.join(DIR, 'logs')}\n`);
process.stdout.write('按 Ctrl+C 结束。\n');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(); } catch (_) { /* 已退出 */ } process.exit(0); });
}
child.on('exit', (code) => process.exit(code === null ? 0 : code));
