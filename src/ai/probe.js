/**
 * probe.js — 实测"某把 Key 到底允许多少并发"
 *
 * 为什么需要它：项目默认假定"1 把 Key 起手 1 条泳道"，但**没人知道服务商真正的额度**。
 * 自适应（scheduler 里的 AIMD）会慢慢收敛，但收敛过程要赔上几次 429；主动探测一次就能直接
 * 把起始值放到正确的位置。CLI（scripts/probe-concurrency.js）与设置页按钮共用这一份实现。
 *
 * 安全约束：
 *   · 每档只发 n 个 `max_tokens: 8` 的极短请求，不占用思考预算；
 *   · 一旦出现限流/配额错误**立即停止加档**（不硬撞限流）；
 *   · 只读配置，不写任何东西 —— 结论返回给调用方，由它决定要不要改额度。
 */
'use strict';

/** 单次极短请求 */
async function defaultOneCall({ baseUrl, apiKey, model, timeoutMs = 20000 }) {
  const t0 = Date.now();
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    // 探测工具按定义不能经调度器：排队会把"要测的额度"本身限掉，测出来的就不是服务商的真实上限
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, { // lint-allow: 探测额度必须绕过调度器，见上一行说明
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: ac ? ac.signal : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body: text.slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 429 / 限流业务码 / 配额：都算"这一档过不去" */
function isRateLimited(r) {
  if (r.status === 429) return true;
  return /1302|429|rate|限流|too many|quota|配额/i.test(r.body || '');
}

/**
 * 探一把 Key：从 1 并发逐档往上加，失败即停。
 * @returns {{limit:number, tested:number, reason:string, results:Array, fatal:boolean}}
 *   limit 语义 = "**已知**能跑通的最高并发"（失败档的前一档，至少 1）
 */
async function probeKey({ baseUrl, apiKey, model, max = 4, oneCall = defaultOneCall } = {}) {
  const results = [];
  let limit = 1;
  let reason = '未能完成任何一档（检查网络/Key）';
  if (!baseUrl || !apiKey || !model) {
    return { limit: 1, tested: 0, reason: '缺少 baseUrl/model/apiKey', results, fatal: true };
  }
  for (let n = 1; n <= max; n++) {
    let out;
    try {
      // 这里的并发就是被测对象本身（要制造 n 路同时在途才能知道服务商放不放行），必须绕过调度器
      out = await Promise.all(Array.from({ length: n }, (_, i) => oneCall({ baseUrl, apiKey, model, tag: `n${n}-${i}` }))); // lint-allow: 并发量即被测对象，见上一行说明
    } catch (e) {
      results.push({ n, ok: false, error: e.message });
      return { limit, tested: n, reason: `请求异常：${e.message}`, results, fatal: true };
    }
    const bad = out.filter((r) => !r.ok);
    if (bad.length) {
      const rl = bad.some(isRateLimited);
      results.push({ n, ok: false, status: bad[0].status, rateLimited: rl, body: (bad[0].body || '').slice(0, 120) });
      return { limit, tested: n, reason: rl ? `并发 ${n} 触发限流（这就是额度边界）` : `并发 ${n} 返回 HTTP ${bad[0].status}`, results, fatal: rl };
    }
    const ms = out.map((r) => r.ms).sort((a, b) => a - b);
    results.push({ n, ok: true, wallMs: Math.max(...out.map((r) => r.ms)), p50: ms[Math.floor(ms.length / 2)] });
    limit = n;
    reason = `探到 ${n} 并发全部成功`;
  }
  if (limit >= max) reason = `探到本次上限 ${max} 并发全部成功（可能还能更高，用 --max 加大再试）`;
  return { limit, tested: results.length, reason, results, fatal: false };
}

/** 探所有 Key（串行：同一账号的多把 Key 会互相干扰，逐把探结论才干净） */
async function probeKeys(cfg, { max = 4, keys = null, oneCall = defaultOneCall } = {}) {
  const list = keys && keys.length ? keys : [cfg.apiKey].filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const r = await probeKey({ baseUrl: cfg.baseUrl, apiKey: list[i], model: cfg.fastModel || cfg.model, max, oneCall });
    out.push({ index: i, key: mask(list[i]), ...r });
  }
  return out;
}

function mask(k) {
  const s = String(k || '');
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

module.exports = { probeKey, probeKeys, isRateLimited, defaultOneCall, mask };
