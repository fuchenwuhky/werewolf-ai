/**
 * llm.js — OpenAI 兼容聊天客户端（零依赖，内置 fetch）
 * - 单并发：所有请求经 scheduler 的唯一串行通道发出（1 Key = 1 并发）
 * - 流式：stream:true + SSE 增量解析（大幅降低"感知延迟"，同一条请求零额外并发）
 * - 错误分类：瞬时限流退避重试 / 配额与套餐致命（交由上层暂停对局）
 * - 自动重试（网络错误/429/5xx）、思考耗尽预算翻倍
 * - 遥测：prompt/cached/completion tokens、延迟、TTFT、重试次数
 */
'use strict';
const { scheduler: defaultScheduler, PRIORITY } = require('./scheduler');
const { LlmFatalError } = require('../errors');
const { parseApiKeys } = require('../config');

function buildEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  if (u.endsWith('/chat/completions')) return u;
  return u + '/chat/completions';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 思考模型的 reasoning 计入输出上限：截断时预算 ×4 连续放大，直到此硬上限
const HARD_OUTPUT_CAP = 32768;

// ---------- 流式支持级别（进程级自适应，避免整局失去流式能力） ----------
// 'usage'：stream + stream_options.include_usage（拿得到 token 用量）
// 'plain'：stream 但不带 stream_options（用量改为估算）
// 'off'  ：服务商不支持流式 → 退回非流式
let streamMode = 'usage';
/** 测试用：重置自适应级别 */
function resetStreamMode() { streamMode = 'usage'; }
function currentStreamMode() { return streamMode; }

// ---------- 结构化输出级别（同样自适应） ----------
// 'json_schema'：服务商支持严格 Schema（target 用 enum 约束，非法目标在结构上就不可能）
// 'json_object'：只保证是合法 JSON，语义约束仍靠提示词 + 事后校验
// 'off'        ：服务商不支持 response_format → 纯提示词模式
let structuredMode = 'json_schema';
function resetStructuredMode() { structuredMode = 'json_schema'; }
function currentStructuredMode() { return structuredMode; }

// ---------- 服务商错误分类：区分"等两秒重试"与"重试也没用" ----------
// 瞬时限流 → 退避重试（1302 已达速率限制 / 1305 模型访问量过大）
const TRANSIENT_BIZ_CODES = new Set(['1302', '1305']);
// 配额耗尽 → 重试无意义，必须暂停对局等待重置（1308 用量上限 / 1310 周月上限 / 1316~1321 各档上限 / 1113 欠费）
const QUOTA_BIZ_CODES = new Set(['1113', '1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']);
// 套餐与合规 → 需人工处理（1309 套餐到期 / 1311 未开放该模型 / 1313 使用模式不符合公平使用策略 / 1315 Key 类型不符）
const POLICY_BIZ_CODES = new Set(['1309', '1311', '1313', '1315']);

/** 从响应体里取业务错误码（兼容 {error:{code}} 与 {code} 两种形态） */
function parseBusinessError(text) {
  try {
    const j = JSON.parse(text);
    const e = j && j.error;
    if (e && typeof e === 'object' && (e.code != null || e.type != null || e.message != null)) {
      return { code: String(e.code != null ? e.code : (e.type || '')), message: String(e.message || '') };
    }
    if (j && j.code != null) return { code: String(j.code), message: String(j.message || '') };
  } catch (_) { /* 非 JSON 响应体（如网关 HTML 错误页） */ }
  return { code: '', message: '' };
}

/** 从"您的限额将在 X 重置"里提取重置时间，供前端展示 */
function parseFlushTime(message) {
  const m = String(message || '').match(/将在\s*([^，。；]+?)\s*重置/);
  return m ? m[1].trim() : null;
}

/** 尊重 Retry-After（秒数或 HTTP-date） */
function parseRetryAfter(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? Math.max(0, ts - Date.now()) : null;
}

/**
 * "连接在池子里放死了"这一类错误的 errno：
 * 服务端/防火墙把空闲连接掐断后，复用的那一次会被本地立刻感知为 socket 已死。
 * 这类错误**重试几乎必定立刻成功**，所以不该像限流那样退避等待——直接重试。
 */
const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_SOCKET_CLOSED']);
let connErrorCount = 0;     // 复用连接出问题的次数（keepAlive 打开后用它判断是否该回退）
let connErrorWarned = false;

/** 取 fetch 失败的最底层 errno（undici 把真实原因放在 err.cause 里，可能嵌套一层） */
function errnoOf(err) {
  let e = err;
  for (let i = 0; i < 4 && e; i++) {
    if (e.code) return String(e.code);
    e = e.cause;
  }
  return '';
}

/** 本次失败是否属于"复用连接已死"（重试应立即进行，无需退避） */
function isStaleSocketError(err) {
  return STALE_SOCKET_CODES.has(errnoOf(err));
}

/**
 * 退避时长（纯函数，便于测试）：
 *  - 服务商给了 Retry-After 就听它的（上限 120s）
 *  - 否则平方退避 × 抖动（0.7~1.3），避免多客户端退避同步撞点
 *  - `noBackoff`（降级重试 / 死连接重试）立即返回 0
 * @param rand 注入随机源，默认 Math.random（测试用）
 */
function backoffMs({ attempt, retryAfterMs = null, noBackoff = false, rand = Math.random }) {
  if (noBackoff) return 0;
  if (retryAfterMs != null) return Math.min(retryAfterMs, 120000);
  const base = 800 * attempt * attempt; // 0.8s, 3.2s
  return Math.round(base * (0.7 + rand() * 0.6));
}

/**
 * 把一次失败翻译成处置决定。
 * @returns {{retryable:boolean, fatal:boolean, kind?:string, code:string, message:string,
 *            nextFlushTime?:string|null, retryAfterMs?:number|null}}
 */
function classifyFailure(status, text, headers) {
  const biz = parseBusinessError(text);
  const code = biz.code;
  if (QUOTA_BIZ_CODES.has(code)) {
    return {
      retryable: false, fatal: true, kind: 'quota', code,
      message: biz.message || `账户配额已用尽（业务码 ${code}）`,
      nextFlushTime: parseFlushTime(biz.message),
    };
  }
  if (POLICY_BIZ_CODES.has(code)) {
    return {
      retryable: false, fatal: true, kind: 'policy', code,
      message: biz.message || `套餐/权限受限（业务码 ${code}）`,
      nextFlushTime: null,
    };
  }
  if (TRANSIENT_BIZ_CODES.has(code)) {
    return {
      retryable: true, fatal: false, code,
      message: biz.message || `触发速率限制（业务码 ${code}）`,
      retryAfterMs: parseRetryAfter(headers),
    };
  }
  // 鉴权失败：配置问题，重试无意义，也不该降级成烂棋
  if (status === 401 || status === 403) {
    return {
      retryable: false, fatal: true, kind: 'policy', code,
      message: biz.message || `鉴权/权限失败（HTTP ${status}），请检查 API Key 与模型权限`,
      nextFlushTime: null,
    };
  }
  return {
    retryable: status === 429 || status >= 500, fatal: false, code,
    message: biz.message || `HTTP ${status}`,
    retryAfterMs: parseRetryAfter(headers),
  };
}

// ---------- 用量归一化 ----------
function normalizeUsage(u) {
  const usage = u || {};
  return {
    promptTokens: usage.prompt_tokens || 0,
    cachedTokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
    completionTokens: usage.completion_tokens || 0,
    estimated: false,
  };
}

/** 中文为主文本的 token 估算（服务商未回流 usage 时兜底，标记 estimated 以便统计时甄别） */
function estimateTokensOf(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 1.5);
}
function estimateUsage(messages, content, reasoning) {
  let pt = 0;
  for (const m of messages || []) {
    const c = m && m.content;
    if (typeof c === 'string') pt += estimateTokensOf(c);
    else if (Array.isArray(c)) for (const part of c) pt += estimateTokensOf(part && part.text);
  }
  return {
    promptTokens: pt,
    cachedTokens: 0,
    completionTokens: estimateTokensOf(content) + estimateTokensOf(reasoning),
    estimated: true,
  };
}

/** 收尾 reasoning：空则 null，过长截断（与既有行为一致） */
function finalizeReasoning(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 6000) : null;
}

/**
 * 消费 SSE 流：逐块解析 data: 行，累积 content / reasoning_content 并回调增量。
 * @param startedAt 请求发出时刻：TTFT 必须从"发出"算起，而不是从 fetch resolve 算起
 *   （服务端可能延迟冲刷响应头，那样会把首字延迟算成 0）
 * 返回 {content, reasoning, usage, finishReason, ttftMs, error}
 */
async function consumeSse(res, onDelta, startedAt) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let ttftMs = null;
  let errorPayload = null;
  const t0 = Number.isFinite(startedAt) ? startedAt : Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;          // SSE 注释/心跳
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch (_) { continue; }
      if (j.error) { errorPayload = j.error; continue; }
      if (j.usage) usage = j.usage;
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      const d = ch.delta || ch.message || {};
      const dc = typeof d.content === 'string' ? d.content : '';
      const rawR = d.reasoning_content != null ? d.reasoning_content : d.reasoning;
      const dr = typeof rawR === 'string' ? rawR : '';
      if (dc || dr) {
        if (ttftMs == null) ttftMs = Date.now() - t0;
        content += dc;
        reasoning += dr;
        if (onDelta) { try { onDelta({ content: dc, reasoning: dr }); } catch (_) { /* 回调异常不得影响请求 */ } }
      }
    }
  }
  return { content, reasoning, usage, finishReason, ttftMs, error: errorPayload };
}

/**
 * @param {object} opts {logger, meta, effort, maxTokens, signal, priority, scheduler, onDelta, stream}
 *   - effort/maxTokens：单次调用级覆盖（如按任务分层思考强度），缺省回落 cfg
 *   - signal：外部中止信号（终止对局时立即中断在途请求，不重试）
 *   - priority：队列优先级（PRIORITY.decision/reflection/lesson），缺省 decision
 *   - scheduler：覆盖默认单例（测试用）
 *   - onDelta：流式增量回调 {content, reasoning}（不传则整段返回；传了才真正开启流式）
 *   - stream：强制开关流式（缺省 cfg.stream !== false）
 *   - hardCap：思考耗尽时"预算翻倍"的上限（缺省 32768）；不设它则 maxTokens 形同虚设
 *   - responseFormat：结构化输出约束（schemas.schemaFor 产出）；是否真正下发由
 *     cfg.structuredOutput 与进程级自适应级别决定
 * @returns {content, reasoning, usage, latencyMs, ttftMs, attempts, streamed}
 */
async function chatCompletion(cfg, messages, { logger, meta = {}, effort, maxTokens, model, timeoutMs: callTimeoutMs, signal, priority, scheduler: sched, onDelta, stream, hardCap, responseFormat } = {}) {
  const endpoint = buildEndpoint(cfg.baseUrl);
  // 分层模型（A2）：调用方可为快速任务指定更小的模型，缺省回落 cfg.model
  const useModel = model || cfg.model;
  const maxRetries = cfg.retries != null ? cfg.retries : 3;
  // 分任务软超时（A3）：调用方可按任务压死上限。360s 的 cfg.timeoutMs 只作兜底 ——
  // 过去的用法是"所有任务都可能等 6 分钟"，一次卡住的发言就能让整局看起来死掉。
  const timeoutMs = Number(callTimeoutMs) > 0 ? Number(callTimeoutMs) : (cfg.timeoutMs || 120000);
  const baseMaxTokens = maxTokens || cfg.maxTokens || 16000;
  // 预算翻倍的硬上限：调用方可按任务档位压低（结构化决策不需要 32k 的思考空间）
  const escalationCap = Number(hardCap) > 0 ? Math.max(Number(hardCap), baseMaxTokens) : HARD_OUTPUT_CAP;
  if (signal && signal.aborted) {
    const err = new Error('对局已终止，请求未发出');
    err.aborted = true;
    throw err;
  }

  const body = {
    model: useModel,
    messages,
    temperature: cfg.temperature != null ? cfg.temperature : 0.8,
    max_tokens: baseMaxTokens,
  };
  const eff = effort != null ? effort : cfg.reasoningEffort;
  if (eff) body.reasoning_effort = eff;

  // 只有调用方真的消费增量时才走流式：
  // 流式的价值在于实时反馈（前端"打字中"、上帝视角独白直播）；
  // 无人消费增量时用非流式更简单，且能拿到服务商精确回流的 token 用量。
  const wantStream = (stream != null ? !!stream : cfg.stream !== false) && typeof onDelta === 'function';
  // 结构化输出：'off' 从不下发；'json_schema' 为强制（不降级，失败即暴露配置问题）
  const structPolicy = cfg.structuredOutput || 'auto';
  const structForced = structPolicy === 'json_schema';
  const structEnabled = structPolicy !== 'off' && !!responseFormat;
  const lane = sched || defaultScheduler;
  const label = meta.label || 'chat';
  // Key 池（keypool）：调度器给每个在途任务分配一个槽位，槽位 i 固定绑定第 i 个 Key ——
  // 同一条通道的连续请求打同一个 Key，服务商侧的 prompt 缓存才不会因为换 Key 而全部落空。
  const apiKeys = parseApiKeys(cfg);
  // 通道数 = Key 数（自动跟随配置，允许运行中改）：单 Key 时恒为 1，行为与旧版一致。
  // 放在这里而不是启动时同步，是为了避免"配置从哪条路径进来"的时序问题（设置页/环境变量/存档恢复）。
  if (lane === defaultScheduler) {
    const want = Math.max(1, apiKeys.length);
    if (lane.channels !== want) lane.setChannels(want);
  }
  let usageEstimatedWarned = false;

  // 整段"重试 + 退避"都在通道内执行：单并发下退避期间也不该放别的请求出去，
  // 否则等于自己在服务商侧制造并发。
  const job = async (slot = 0) => {
    // 槽位 ↦ Key：单 Key（默认）时恒等于 cfg.apiKey，多 Key 时每个通道打自己的 Key。
    const apiKey = apiKeys.length > 1 ? apiKeys[slot % apiKeys.length] : (apiKeys[0] || cfg.apiKey);
    if (signal && signal.aborted) {
      const err = new Error('对局已终止，请求取消');
      err.aborted = true;
      throw err;
    }
    let attempts = 0;
    let lastErr = null;
    let tokenBudget = baseMaxTokens;
    // A3 降档重试：超时/截断时**先降思考强度**（minimal）再试，而不是原样重试或直接翻倍预算。
    // 理由：这两类失败的根因都是"模型在思考里绕太久"，把 effort 压到最低比给更多预算更快也更省；
    // 只有降档后仍被截断（说明是正文太长而非思考太长）才回退到旧的"翻倍预算"路径。
    let curEffort = eff;
    let downgraded = false;
    // 流式协议降级（usage→plain→off）不计入用户的重试预算：
    // 那是协议适配而非失败重试，否则 retries:0 的用户会直接失败而不是优雅降级。
    let streamDown = 0;
    let structDown = 0;
    while (attempts <= maxRetries) {
      attempts++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      // 外部中止（终止对局）：转发到本次请求的 ctrl；超时 abort 与外部 abort 共用同一信号
      let onExternalAbort = null;
      if (signal) {
        onExternalAbort = () => ctrl.abort();
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const t0 = Date.now();
      const useStream = wantStream && streamMode !== 'off';
      try {
        const payload = { ...body, max_tokens: tokenBudget };
        // 降档后按调用级覆盖 effort（body 里的 reasoning_effort 是初始档位）
        if (curEffort !== eff) {
          if (curEffort) payload.reasoning_effort = curEffort;
          else delete payload.reasoning_effort;
        }
        if (useStream) {
          payload.stream = true;
          if (streamMode === 'usage') payload.stream_options = { include_usage: true };
        }
        // 结构化输出：按当前自适应级别下发（json_object 级别只保证"是合法 JSON"）
        let rf = null;
        if (structEnabled && structuredMode !== 'off') {
          rf = structuredMode === 'json_object' ? { type: 'json_object' } : responseFormat;
          payload.response_format = rf;
        }
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            // keep-alive 默认开：实测串行 5 次调用从"5 条连接"降到"1 条"，省掉每次约 90ms 的 TCP+TLS 握手。
            // 曾经的顾虑是"Windows 下复用长连接会被防火墙静默掐断"，现在由两道保险兜住：
            //   ① keepAlive:false 可一键回到旧行为（发 Connection: close）；
            //   ② 复用连接已死（ECONNRESET/EPIPE）时**不退避、立刻重试**，并把次数记进遥测。
            ...(cfg.keepAlive === false ? { Connection: 'close' } : {}),
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const text = await res.text();
          // 服务商不支持流式参数：自适应降级后重试一次，避免整局失去流式能力
          if (useStream && (res.status === 400 || res.status === 422) && streamMode !== 'off' && streamDown < 2) {
            streamDown++;
            attempts--; // 降级不消耗重试预算
            const next = streamMode === 'usage' ? 'plain' : 'off';
            streamMode = next;
            if (logger) {
              logger.warn('llm', `${label} 流式请求被拒（HTTP ${res.status}）→ 降级为${next === 'off' ? '非流式' : '不带 stream_options 的流式'}并重试`, { task: meta.task, seat: meta.seat });
            }
            const derr = new Error(`流式不可用，降级重试（HTTP ${res.status}）`);
            derr.retryable = true;
            derr.noBackoff = true;
            throw derr;
          }
          // 服务商不支持该结构化输出级别：json_schema → json_object → off 逐级降级
          if (rf && (res.status === 400 || res.status === 422) && !structForced && structuredMode !== 'off' && structDown < 2) {
            structDown++;
            attempts--; // 降级不消耗重试预算
            const next = structuredMode === 'json_schema' ? 'json_object' : 'off';
            structuredMode = next;
            if (logger) {
              logger.warn('llm', `${label} 结构化输出被拒（HTTP ${res.status}）→ 全局降级为 ${next === 'off' ? '纯提示词模式' : 'json_object'}并重试`, { task: meta.task, seat: meta.seat });
            }
            const derr = new Error(`结构化输出级别不可用，降级重试（HTTP ${res.status}）`);
            derr.retryable = true;
            derr.noBackoff = true;
            throw derr;
          }
          const cls = classifyFailure(res.status, text, res.headers);
          if (cls.fatal) {
            if (logger) logger.error('llm', `${label} 致命错误（${cls.kind}/${cls.code}）：${cls.message}`, { task: meta.task, seat: meta.seat });
            const fatal = new LlmFatalError(cls);
            fatal.status = res.status;
            throw fatal;
          }
          const err = new Error(`LLM HTTP ${res.status}: ${(cls.message || text).slice(0, 500)}`);
          err.retryable = cls.retryable;
          err.status = res.status;
          err.retryAfterMs = cls.retryAfterMs;
          throw err;
        }

        // ---- 流式 / 非流式两条路径，统一产出 content / reasoning / usage / finishReason ----
        if (useStream && (!res.body || typeof res.body.getReader !== 'function')) {
          // 网关/代理把响应体改造过，读不到流：全局退回非流式（只发生一次）
          streamMode = 'off';
          attempts--; // 协议降级不消耗重试预算
          if (logger) logger.warn('llm', `${label} 响应无可读流（可能被网关改造）→ 全局退回非流式`);
          const derr = new Error('响应不支持流式读取，退回非流式重试');
          derr.retryable = true;
          derr.noBackoff = true;
          throw derr;
        }
        let content = '';
        let reasoning = '';
        let usage = null;
        let finishReason = null;
        let ttftMs = null;
        if (useStream) {
          const s = await consumeSse(res, onDelta, t0);
          if (s.error) {
            const cls = classifyFailure(res.status, JSON.stringify({ error: s.error }), res.headers);
            if (cls.fatal) throw new LlmFatalError(cls);
            const err = new Error(`LLM 流式错误（${cls.code}）：${cls.message.slice(0, 300)}`);
            err.retryable = cls.retryable;
            err.retryAfterMs = cls.retryAfterMs;
            throw err;
          }
          content = s.content;
          reasoning = s.reasoning;
          usage = s.usage;
          finishReason = s.finishReason;
          ttftMs = s.ttftMs;
        } else {
          const data = await res.json();
          // 有的服务商把限流/配额错误放在 HTTP 200 的响应体里：同样按业务码处置
          if (data && data.error) {
            const cls = classifyFailure(res.status, JSON.stringify(data), res.headers);
            if (cls.fatal) {
              if (logger) logger.error('llm', `${label} 致命错误（HTTP 200 + ${cls.kind}/${cls.code}）：${cls.message}`, { task: meta.task, seat: meta.seat });
              throw new LlmFatalError(cls);
            }
            const err = new Error(`LLM 响应体错误（HTTP ${res.status} ${cls.code}）：${cls.message.slice(0, 300)}`);
            err.retryable = cls.retryable;
            err.retryAfterMs = cls.retryAfterMs;
            throw err;
          }
          const choice = data.choices && data.choices[0];
          content = (choice && choice.message && choice.message.content) || '';
          const rawReasoning = choice && choice.message && (choice.message.reasoning_content || choice.message.reasoning);
          reasoning = typeof rawReasoning === 'string' ? rawReasoning : '';
          finishReason = choice && choice.finish_reason;
          usage = data.usage;
        }

        // 服务商返回成功但没有可用回复 → 明确报错并记录可诊断信息
        if (typeof content !== 'string' || !content.trim()) {
          // ① 先降档：思考模型把预算全花在 reasoning 上（finish_reason=length），
          //    压到 minimal 通常一次就够，且比翻倍预算更快（A3 实测：这一步就能救回绝大多数截断）
          if (finishReason === 'length' && !downgraded && baseMaxTokens < escalationCap) {
            downgraded = true;
            const fromEffort = curEffort;
            curEffort = 'minimal';
            tokenBudget = Math.min(Math.max(Math.round(baseMaxTokens * 1.5), 1000), escalationCap);
            if (logger) logger.warn('llm', `${label} 回复被截断（思考耗尽）→ 降档重试（effort ${fromEffort || '默认'}→minimal，预算 ${baseMaxTokens}→${tokenBudget}）`, { task: meta.task, seat: meta.seat });
            const err = new Error('max_tokens 被思考耗尽，降档重试');
            err.retryable = true;
            err.noBackoff = true;
            err.downgraded = true;
            throw err;
          }
          // ② 降档后仍被截断 → 说明是正文本身太长，这时才回退到"逐步翻倍预算"
          if (finishReason === 'length' && tokenBudget < escalationCap) {
            const from = tokenBudget;
            tokenBudget = Math.min(Math.max(tokenBudget, 1000) * 2, escalationCap);
            if (logger) logger.warn('llm', `${label} 回复被截断（降档后仍不足，预算 ${from}）→ 提升至 ${tokenBudget} 重试`, { task: meta.task, seat: meta.seat });
            const err = new Error(`max_tokens 不足（思考耗尽），预算 ${from} → ${tokenBudget}`);
            err.retryable = true;
            err.noBackoff = true; // 提升预算重试无需退避等待
            throw err;
          }
          if (finishReason === 'length') {
            const err = new Error(`已达最大输出预算 ${tokenBudget} 仍被思考耗尽（模型无法收敛到答案），请调大 max_tokens 或更换模型`);
            err.retryable = false;
            throw err;
          }
          const err = new Error(`LLM 响应异常：HTTP ${res.status} 但没有可用的回复内容，请检查 base_url/model/apiKey 是否正确（finish_reason=${finishReason}）`);
          err.retryable = false;
          throw err;
        }

        // 用量：流式且服务商未回流 usage 时估算兜底（只告警一次，避免刷屏）
        if (!usage) {
          usage = estimateUsage(messages, content, reasoning);
          if (!usageEstimatedWarned && logger) {
            usageEstimatedWarned = true;
            logger.warn('llm', `${label} 流式响应未返回 token 用量 → 本局改用估算值（统计仅供参考）`);
          }
        } else {
          usage = normalizeUsage(usage);
        }

        // 调用总耗时：从请求发出到本次回复完整拿到（流式 = 流读完），
        // 这样上帝面板的耗时统计里流式与非流式口径一致。
        const latencyMs = Date.now() - t0;
        const out = {
          content,
          reasoning: finalizeReasoning(reasoning),
          usage,
          latencyMs,
          ttftMs,
          attempts,
          streamed: useStream,
          downgraded, // A3：这次调用是否发生过"降档重试"（上帝面板/遥测用）
        };
        if (logger) {
          logger.debug('llm', `${label} ok ${out.usage.promptTokens}pt(缓存${out.usage.cachedTokens})/${out.usage.completionTokens}ct ${latencyMs}ms${ttftMs != null ? ` 首字${ttftMs}ms` : ''} 尝试${attempts}${useStream ? ' 流式' : ''}`, {
            model: useModel, task: meta.task, seat: meta.seat,
          });
        }
        return out;
      } catch (err) {
        clearTimeout(timer);
        if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
        lastErr = err;
        const externalAbort = !!(signal && signal.aborted); // 外部终止 ≠ 超时：立即退出不重试
        const timedOut = !externalAbort && err.name === 'AbortError';
        if (timedOut) err.timedOut = true; // 让上层能区分"超时"与"服务端报错"
        // 超时先降档（A3）：原样重试大概率再等一个软超时，把 p99 拖成两三倍；压到 minimal 往往能过。
        if (timedOut && !downgraded && attempts <= maxRetries) {
          downgraded = true;
          const fromEffort = curEffort;
          curEffort = 'minimal';
          tokenBudget = Math.min(Math.max(Math.round(baseMaxTokens * 0.6), 800), escalationCap);
          if (logger) logger.warn('llm', `${label} 请求超时（${Math.round(timeoutMs / 1000)}s）→ 降档重试（effort ${fromEffort || '默认'}→minimal，预算→${tokenBudget}）`, { task: meta.task, seat: meta.seat });
          continue; // 不等待退避：降档本身就是换一种打法，退避只是白等
        }
        const retryable = !externalAbort && (err.retryable || err.name === 'AbortError' || err.name === 'TypeError');
        const msg = externalAbort ? '对局已终止，请求被中止'
          : err.name === 'AbortError' ? `请求超时（${Math.round(timeoutMs / 1000)}s，思考/生成未完成被中止）` : err.message;
        if (logger) logger.warn('llm', `${label} 第${attempts}次失败：${msg}`, { task: meta.task, seat: meta.seat, retryable });
        if (externalAbort) {
          lastErr = new Error('对局已终止，请求被中止');
          lastErr.aborted = true;
          break;
        }
        if (!retryable || attempts > maxRetries) break;
        // 死连接（复用连接被掐断）：立即重试，不退避——退避 0.8s 纯属白等，重试基本必然成功
        const stale = isStaleSocketError(err);
        if (stale) {
          connErrorCount++;
          if (logger && !connErrorWarned) {
            connErrorWarned = true;
            logger.warn('llm', `${label} 复用连接已失效（${errnoOf(err)}）→ 立即重试。若频繁出现，可在设置中关闭 keep-alive（Connection: close 模式）`, { task: meta.task, seat: meta.seat });
          }
        }
        // 退避：优先尊重服务商的 Retry-After；否则平方退避 + 抖动
        //（抖动用于避免多客户端同时退避造成的同步撞点）
        if (!err.noBackoff) {
          const waitMs = backoffMs({ attempt: attempts, retryAfterMs: err.retryAfterMs, noBackoff: stale || !!err.noBackoff });
          if (waitMs > 0) await sleep(waitMs);
        }
      }
    }
    throw lastErr || new Error('LLM 调用失败');
  };

  return lane.enqueue(job, { priority: priority != null ? priority : PRIORITY.decision, label });
}

/** 测试连通性（设置页"测试连接"）：要求模型真实返回非空内容才算成功 */
async function testConnection(cfg, logger) {
  const t0 = Date.now();
  try {
    const out = await chatCompletion({ ...cfg, maxTokens: Math.max(cfg.maxTokens || 8000, 1000), temperature: 0, retries: 0 },
      [{ role: 'user', content: '请原样回复四个字：连接成功' }], { logger, meta: { label: '连接测试' }, stream: false });
    const reply = (out.content || '').trim();
    if (!reply) {
      return { ok: false, latencyMs: Date.now() - t0, error: '接口返回了空内容：base_url/model/apiKey 很可能配置不对' };
    }
    return { ok: true, latencyMs: Date.now() - t0, reply: reply.slice(0, 50), usage: out.usage };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err.message || err).slice(0, 500) };
  }
}

module.exports = {
  chatCompletion, testConnection, buildEndpoint, classifyFailure, parseBusinessError,
  currentStreamMode, resetStreamMode, currentStructuredMode, resetStructuredMode,
  // 退避/连接：导出纯函数与计数，便于测试与遥测
  backoffMs, parseRetryAfter, isStaleSocketError, connErrorStats, resetConnErrorStats,
};

/** keep-alive 相关的连接错误计数（上帝面板/日志用：判断本机是否该关掉复用） */
function connErrorStats() { return { count: connErrorCount, warned: connErrorWarned }; }
function resetConnErrorStats() { connErrorCount = 0; connErrorWarned = false; }
