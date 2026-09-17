/**
 * probe-concurrency.js — 实测"每把 Key 到底允许多少并发"
 *
 * 为什么要有这个工具：
 *   项目默认每把 Key 起手 1 条泳道，之后靠自适应慢慢收敛；但收敛过程要赔上几次 429。
 *   主动探一次，就能直接把起始值放到正确的位置。运行中的服务端也可以用设置页的
 *   「探测并发额度」按钮做同一件事（共用 src/ai/probe.js）。
 *
 * 用法（会真实消耗少量额度：每档 n 个极短请求）：
 *   node scripts/probe-concurrency.js            # 每把 Key 探 1..4
 *   node scripts/probe-concurrency.js --max=6    # 探到 6
 *   node scripts/probe-concurrency.js --dry      # 只说明将要发的请求，不真发
 *
 * 安全约束（与项目硬约束一致）：
 *   · 只读 config.json 里的 baseUrl/model/apiKey(s)，不改任何配置；
 *   · 每档只发 n 个 `max_tokens: 8` 的极短请求；
 *   · 一旦出现限流/配额错误立即停止加档（不硬撞限流）；
 *   · **不写任何缓存/配置**：结论打给你看，要应用到运行中的服务请用设置页按钮。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { probeKeys } = require('../src/ai/probe');
const { parseApiKeys } = require('../src/config');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const maxArg = args.find((a) => a.startsWith('--max='));
const MAX = maxArg ? Math.max(1, Number(maxArg.split('=')[1]) || 4) : 4;

function loadCfg() {
  const p = path.join(__dirname, '..', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function main() {
  const cfg = loadCfg();
  const keys = cfg ? parseApiKeys(cfg) : [];
  if (!cfg || !keys.length || !cfg.baseUrl || !cfg.model) {
    console.log('未找到可用的 config.json（需要 baseUrl/model/apiKey）。请在网页版设置里配置后再运行。');
    process.exit(2);
  }
  console.log(`目标：${cfg.baseUrl}  模型：${cfg.model}  待测 Key：${keys.length} 把`);
  console.log(`将逐把探测 1..${MAX} 并发；每档发 n 个 max_tokens=8 的极短请求（每把约 ${(MAX * (MAX + 1)) / 2} 次）。`);
  if (DRY) {
    console.log('[dry] 只演练，不真发请求。');
    return;
  }
  const results = await probeKeys(cfg, { max: MAX, keys });
  console.log('\n逐把 Key 结论：');
  for (const r of results) {
    console.log(`  Key ${r.index}（${r.key}）：已知可并发 ${r.limit} —— ${r.reason}`);
    for (const t of r.results) {
      console.log(`      ${t.n} 并发：${t.ok ? `全部成功  墙钟 ${t.wallMs}ms  单次 p50 ${t.p50}ms` : `失败（${t.rateLimited ? '限流' : `HTTP ${t.status}`}）`}`);
    }
  }
  const total = results.reduce((a, r) => a + r.limit, 0);
  console.log('\n结论：');
  console.log(`  建议总并发：${total}（每把 Key 的实测额度之和）`);
  console.log('  应用到运行中的服务：设置页 →「探测并发额度」按钮（它会直接写进调度器）。');
  console.log('  也可以什么都不做：调度器会按同样的证据自动收敛，只是要多花几次重试。');
  console.log('  注意：并发额度可能随时间/套餐变化，结论只代表本次实测。');
}

main().catch((e) => {
  console.error('探测失败：', e && e.message);
  process.exit(1);
});
