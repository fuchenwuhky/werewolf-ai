/**
 * llm.js — OpenAI 兼容聊天客户端（零依赖，内置 fetch）
 * - 自动重试（网络错误/429/5xx）
 * - 遥测：prompt/cached/completion tokens、延迟、重试次数（进 logger + game.llmStats）
 * - 缓存策略：配合 agent 的"追加式消息数组"命中服务商前缀缓存；
 *   可选 cacheControl:true 时给 system 消息加显式 cache_control 标记（部分服务商需要）
 */
'use strict';

function buildEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  if (u.endsWith('/chat/completions')) return u;
  return u + '/chat/completions';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 思考模型的 reasoning 计入输出上限：截断时预算 ×4 连续放大，直到此硬上限
const HARD_OUTPUT_CAP = 32768;

/**
 * @param {object} opts {logger, meta, effort, maxTokens, signal}
 *   - effort/maxTokens：单次调用级覆盖（如按任务分层思考强度），缺省回落 cfg
 *   - signal：外部中止信号（终止对局时立即中断在途请求，不重试）
 * @returns {content, usage:{promptTokens, cachedTokens, completionTokens}, latencyMs, attempts}
 */
async function chatCompletion(cfg, messages, { logger, meta = {}, effort, maxTokens, signal } = {}) {
  const endpoint = buildEndpoint(cfg.baseUrl);
  const maxRetries = cfg.retries != null ? cfg.retries : 3;
  const timeoutMs = cfg.timeoutMs || 120000;
  const baseMaxTokens = maxTokens || cfg.maxTokens || 16000;
  if (signal && signal.aborted) {
    const err = new Error('对局已终止，请求未发出');
    err.aborted = true;
    throw err;
  }

  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature != null ? cfg.temperature : 0.8,
    max_tokens: baseMaxTokens,
  };
  const eff = effort != null ? effort : cfg.reasoningEffort;
  if (eff) body.reasoning_effort = eff;

  let attempts = 0;
  let lastErr = null;
  let tokenBudget = baseMaxTokens;
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
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          Connection: 'close', // 禁用 keep-alive：Windows 下复用长连接会被防火墙静默掐断，造成突发 "fetch failed"
        },
        body: JSON.stringify({ ...body, max_tokens: tokenBudget }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 500);
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(`LLM HTTP ${res.status}: ${errText}`);
        err.retryable = retryable;
        throw err;
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      const content = choice && choice.message && choice.message.content;
      // 服务商返回 200 但没有可用回复 → 明确报错并记录原始响应体
      if (!choice || typeof content !== 'string' || !content.trim()) {
        // 思考模型把 max_tokens 全花在 reasoning 上（finish_reason=length）→ 预算逐步翻倍直至硬上限
        if (choice && choice.finish_reason === 'length' && tokenBudget < HARD_OUTPUT_CAP) {
          const from = tokenBudget;
          tokenBudget = Math.min(Math.max(tokenBudget, 1000) * 2, HARD_OUTPUT_CAP);
          if (logger) logger.warn('llm', `${meta.label || 'chat'} 回复被截断（思考耗尽，预算 ${from}）→ 提升至 ${tokenBudget} 重试`, { task: meta.task, seat: meta.seat });
          const err = new Error(`max_tokens 不足（思考耗尽），预算 ${from} → ${tokenBudget}`);
          err.retryable = true;
          err.noBackoff = true; // 提升预算重试无需退避等待
          throw err;
        }
        if (choice && choice.finish_reason === 'length') {
          const err = new Error(`已达最大输出预算 ${tokenBudget} 仍被思考耗尽（模型无法收敛到答案），请调大 max_tokens 或更换模型`);
          err.retryable = false;
          throw err;
        }
        const snippet = JSON.stringify(data).slice(0, 400);
        const err = new Error(`LLM 响应异常：HTTP ${res.status} 但没有可用的回复内容，请检查 base_url/model/apiKey 是否正确。原始响应：${snippet}`);
        err.retryable = false;
        throw err;
      }
      const usage = data.usage || {};
      const out = {
        content,
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          cachedTokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
          completionTokens: usage.completion_tokens || 0,
        },
        latencyMs,
        attempts,
      };
      if (logger) {
        logger.debug('llm', `${meta.label || 'chat'} ok ${out.usage.promptTokens}pt(缓存${out.usage.cachedTokens})/${out.usage.completionTokens}ct ${latencyMs}ms 尝试${attempts}`, {
          model: cfg.model, task: meta.task, seat: meta.seat,
        });
      }
      return out;
    } catch (err) {
      clearTimeout(timer);
      if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
      lastErr = err;
      const externalAbort = !!(signal && signal.aborted); // 外部终止 ≠ 超时：立即退出不重试
      const retryable = !externalAbort && (err.retryable || err.name === 'AbortError' || err.name === 'TypeError');
      const msg = externalAbort ? '对局已终止，请求被中止'
        : err.name === 'AbortError' ? `请求超时（${Math.round(timeoutMs / 1000)}s，思考/生成未完成被中止）` : err.message;
      if (logger) logger.warn('llm', `${meta.label || 'chat'} 第${attempts}次失败：${msg}`, { task: meta.task, seat: meta.seat, retryable });
      if (externalAbort) {
        lastErr = new Error('对局已终止，请求被中止');
        lastErr.aborted = true;
        break;
      }
      if (!retryable || attempts > maxRetries) break;
      if (!err.noBackoff) await sleep(800 * attempts * attempts); // 0.8s, 3.2s
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

/** 测试连通性（设置页"测试连接"）：要求模型真实返回非空内容才算成功 */
async function testConnection(cfg, logger) {
  const t0 = Date.now();
  try {
    const out = await chatCompletion({ ...cfg, maxTokens: Math.max(cfg.maxTokens || 8000, 1000), temperature: 0, retries: 0 },
      [{ role: 'user', content: '请原样回复四个字：连接成功' }], { logger, meta: { label: '连接测试' } });
    const reply = (out.content || '').trim();
    if (!reply) {
      return { ok: false, latencyMs: Date.now() - t0, error: '接口返回了空内容：base_url/model/apiKey 很可能配置不对' };
    }
    return { ok: true, latencyMs: Date.now() - t0, reply: reply.slice(0, 50), usage: out.usage };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err.message || err).slice(0, 500) };
  }
}

module.exports = { chatCompletion, testConnection, buildEndpoint };
