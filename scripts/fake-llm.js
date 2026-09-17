#!/usr/bin/env node
/**
 * fake-llm.js — 本地假 LLM（OpenAI 兼容），把"服务商侧故障"变成确定性、零成本的测试对象。
 *
 * 为什么需要它：E1（预算用尽后的轻量补救）、E3（快速任务超时降档）、P1（看门狗误判）、
 * 配额暂停、校验失败重试 —— 这些路径全都依赖服务商侧的异常行为。真 API 要复现它们
 * 得靠运气（还得花钱），而这个 fake 一条命令就能精确注入。
 *
 * 已核实的对接细节（照它实现，保证"假得跟真的一样"）：
 *   · 端点：`{baseUrl}/chat/completions`；鉴权头 `Authorization: Bearer <key>`
 *   · 对局走 `stream:true` + `stream_options.include_usage`；连接测试走 `stream:false`
 *   · 用量取自最后一个 chunk 的 `usage`，缓存命中读 `prompt_tokens_details.cached_tokens`
 *   · 配额耗尽靠**业务码**判定：1308/1310/1316~1321（各档上限）、1113（欠费）
 *     且服务商有时把错误塞在 **HTTP 200 的响应体**里 —— 两种形态都要能造
 *
 * 用法：
 *   node scripts/fake-llm.js                       # 默认 ok 模式，端口 3212
 *   node scripts/fake-llm.js --mode=quota429
 *   node scripts/fake-llm.js --mode=slow-first-token --delay-ms=40000
 *   curl -X POST localhost:3212/__mode -d '{"mode":"truncated-json"}'   # 对局中途切换
 *   curl localhost:3212/__stats                                        # 累计服务次数
 *
 * 回复内容：从提示词里**抽取应用自己给出的 JSON 模板**再填值 —— 比硬编码每种任务的
 * schema 稳，任务改了也不会假错。填值用提示词里出现的座位号里最小的那个（确定性）。
 * 目标偶尔仍可能不合法（假模型不知道谁出局了），那会触发应用的校验重试 —— 这本身也是可观察行为。
 */
'use strict';
const http = require('http');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const PORT = Number(args.port || 3212);

const MODES = new Set([
  'ok', 'cached', 'no-cache', 'quota429', 'quota200', 'slow-first-token', 'slow-total',
  'truncated-json', 'bad-json', 'empty', 'http500', 'drop-mid-stream',
]);

const state = {
  mode: args.mode || 'ok',
  delayMs: Number(args['delay-ms'] || 40000),
  calls: 0,
  byMode: {},
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rough = (s) => Math.max(1, Math.round(String(s).length / 1.5)); // 粗略 token 估算

/** 从提示词里抽出应用自己写的 JSON 模板，并填成一份"看起来合理"的回复 */
function craftReply(prompt) {
  const text = String(prompt || '');
  // 1. 找提示词里形如 {"text":"…"} / {"target":0,…} 的模板（取最后一个，通常紧跟"只输出"）
  let template = null;
  for (const m of text.matchAll(/\{[^{}]{0,200}\}/g)) {
    if (/"[a-zA-Z_]+"\s*:/.test(m[0])) template = m[0];
  }
  // 2. 座位号：提示词里的候选座位（取最小，保证确定性）
  const seats = (text.match(/\b\d{1,2}\b/g) || []).map(Number).filter((n) => n >= 1 && n <= 24);
  const seat = seats.length ? Math.min(...seats) : 1;
  let body;
  if (template) {
    // 把模板里的值替换成可用的：字符串→一句短发言，数字→座位号，布尔→false
    body = template.replace(/"([a-zA-Z_]+)"\s*:\s*("([^"]*)"|\d+|true|false)/g, (all, key) => {
      if (/text|reason|speech|words|content|summary|claim/i.test(key)) return `"${key}":"（假模型）我按规则表态。"`;
      if (/target|seat|check|poison|save|kill|vote|guard|shoot|crush|curse|dream|charm/i.test(key)) return `"${key}":${seat}`;
      if (/explode|withdraw|antidote|agree|pass/i.test(key)) return `"${key}":false`;
      if (/lessons|tags|events|list|notes/i.test(key)) return `"${key}":["（假模型）保持简洁。"]`;
      return all;
    });
  } else {
    body = '{"text":"（假模型）我按规则表态。"}';
  }
  try { JSON.parse(body); } catch (_) { body = '{"text":"（假模型）我按规则表态。"}'; }
  return body;
}

function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function usageOf(prompt, content, cached) {
  const pt = rough(prompt) + 800; // 假装有系统提示词开销
  return {
    prompt_tokens: pt,
    completion_tokens: rough(content),
    total_tokens: pt + rough(content),
    prompt_tokens_details: { cached_tokens: cached ? Math.floor(pt * 0.9) : 0 },
  };
}

async function handleCompletions(req, res, bodyRaw) {
  state.calls++;
  state.byMode[state.mode] = (state.byMode[state.mode] || 0) + 1;
  const mode = state.mode;
  let payload = {};
  try { payload = JSON.parse(bodyRaw || '{}'); } catch (_) { /* 容忍坏请求体 */ }
  // 已核实：llm.js **只在流式时**写 payload.stream=true，非流式（连接测试）是省略该字段。
  // 所以判断必须是 === true，不能写成 !== false（那样非流式会被当成流式，连接测试收到 SSE）。
  const stream = payload.stream === true;
  const prompt = (payload.messages || []).map((m) => m.content).join('\n');
  const reply = craftReply(prompt);
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ---- 故障注入 ----
  if (mode === 'quota429') {
    // 真实抓到的原文（业务码 1113 = 欠费/无可用资源包）
    return json(429, { code: '1113', message: '余额不足或无可用资源包,请充值。' });
  }
  if (mode === 'http500') return json(500, { error: { message: 'fake upstream 500' } });
  if (mode === 'quota200') {
    // 有的服务商把错误塞在 HTTP 200 的响应体里 —— 应用必须也能识别
    if (!stream) return json(200, { code: '1308', message: '当前用量已达套餐上限' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, { code: '1308', message: '当前用量已达套餐上限' });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  if (mode === 'slow-first-token') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': keep-alive\n\n'); // 先给注释行，避免连接被判定为空闲
    await sleep(state.delayMs);
    sse(res, { choices: [{ delta: { content: reply } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: usageOf(prompt, reply, false) });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (!stream) {
    // 连接测试（stream:false）
    return json(200, {
      choices: [{ message: { role: 'assistant', content: mode === 'bad-json' ? '这不是 JSON' : reply }, finish_reason: 'stop' }],
      usage: usageOf(prompt, reply, mode === 'cached'),
    });
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const cached = mode === 'cached';
  if (mode === 'empty') {
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: usageOf(prompt, '', cached) });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  const content = mode === 'bad-json' ? '这不是 JSON' : mode === 'truncated-json' ? reply.slice(0, Math.max(4, Math.floor(reply.length / 2))) : reply;
  const chunks = content.match(/[\s\S]{1,24}/g) || [content];
  const perChunk = mode === 'slow-total' ? Math.ceil(35000 / Math.max(1, chunks.length)) : 0;
  for (let i = 0; i < chunks.length; i++) {
    if (mode === 'drop-mid-stream' && i === 2) {
      res.destroy(); // 传了两块就断线：模拟上游连接被掐
      return undefined;
    }
    sse(res, { choices: [{ delta: { content: chunks[i] } }] });
    if (perChunk) await sleep(perChunk);
  }
  sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: usageOf(prompt, content, cached) });
  res.write('data: [DONE]\n\n');
  return res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = (req.url || '').split('?')[0];
    try {
      if (url === '/__mode' && req.method === 'POST') {
        const j = JSON.parse(body || '{}');
        if (j.mode && !MODES.has(j.mode)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `未知模式 ${j.mode}`, modes: [...MODES] }));
        }
        if (j.mode) state.mode = j.mode;
        if (j.delayMs) state.delayMs = Number(j.delayMs);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, mode: state.mode, delayMs: state.delayMs }));
      }
      if (url === '/__stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ calls: state.calls, byMode: state.byMode, mode: state.mode }));
      }
      if (url === '/__ping' || url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(url === '/v1/models' ? { data: [{ id: 'fake-model' }] } : { ok: true, mode: state.mode }));
      }
      if (url.endsWith('/chat/completions') && req.method === 'POST') {
        return void (await handleCompletions(req, res, body));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found', url }));
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message) }));
      } catch (_) { /* 已经发过响应头 */ }
      return undefined;
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fake-llm 已启动：http://127.0.0.1:${PORT}/v1  （模式 ${state.mode}，可用 ${[...MODES].join('/')}）\n`);
  process.stdout.write(`切换：POST /__mode {"mode":"…"}   统计：GET /__stats\n`);
});
