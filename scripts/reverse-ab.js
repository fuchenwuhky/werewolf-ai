/**
 * reverse-ab.js — A/B 验收的**反向验证**（计划书 §11 :377 点名要求）
 *
 * 「在隔离副本中破坏目标行为后测试应失败，恢复后通过；不得在用户正式工作区做破坏性实验。」
 *
 * 做法：
 *   1) 把 server.js / package.json / src / web / scripts 复制到 os.tmpdir() 下的临时目录
 *      （**真仓库只读**，一个字节都不改，全程不做任何 git 操作）；
 *   2) 在副本上跑一遍 scripts/ab-acceptance.js（AB_ROOT=副本）⇒ 期望全绿（副本基线）；
 *   3) 在副本里**精确破坏**按档隔离：src/api.js 里 `if (doc.ownerProfileId !== pid) continue;`
 *      （锚点按**文本**匹配，不写行号 —— 行号会漂移）⇒ 期望「A 档看不到 B 局」这类断言**判红**；
 *   4) 打印两次读数对比 ⇒ 证明断言"真的能红"，不是永远绿；恢复后再跑一遍 ⇒ 期望重新全绿。
 *
 * 入仓版相对仓外原件的改动（见 docs/fix-plan-2026-09-21.md §16.19.2 承诺）：
 *   · 真仓库根用 path.join(__dirname,'..') 自行定位，**不写死**任何绝对路径；被验收的脚本
 *     改成仓内的 scripts/ab-acceptance.js（原来指向仓外那份同名一次性脚本）。
 *   · 端口不写死（原来是 3984/3985/3986）：父进程不指定端口，由每一轮的 ab-acceptance.js
 *     自己让内核分配空闲端口（父进程挑端口再交给子进程会多一个 bind 抢占窗口）。
 *   · 每一轮子进程带超时（默认 300s，WW_AB_RUN_TIMEOUT 可覆盖），超时先 taskkill /T /F 杀掉
 *     整棵进程树，再由父进程**代删**该轮遗留的临时数据目录（父进程从子进程输出里解析路径）。
 *   · 三处退出码统一为：0 = 全部通过；1 = 有检查项失败；2 = 无法执行（缺源文件 / 锚点对不上 /
 *     被验收脚本退出码 2 / 超时）。
 *   · 副本用完即删（finally；安全校验只删 tmpdir 下 ww- 前缀目录）。要留副本核对：--keep。
 *
 * 用法：node scripts/reverse-ab.js [--keep]
 * 预计用时：约 2～4 分钟（三轮，每轮起一台真实服务端）。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP = process.argv.slice(2).includes('--keep');
const RUN_TIMEOUT_MS = Math.max(30000, Number(process.env.WW_AB_RUN_TIMEOUT) || 300000);

// 真仓库根 = 本脚本的上一级；被验收脚本也在同一个仓库里，所以两处都随仓库走。
const REAL = path.resolve(__dirname, '..');
const ACC = path.join(REAL, 'scripts', 'ab-acceptance.js');
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-abcopy-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
// 只删 os.tmpdir() 下、名字以 ww- 开头的目录；任何其它路径一律拒绝（防误删仓库）。
function rmTemp(dir) {
  if (!dir) return true;
  const full = path.resolve(dir);
  if (!full.startsWith(path.resolve(os.tmpdir()) + path.sep) || !/^ww-/.test(path.basename(full))) {
    console.log(`  !! 拒绝删除疑似非临时目录：${full}`);
    return false;
  }
  try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {
    console.log(`  !! 临时目录删除失败：${e && e.message}`);
  }
  return !fs.existsSync(full);
}
// 杀掉子进程整棵树：Windows 上用 taskkill /T /F（ab-acceptance 自己还会 spawn 一台服务端，
// 只 kill 父进程会把服务端留成孤儿并占着端口）；其它平台用 SIGKILL。
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
  } else {
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
}
// 从子进程输出里把 WW_DATA_DIR 捡出来代删：子进程被强杀时（看门狗/超时）它自己的 finally 跑不到。
function sweepDataDirs(out) {
  const re = /WW_DATA_DIR = ([^\s（(]+)/g;
  let m, n = 0;
  while ((m = re.exec(out))) { if (rmTemp(m[1])) n++; }
  return n;
}

async function run(label) {
  console.log('\n  ── ' + label + ' ──');
  const t0 = Date.now();
  const child = spawn(process.execPath, [ACC], {
    // 不设 WW_AB_PORT：让被验收脚本自己挑空闲端口并打印，避免父挑子 bind 之间的抢占窗口。
    env: { ...process.env, AB_ROOT: COPY },
    cwd: COPY, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, RUN_TIMEOUT_MS);
  const exit = await new Promise((resolve) => {
    child.on('error', (e) => { out += '\n[spawn error] ' + e.message; });
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);

  const port = (out.match(/端口 = (\d+)/) || [])[1] || '?';
  for (const line of out.split('\n')) {
    if (/读数：|失败明细|^\s+- |✗|无法执行/.test(line)) console.log('  ' + line.trim());
  }
  const m = out.match(/PASS (\d+) \/ FAIL (\d+)/);
  const r = {
    exit, timedOut, port, out,
    pass: m ? Number(m[1]) : -1,
    fail: m ? Number(m[2]) : -1,
    ms: Date.now() - t0,
  };
  console.log(`  ⇒ 端口 ${port}；PASS ${r.pass} / FAIL ${r.fail}；退出码 ${exit}；用时 ${(r.ms / 1000).toFixed(1)}s`
    + (timedOut ? `（!! 超过 ${RUN_TIMEOUT_MS}ms 被强杀）` : ''));
  if (timedOut) {
    const swept = sweepDataDirs(out);
    console.log(`  ⇒ 超时强杀后由父进程代删临时数据目录 ${swept} 个`);
  }
  return r;
}

async function main() {
  console.log('  真仓库（只读）= ' + REAL);
  console.log('  被验收脚本 = ' + ACC);
  console.log('  隔离副本 = ' + COPY + '（跑完即删）');
  if (!fs.existsSync(ACC)) { console.log('  !! 缺 ' + ACC + ' ⇒ 无法执行（退出码 2）'); return 2; }
  for (const item of ['server.js', 'package.json', 'src', 'web', 'scripts']) {
    const s = path.join(REAL, item);
    if (!fs.existsSync(s)) { console.log('  !! 缺 ' + item + ' ⇒ 无法执行（退出码 2）'); return 2; }
    if (fs.statSync(s).isDirectory()) copyDir(s, path.join(COPY, item));
    else fs.copyFileSync(s, path.join(COPY, item));
  }
  // src/api.js:68 require('../scripts/mock-agent') ⇒ 副本必须带 scripts/，否则服务端起不来。
  // 注意：**不复制也不链接 node_modules**（本项目零依赖，不需要它）。
  console.log('  ✓ 副本就绪（含 scripts/；未复制 node_modules —— 本项目零依赖）');

  const t0 = Date.now();
  const base = await run('① 副本基线（未破坏）');
  if (base.exit === 2 || base.pass < 0) {
    console.log('  !! 基线就跑不起来（退出码 2 / 读不到读数）⇒ 无法执行（退出码 2），不做破坏性实验');
    return 2;
  }

  // ── 精确破坏：洞开按档隔离（磁盘侧）──
  // 该守卫（磁盘侧）实测出现 2 次，所以要求"全部替换、替换后剩 0 处"，既精确又彻底；
  // 若锚点对不上（上游文本改了），**停下而不是硬改** —— 不精确的破坏会诬告断言。
  const apiPath = path.join(COPY, 'src', 'api.js');
  const orig = fs.readFileSync(apiPath, 'utf8');
  const GUARD = 'if (doc.ownerProfileId !== pid) continue;';
  const n = orig.split(GUARD).length - 1;
  console.log(`\n  准备破坏：副本里 "${GUARD}" 出现 ${n} 次`);
  if (n < 1) { console.log('  !! 期望至少 1 次，实际 0 ⇒ 停下（锚点对不上，不做不精确的破坏），退出码 2'); return 2; }
  const replaced = orig.split(GUARD).join('/* 反向验证：故意洞开按档隔离（仅在隔离副本内） */');
  const remain = replaced.split(GUARD).length - 1;
  if (remain !== 0) { console.log('  !! 替换后仍剩 ' + remain + ' 处 ⇒ 停下，退出码 2'); return 2; }
  fs.writeFileSync(apiPath, replaced);
  console.log(`  ✓ 已在副本内洞开 src/api.js 的按档隔离（${n} 处全部替换，剩余 ${remain} 处；真仓库未动）`);

  const red = await run('② 副本破坏后');
  if (red.exit === 2 || red.pass < 0) {
    console.log('  !! 破坏后这一轮"无法执行"（退出码 2），红/绿读数不可解释 ⇒ 整体退出码 2');
    return 2;
  }

  // ── 恢复 ──
  fs.writeFileSync(apiPath, orig);
  const restored = await run('③ 副本恢复后');

  // ── 判定 ──
  const checks = [
    ['基线全绿（副本未破坏时 PASS≥30 且 FAIL=0、退出码 0）', base.fail === 0 && base.pass >= 30 && base.exit === 0],
    ['破坏后必须转红（断言真的能红，退出码 1）', red.fail > 0 && red.exit === 1],
    ['破坏后正是「不串档」那几条变红', /串档|A 档看不到 B 局|B 档看不到 A 局|ownerProfileId/.test(red.out)],
    ['恢复后重新全绿（FAIL=0 且 PASS 与基线相同、退出码 0）', restored.fail === 0 && restored.pass === base.pass && restored.exit === 0],
    ['真仓库未被改动（破坏只发生在副本里）', fs.readFileSync(path.join(REAL, 'src', 'api.js'), 'utf8').includes(GUARD)],
  ];
  console.log('\n  ── 反向验证判定 ──');
  let bad = 0;
  for (const [name, okv] of checks) { console.log(`  ${okv ? '✓' : '✗'} ${name}`); if (!okv) bad++; }
  console.log(`\n  三轮读数：基线 ${base.pass}/${base.fail}（退出码 ${base.exit}）→ 破坏 ${red.pass}/${red.fail}（退出码 ${red.exit}）→ 恢复 ${restored.pass}/${restored.fail}（退出码 ${restored.exit}）`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s；真仓库全程只读`);
  return bad === 0 ? 0 : 1;
}

let code = 2;
main()
  .then((c) => { code = c; })
  .catch((e) => { console.log('  !! 脚本异常（无法执行，退出码 2）：' + (e && e.stack || e)); code = 2; })
  .then(async () => {
    // 无论成功/失败/异常：删掉副本（--keep 时保留供核对），并兜底清扫可能遗留的临时数据目录。
    if (KEEP) console.log('  · --keep：副本保留在 ' + COPY + '（请手工删除）');
    else console.log('  · 副本' + (rmTemp(COPY) ? '已删除' : '删除失败（见上方提示）') + '：' + COPY);
    process.exit(code);
  });
