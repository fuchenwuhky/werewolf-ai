#!/usr/bin/env node
/**
 * tmp-residue-check.js — 测试临时目录残留门禁（NEW-19 后半）
 *
 * 为什么需要：`node --test` 默认并行跑文件，未隔离的测试会把临时目录或数据目录写到
 * **共享路径**（`%TEMP%`，或由 `dirname(saveDir)` 推导出的仓库根）。NEW-01 / NEW-04 /
 * NEW-15 / NEW-17 都是这一类缺陷。静态守卫（test/tmp-isolation-guard.test.js）只能查
 * "写法对不对"，查不出"运行时到底有没有真的漏出来" —— 这个脚本补的就是那一段。
 *
 * 做法：给子进程一个**私有的空 TEMP**，跑全量测试，跑完看这个目录顶层有没有多出东西。
 *   · 必须先证明子进程真的跑完了（解析出 `ℹ pass N`、退出码 0、fail 为 0）——
 *     否则"没有残留"只是"没有跑"，毫无意义；
 *   · 允许名单只有一个：`node-compile-cache`（理由见下）。
 *
 * 为什么 `node-compile-cache` 在名单里（**实测**，不是想当然）：
 *   在一个全新空目录里只执行 `npm --version` ⇒ 该目录立刻出现 `node-compile-cache/`；
 *   只执行 `node --version` ⇒ 什么都不出现。即它是 **npm 自己**的运行时编译缓存
 *   （npm 用 `module.enableCompileCache()` 给自己加速），不是本仓库任何测试的临时目录，
 *   也不是本项目代码的产物。本脚本用 `node` 直连子进程（不经 npm），正常情况下它不该出现；
 *   列进名单只是为了在"外层已经跑过 npm"的环境里不误报。
 *   **除此之外任何顶层新增一律判失败** —— 不允许把真实泄漏也塞进名单来换绿。
 *
 * 诚实边界：
 *   · 只度量**全量测试套件**的残留，不含 coverage / eval 等会额外启动 npm 自身的腿；
 *   · 它不检查仓库工作区是否被写脏（那由各测试自己的 `git status` 前后对照负责）。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
/** npm 自身的运行时编译缓存：已在全新空目录里用 `npm --version` 单独复核过（见文件头） */
const ALLOW = new Set(['node-compile-cache']);

const main = () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-residue-'));
  try {
    const res = spawnSync(process.execPath, ['--test'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox },
    });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    const pass = /^ℹ pass (\d+)/m.exec(out);
    const fail = /^ℹ fail (\d+)/m.exec(out);
    const added = fs.readdirSync(sandbox);
    const leftover = added.filter((n) => !ALLOW.has(n));

    console.log(`  · 私有沙箱：${sandbox}`);
    console.log(`  · 子进程测试：pass ${pass ? pass[1] : '?'} / fail ${fail ? fail[1] : '?'}（退出码 ${res.status}）`);
    console.log(`  · 沙箱顶层新增 ${added.length} 项${added.length ? `：${added.join('、')}` : '（空）'}`);

    // 注意顺序：残留判据**先**报。两件事可能同时发生（例如某个测试既写了共享路径、
    // 又被静态守卫抓红），若把"有效性"放在前面，就会用"度量无效"盖住真正的问题 ——
    // 本脚本第一次做反向验证时正是这样误导了主控 ✗。
    if (leftover.length) {
      console.error(`✖ 测试在私有 TEMP 里留下了 ${leftover.length} 项：${leftover.join('、')}`);
      console.error('  说明有测试没清理自己的临时目录（NEW-01/04/15/17 那一类）。');
      console.error('  修法：用 test/helpers-tmpdir.js 的独占目录，不要写共享路径；不要往本脚本的允许名单里加名字来换绿。');
      process.exit(1);
    }
    if (!pass || res.status !== 0 || (fail && Number(fail[1]) > 0)) {
      console.error('✖ 子进程没有正常跑完全量测试 ⇒ 本次残留度量无效，不能当成通过');
      console.error('  （残留本身为 0，但"没跑完"和"跑干净"不是一回事，所以这里也必须红。）');
      process.exit(1);
    }
    console.log('✓ 临时目录残留门禁通过（除已实证的 npm 自带 node-compile-cache 外，零残留）');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
};

if (require.main === module) main();
module.exports = { ALLOW };
