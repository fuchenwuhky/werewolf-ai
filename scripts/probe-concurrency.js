/**
 * probe-concurrency.js — A1：探测"单个 Key 到底允许多少并发"
 *
 * 为什么要有这个工具：
 *   项目现在假定"1 Key = 1 并发"，所有请求严格串行 —— 这个假定是**保守**的，
 *   但没人验证过服务商真正的额度。如果它其实允许 2~4 并发，我们白白损失了大量墙钟时间；
 *   如果不允许，多开一条就是自找 429。这件事必须**实测**，不能猜。
 *
 * 用法（会真实消耗少量额度：每档 n 个极短请求，共约 30 次微型调用）：
 *   node scripts/probe-concurrency.js            # 探测 1/2/3/4 并发
 *   node scripts/probe-concurrency.js --max=6    # 探到 6
 *   node scripts/probe-concurrency.js --dry      # 只打印将要发的请求，不真发
 *
 * 安全约束（与项目硬约束一致）：
 *   · 只读 config.json 里的 baseUrl/model/apiKey，不改任何配置；
 *   · 每档只发 n 个 `max_tokens: 8` 的极短请求（不写提示词工程，不占用思考预算）；
 *   · 一旦出现限流/配额错误立即停止，不再往上加档（不硬撞限流）；
 *   · **不写任何缓存/配置**：结论打给你看，由你决定要不要填第二个 Key。
 */
'use strict';
const fs = require('fs');
const path = require('path');

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

async function oneCall(cfg, tag) {
  const t0 = Date.now();
  const res = await fetch(`${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, ms: Date.now() - t0, body: text.slice(0, 200), tag };
}

/** 429 / 限流业务码 / 配额：都算"这一档过不去" */
function isRateLimited(r) {
  if (r.status === 429) return true;
  return /1302|429|rate|限流|too many|quota|配额/i.test(r.body);
}

async function main() {
  const cfg = loadCfg();
  if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    console.log('未找到可用的 config.json（需要 baseUrl/model/apiKey）。请在网页版设置里配置后再运行。');
    process.exit(2);
  }
  console.log(`目标：${cfg.baseUrl}  模型：${cfg.model}`);
  console.log(`将探测 1..${MAX} 并发；每档发 n 个 max_tokens=8 的极短请求（总计约 ${(MAX * (MAX + 1)) / 2} 次）。`);
  if (DRY) {
    console.log('[dry] 只演练调度，不真发请求。');
  }
  const results = [];
  for (let n = 1; n <= MAX; n++) {
    if (DRY) {
      results.push({ n, ok: true, wallMs: 0, note: '(dry)' });
      continue;
    }
    const t0 = Date.now();
    let out;
    try {
      out = await Promise.all(Array.from({ length: n }, (_, i) => oneCall(cfg, `n${n}-${i}`)));
    } catch (e) {
      console.log(`并发 ${n}：请求异常（${e.message}）→ 判定为"不支持"，停止加档`);
      results.push({ n, ok: false, wallMs: Date.now() - t0, note: e.message });
      break;
    }
    const bad = out.filter((r) => !r.ok);
    const wall = Date.now() - t0;
    results.push({ n, ok: bad.length === 0, wallMs: wall, note: bad.length ? `HTTP ${bad[0].status}` : '' });
    if (bad.length) {
      const rl = bad.some(isRateLimited);
      console.log(`并发 ${n}：失败（${bad[0].status} ${bad[0].body.slice(0, 80)}）→ ${rl ? '触发限流' : '服务端错误'}，停止加档`);
      break;
    }
    const per = out.map((r) => r.ms);
    console.log(`并发 ${n}：全部成功  墙钟 ${wall}ms  单次 p50 ${per.sort((a, b) => a - b)[Math.floor(n / 2)]}ms`);
  }
  console.log('\n结论：');
  if (DRY) {
    console.log('  演练模式：没有真发请求，因此**没有**结论。去掉 --dry 再跑一次。');
    return;
  }
  const ok = results.filter((r) => r.ok).map((r) => r.n);
  const top = ok.length ? Math.max(...ok) : 0;
  if (!ok.length) console.log('  未能完成任何一档（检查网络/Key）。');
  else if (top <= 1) console.log('  单 Key 只支持 1 并发 —— 现状（严格串行）就是最优，不需要多 Key。');
  else console.log(`  单 Key 实测可并发 ${top} —— 可以用 config.json 的 apiKeys 填入 ${top} 个 Key 换取约 20%~25% 的墙钟收益（不是减半，见 docs/fluency-plan.md §1.4）。`);
  console.log('  注意：并发额度可能随时间/套餐变化，结论只代表本次实测。');
}

main().catch((e) => {
  console.error('探测失败：', e && e.message);
  process.exit(1);
});
