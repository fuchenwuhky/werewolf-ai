'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatCompletion, testConnection, resetStreamMode, currentStreamMode } = require('../src/ai/llm');
const { LlmScheduler } = require('../src/ai/scheduler');
const { LlmFatalError } = require('../src/errors');

const cfg = { baseUrl: 'http://gateway.invalid/api/v1', apiKey: 'test-only-key', model: 'cline-pass/test-model', retries: 0, maxTokens: 2048 };
const completion = {
  choices: [{ finish_reason: 'stop', message: { content: '连接成功', reasoning: '检查完成' } }],
  usage: { prompt_tokens: 37, completion_tokens: 32, prompt_tokens_details: { cached_tokens: 12 } },
};
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function gateway(t, response) {
  const previous = global.fetch;
  const calls = [];
  resetStreamMode();
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { global.fetch = previous; resetStreamMode(); });
  return calls;
}
const chat = (options = {}) => chatCompletion(cfg, [{ role: 'user', content: '连接测试' }], { scheduler: new LlmScheduler(), ...options });

test('网关成功包：连接测试读出 data 内回复，保留指定模型与精确用量，不重复外呼', async (t) => {
  const calls = gateway(t, { success: true, data: completion });
  const result = await testConnection(cfg, silentLogger);
  assert.equal(result.ok, true);
  assert.equal(result.reply, '连接成功');
  assert.equal(result.usage.promptTokens, 37);
  assert.equal(result.usage.cachedTokens, 12);
  assert.equal(result.usage.completionTokens, 32);
  assert.equal(result.usage.estimated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, cfg.model);
});

test('标准 completion：顶层回复优先，不误取同名 data 字段', async (t) => {
  gateway(t, { ...completion, success: true, data: { choices: [{ message: { content: '错误的旁路数据' } }] } });
  const result = await chat();
  assert.equal(result.content, '连接成功');
  assert.equal(result.reasoning, '检查完成');
});

test('网关失败包：data 即使含回复也不能伪装成功，不重试烧额度', async (t) => {
  const calls = gateway(t, { success: false, data: completion });
  await assert.rejects(chat(), /没有可用的回复内容/);
  assert.equal(calls.length, 1);
});

test('网关业务错误：不被 data 中的回复掩盖，保留配额暂停语义', async (t) => {
  const calls = gateway(t, { success: true, data: completion, error: { code: '1310', message: '已达到每周使用上限' } });
  await assert.rejects(chat(), (error) => error instanceof LlmFatalError && error.kind === 'quota');
  assert.equal(calls.length, 1);
});

test('流式请求收到网关 JSON 成功包：直接复用已付费回答，不再重复外呼', async (t) => {
  const calls = gateway(t, { success: true, data: completion });
  const result = await chat({ onDelta() {} });
  assert.equal(result.content, '连接成功');
  assert.equal(result.streamed, false);
  assert.equal(currentStreamMode(), 'off');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.stream, true);
  const next = await chat({ onDelta() {} });
  assert.equal(next.content, '连接成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.stream, undefined);
});
