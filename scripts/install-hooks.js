#!/usr/bin/env node
/**
 * install-hooks.js — 安装/更新 `.git/hooks/pre-push` 守卫（FIX-20 腿 2）
 *
 * ## 为什么要有钩子
 * 「改 web/ 忘了同步 pin」这类事故，靠人记是记不住的：定向用例是绿的、CI 才红。
 * 把守卫挂到 `git push` 之前，就是让机器替人记：
 *   ① **总是**跑 `node scripts/check-guards.js`（秒级：pin 静态复核 + pin 敏感用例 + 断言卫生）；
 *   ② 本次推送**涉及 pin 高风险路径**时再跑全量 `npm test` —— 这类改动最容易连带弄脏 pin，
 *      而定向用例看不出来（真实事故就是这么发生的）。
 *
 * ## 高风险路径的判定逻辑（都按 git 仓库相对路径、正斜杠）
 *   web/*            前端本体（含 web/m/**、web/assets/**、web/shared/**）：改脚本/样式/HTML
 *                    就可能要重算内联脚本的 CSP 白名单
 *   src/static.js    CSP 白名单与静态服务本体（`?v=` 内容哈希的改写逻辑也在这里）
 *   app/*            Capacitor 安卓壳：内嵌 web/ 副本 + 图标资源
 *   design/brand/*   品牌 pin 的源头：manifest.json + 全部导出资产（SHA-256 都被钉住）
 *   desktop/*        桌面壳的打包配置与图标（desktop/build/icon.ico 是品牌导出资产的下游拷贝）
 * 判定"本次推送改了哪些文件"用 pre-push 从 stdin 收到的 `<local sha> <remote sha>` 做 `git diff`；
 * 新分支/远端对象不可比时，退回"本次推送各提交涉及的文件"（`git log --name-only --not --remotes`），
 * 比不出来就保守多查。
 *
 * ## 幂等与安全
 *   · 重复运行 = 重新写入我们那份（内容一致，无副作用）；
 *   · 已存在**别人**的 pre-push（不带标记）→ 只提示、**不覆盖**（`--force` 才覆盖）；
 *   · Windows 上钩子文件写成 LF（`#!/bin/sh` 带 CRLF 会直接跑不起来）。
 *
 * ## 绕过
 *   WW_SKIP_GUARD=1 git push   —— 紧急绕过（会打印醒目警告 + 要你自查的三个 pin 点）
 *   WW_GUARD_FULL=0  git push  —— 守卫照跑，只跳过"全量测试"这一步
 *
 * ## 用法
 *   node scripts/install-hooks.js            # 安装/更新
 *   node scripts/install-hooks.js --print    # 只打印钩子内容（不落盘）
 *   node scripts/install-hooks.js --force    # 覆盖已存在的非守卫 pre-push
 *   node scripts/install-hooks.js --status   # 只看当前装的是哪一份
 * 出口码：0 = 已安装/已是最新；1 = 已存在别人的钩子（未覆盖）或安装失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
/** 认领标记：install 靠它判断"这份是不是我们装的"（绝不靠文件名猜） */
const HOOK_MARKER = 'ww-guard-hook v1';
const HOOK_NAME = 'pre-push';

// 注意：除了下面注入认领标记的那一处，模板里刻意不出现 `${...}`（否则会被模板字符串插值）——
// shell 变量一律写成 $VAR，`${VAR:-默认值}` 这种写法干脆不用。
const HOOK_TEMPLATE = `#!/bin/sh
# ${HOOK_MARKER} — 由 scripts/install-hooks.js 安装；重跑 \`npm run hooks:install\` 可幂等更新本文件。
#
# 为什么有它：改 web/ 时必须同步 src/static.js 的 CSP 白名单与品牌 manifest 的 SHA-256 pin，
# 否则 CI 会红，而只跑定向用例的人当场发现不了（2026-09 真实事故）。
#
# 绕过（紧急，会打印醒目警告）：WW_SKIP_GUARD=1 git push
# 只跳过"全量测试"这一步（守卫仍然跑）：WW_GUARD_FULL=0 git push

if [ "$WW_SKIP_GUARD" = "1" ]; then
  echo "" >&2
  echo "⚠⚠⚠ WW_SKIP_GUARD=1：已跳过推送前守卫（断言卫生 + pin 敏感用例 + 全量测试） ⚠⚠⚠" >&2
  echo "    这次推送没有经过任何「改 web/ 必须同步 pin」的校验，请自行确认这三处：" >&2
  echo "      ① web/index.html | web/m/index.html 的内联脚本改了 → src/static.js 的 CSP sha256 白名单要同步" >&2
  echo "      ② design/brand/v2/** 的品牌资产改了 → manifest 的 SHA-256 pin 要重算（npm run brand:apply）" >&2
  echo "      ③ web/sw.js 的 SHELL 清单改了 → 升 VERSION 并在 test/sw-shell.test.js 登记新指纹" >&2
  echo "" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✖ pre-push：找不到 node，无法运行守卫。确认要推送就用 WW_SKIP_GUARD=1 git push" >&2
  exit 1
fi

# 钩子的工作目录通常就是工作树根，但不保证（worktree / 子目录调用）→ 显式切过去
root=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$root" ]; then cd "$root" || exit 1; fi
if [ ! -f scripts/check-guards.js ]; then
  echo "✖ pre-push：找不到 scripts/check-guards.js（当前目录：$(pwd)）" >&2
  echo "  在仓库根手工跑一次：node scripts/check-guards.js；确认要推送就 WW_SKIP_GUARD=1 git push" >&2
  exit 1
fi

echo "▶ [pre-push] 第 1 步：守卫（断言卫生 + pin 静态复核 + pin 敏感用例，秒级）"
if ! node scripts/check-guards.js; then
  echo "" >&2
  echo "✖ 守卫失败 → 推送已阻止（报错见上）。修完再推；紧急绕过：WW_SKIP_GUARD=1 git push" >&2
  echo "  改 web/ 之后至少要同步这三处：" >&2
  echo "    ① web/*/index.html 的内联守卫脚本 → 重算 sha256 并同步 src/static.js 的 CSP 白名单" >&2
  echo "    ② 品牌资产 design/brand/v2/** → npm run brand:apply 重新 pin SHA-256，再 npm run brand:check" >&2
  echo "    ③ web/sw.js 的 SHELL 清单 → 升 VERSION 并在 test/sw-shell.test.js 的 SHELL_LEDGER 登记新指纹" >&2
  echo "  自己先跑一遍：node scripts/check-guards.js 与 npm test" >&2
  exit 1
fi

# ---- 第 2 步：本次推送是否涉及 pin 高风险路径 ----
# web/*（含 web/m、web/assets、web/shared）、src/static.js、app/*、design/brand/*、desktop/*
files=""
while read -r local_ref local_sha remote_ref remote_sha; do
  # git 给的是 LF 结尾，但管道/包装脚本可能塞进回车符（Windows）：留着会让远端 sha 比对失败
  local_sha=$(printf '%s' "$local_sha" | tr -d '\\r')
  remote_sha=$(printf '%s' "$remote_sha" | tr -d '\\r')
  [ -n "$local_sha" ] || continue
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
  if [ -n "$remote_sha" ] && [ "$remote_sha" != "0000000000000000000000000000000000000000" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    part=$(git diff --name-only "$remote_sha" "$local_sha" 2>/dev/null | tr -d '\\r') || part=""
  else
    # 新分支 / 远端还没有这些对象：拿不到可比基线 → 保守取本次推送各提交涉及的文件
    part=$(git log --no-merges --pretty=format: --name-only "$local_sha" --not --remotes 2>/dev/null | tr -d '\\r') || part=""
  fi
  files="$files
$part"
done

risky=""
old_ifs=$IFS
IFS='
'
for f in $files; do
  case "$f" in
    web/*|src/static.js|app/*|design/brand/*|desktop/*)
      case "
$risky" in
        *"
$f"*) ;;
        *) risky="$risky$f
" ;;
      esac
      ;;
  esac
done
IFS=$old_ifs

if [ "$WW_GUARD_FULL" = "0" ]; then
  echo "▶ [pre-push] 第 2 步：WW_GUARD_FULL=0 → 跳过全量测试（守卫已通过）"
  exit 0
fi

if [ -z "$risky" ]; then
  echo "✓ [pre-push] 第 2 步：本次推送未涉及 web/ / src/static.js / app/ / design/brand/ / desktop/ → 跳过全量测试"
  exit 0
fi

echo "▶ [pre-push] 第 2 步：本次推送涉及 pin 高风险路径，跑全量测试（npm test）："
printf '%s' "$risky" | while IFS= read -r f; do
  [ -n "$f" ] && echo "    · $f"
done
echo "  注意：本机 CRLF（core.autocrlf=true）会让 CSP / 品牌两条 pin 用例假红；守卫第 1 步已按仓库字节（LF）复核过。"
echo "        若全量测试只失败 test/remediation.test.js 与 test/brand-v2.test.js 那两条，那是行尾假红，以 CI（LF）为准。"
full=0
if command -v npm >/dev/null 2>&1; then
  npm test
  full=$?
else
  echo "  （找不到 npm，改用 node --test）"
  node --test
  full=$?
fi
if [ "$full" -ne 0 ]; then
  echo "" >&2
  echo "✖ 全量测试失败 → 推送已阻止。" >&2
  echo "  若失败**仅**来自 test/remediation.test.js（CSP）与 test/brand-v2.test.js（品牌 pin 字节哈希），" >&2
  echo "  那是本机 CRLF 行尾假红（守卫第 1 步已按 LF 字节复核通过），可用 WW_SKIP_GUARD=1 git push" >&2
  echo "  或 WW_GUARD_FULL=0 git push；其它任何失败都必须先修。" >&2
  exit 1
fi
echo "✓ [pre-push] 全量测试通过"
exit 0
`;

function git(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return res.error || res.status !== 0 ? null : String(res.stdout || '').trim();
}

/**
 * 钩子目录：优先 core.hooksPath（相对路径按仓库根解析），否则 <git-dir>/hooks。
 * 用 `git rev-parse --absolute-git-dir` 是为了兼容 worktree / submodule（.git 是文件的情况）。
 */
function hooksDir(root = ROOT) {
  const configured = git(root, ['config', '--get', 'core.hooksPath']);
  if (configured) return { dir: path.resolve(root, configured), via: `core.hooksPath=${configured}` };
  const abs = git(root, ['rev-parse', '--absolute-git-dir']) || git(root, ['rev-parse', '--git-dir']);
  if (!abs) throw new Error('这里不是 git 仓库（git rev-parse 失败），无法安装钩子');
  const gitDir = path.isAbsolute(abs) ? abs : path.resolve(root, abs);
  return { dir: path.join(gitDir, 'hooks'), via: 'git-dir/hooks' };
}

/** 当前已装的 pre-push 是不是我们那份 */
function status(root = ROOT, file) {
  const target = file || path.join(hooksDir(root).dir, HOOK_NAME);
  if (!fs.existsSync(target)) return { exists: false, ours: false, file: target };
  const content = fs.readFileSync(target, 'utf8');
  return { exists: true, ours: content.includes(HOOK_MARKER), file: target };
}

/**
 * 安装（幂等）。已存在**别人**的 pre-push 时除非 force=true，否则只提示、不覆盖。
 * 返回 { installed, reason, file }（reason: ok | updated | existing-custom-hook）
 */
function install({ root = ROOT, force = false, log = console.log, logErr = console.error } = {}) {
  const { dir, via } = hooksDir(root);
  const file = path.join(dir, HOOK_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const before = status(root, file);
  if (before.exists && !before.ours && !force) {
    logErr(`✖ 已存在非守卫的 pre-push：${file}`);
    logErr(`  （里面没有「${HOOK_MARKER}」标记）→ **不覆盖**，你的钩子原样保留。`);
    logErr('  想两者都要：手工把 `node scripts/check-guards.js` 那一段并进你的钩子；');
    logErr('  确认可以覆盖：node scripts/install-hooks.js --force');
    return { installed: false, reason: 'existing-custom-hook', file };
  }
  // Windows 上必须写 LF：`#!/bin/sh\r` 会让 sh 找不到解释器，钩子直接失效
  fs.writeFileSync(file, HOOK_TEMPLATE.replace(/\r\n/g, '\n'), 'utf8');
  try {
    fs.chmodSync(file, 0o755); // Windows 上语义有限，git 用 sh 跑钩子，不依赖执行位
  } catch { /* 忽略：无执行位也能跑 */ }
  log(`✓ 已${before.exists ? '更新' : '安装'} pre-push 守卫：${file}（${via}）`);
  log('  · 每次 push 都会先跑：node scripts/check-guards.js（秒级）');
  log('  · 推送涉及 web/ | src/static.js | app/ | design/brand/ | desktop/ 时，再跑全量 npm test');
  log('  · 紧急绕过：WW_SKIP_GUARD=1 git push（会打印醒目警告）；只跳全量：WW_GUARD_FULL=0 git push');
  return { installed: true, reason: before.exists ? 'updated' : 'ok', file };
}

function parseArgs(argv) {
  const opts = { force: false, print: false, status: false, help: false };
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--print') opts.print = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

const USAGE = '用法：node scripts/install-hooks.js [--print|-p] [--status] [--force]';

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`✖ ${e.message}\n${USAGE}`);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.print) { process.stdout.write(HOOK_TEMPLATE); return 0; }
  if (opts.status) {
    const st = status(ROOT);
    if (!st.exists) console.log(`· 尚未安装 pre-push（目标：${st.file}）`);
    else if (st.ours) console.log(`✓ 已安装守卫版 pre-push：${st.file}`);
    else console.log(`⚠ ${st.file} 存在，但不是守卫版（无「${HOOK_MARKER}」标记）——安装时不会覆盖它`);
    return 0;
  }
  try {
    return install({ force: opts.force }).installed ? 0 : 1;
  } catch (e) {
    console.error(`✖ 安装失败：${e.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { ROOT, HOOK_MARKER, HOOK_NAME, HOOK_TEMPLATE, hooksDir, status, install, parseArgs, main, USAGE };
