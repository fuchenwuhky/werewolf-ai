#!/usr/bin/env node
/**
 * dev-server.js — 起一个**测试用应用实例**（与 scripts/playtest-fault.js 完全同款的启动方式）。
 *
 * 为什么需要它：实测发现"日志写出"取决于启动方式 —— 用 PowerShell `Start-Process` 起的实例
 * 日志会长期停留在 0 字节（写入流有缓冲，进程退出才刷新，我因此在运行期间误判过"日志不写"），
 * 而用 `spawn` + **整份父环境** 起的实例日志正常（6327 字节的 game 日志）。
 * 要用 `bench:pace` / `playtest:report` 读日志出**实测口径**，就用这种方式起实例。
 *
 * 隔离（每次都做，不给"手滑"留机会）：
 *   · 数据目录 = --dir（默认 %TEMP%/ww-dev-server），`saves/` 与正式数据目录**不可见**；
 *   · 若 --config 指向已有配置则复制一份进数据目录（WW_CONFIG 只认复制件）；
 *   · 端口默认 3216，绝不占用正式 3210。
 * 注意：默认复制**正式 config.json** 是为了能跑真实对局；一旦在它上面开真局就会消耗额度，
 *       mock 局则不消耗。**不打包、不碰 saves/、不改正式 config.json。**
 *
 * 用法：
 *   node scripts/dev-server.js                       # 起在 3216，数据目录 %TEMP%/ww-dev-server
 *   node scripts/dev-server.js --port=3220 --dir=D:\tmp\ww-x
 *   node scripts/dev-server.js --config=fake.json    # 指向别的配置（例如假 LLM 的配置）
 *
 * ⚠️⚠️ 两条硬约束（都是踩出来的，改动前请先读懂）：
 *
 *   1) **文件名绝不能以 `-test.js` / `.test.js` / `test-*.js` 结尾，也不能放进 test/ 目录。**
 *      本脚本原名 `serve-test.js` → 命中 Node 测试发现规则 `**​/*-test.js` →
 *      `npm run coverage`（`node --test --experimental-test-coverage`，无路径参数=自动发现）
 *      把它当成测试文件执行 → 它 spawn 出一个常驻 server 且永不退出 →
 *      `coverage-gate.js` 用 spawnSync 阻塞等待 → **`npm run gate` 永久挂起**
 *      （实测卡 40+ 分钟，进程树里能看到脱离的 `node server.js`）。
 *
 *   2) **副作用只能发生在"真的直接运行"时**，并且要能识别"被测试运行器当成测试执行"的情况：
 *      那种场景下 `require.main === module` 同样为真，只靠它挡不住，
 *      必须同时检查 `NODE_TEST_CONTEXT`（Node 给测试文件子进程设置的标记）。
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const arg = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) arg[m[1]] = m[2] === undefined ? true : m[2];
  }
  return arg;
}

/** 起一个隔离的测试实例；返回子进程。只有直接运行本脚本时才会被调用。 */
function startTestServer(argv = process.argv.slice(2)) {
  const arg = parseArgs(argv);
  const PORT = String(arg.port || 3216);
  const DIR = path.resolve(arg.dir || path.join(os.tmpdir(), 'ww-dev-server'));
  const SRC_CONFIG = path.resolve(arg.config || path.join(ROOT, 'config.json'));

  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(SRC_CONFIG)) {
    fs.copyFileSync(SRC_CONFIG, path.join(DIR, 'config.json'));
  } else {
    process.stdout.write(`⚠ 没找到配置 ${SRC_CONFIG}，实例会走默认配置（真实对局会因缺 Key 失败）\n`);
  }

  const env = {
    ...process.env, // ← 关键：整份父环境，日志写出依赖它
    PORT,
    NO_OPEN: '1',
    WW_DATA_DIR: DIR,
    WW_CONFIG: path.join(DIR, 'config.json'),
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'inherit' });

  process.stdout.write(`测试实例：http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`数据目录：${DIR}（已隔离，saves/ 与正式 config.json 不可见）\n`);
  process.stdout.write(`日志写往：${path.join(DIR, 'logs')}（进程退出后才刷新到磁盘，别在运行期间读大小）\n`);
  process.stdout.write('按 Ctrl+C 结束。\n');
  return child;
}

module.exports = { startTestServer, parseArgs };

// ↓ 副作用守卫：被 require 时什么都不做；只有真·直接运行才起实例
if (require.main === module) {
  // 硬守卫 2：被测试运行器当成"测试文件"执行时立刻退出（这种场景 require.main 也为真）
  if (process.env.NODE_TEST_CONTEXT) {
    process.stdout.write('dev-server.js：处于测试运行器中，按约定不启动实例（直接退出）。\n');
    process.exit(0);
  }
  const child = startTestServer();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        child.kill();
      } catch (_) {
        /* 已退出 */
      }
      process.exit(0);
    });
  }
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
}
