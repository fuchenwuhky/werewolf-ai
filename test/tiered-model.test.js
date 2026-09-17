/**
 * tiered-model.test.js — 分层模型（A2）
 *
 * 快速任务（夜晚行动/投票/警竞等结构化微决策）决策空间很小，却占掉一半以上的调用次数。
 * 用大模型跑它们主要是在等首字 —— 所以允许给它们配一个更小更快的模型（cfg.modelFast）。
 *
 * 三条底线：
 *   ① 未配置时不改变任何行为（全部走主模型）；
 *   ② 发言类**永远**留在主模型（那是玩家唯一逐字阅读的东西）；
 *   ③ 换模型只影响"用哪个模型"，不影响校验：非法输出照样被 enum 拦下、照样降级可见。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const context = require('../src/ai/context');
const llm = require('../src/ai/llm');
const { DEFAULT_CONFIG } = require('../src/config');

global.fetch = async (url) => {
  const err = new Error(`测试禁止真实网络请求：${url}`);
  err.retryable = false;
  throw err;
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('taskModel：未配置 modelFast 时全部走主模型（默认行为零变化）', () => {
  const cfg = { ...DEFAULT_CONFIG, model: 'big-model' };
  assert.strictEqual(context.taskModel('speech', cfg), 'big-model');
  assert.strictEqual(context.taskModel('vote', cfg), 'big-model', '没配就得完全不动');
  assert.strictEqual(context.taskModel('vote', undefined), undefined, '配置缺失也不能炸');
});

test('taskModel：配了 modelFast 只有快速任务换档，发言类绝不下放', () => {
  const cfg = { ...DEFAULT_CONFIG, model: 'big-model', modelFast: 'small-model' };
  // 快速任务换小模型
  for (const t of ['vote', 'pk_vote', 'seer_check', 'wolf_kill', 'sheriff_vote', 'lastwords']) {
    assert.strictEqual(context.taskModel(t, cfg), 'small-model', `${t} 属快速任务`);
  }
  // 发言与文类留在主模型：玩家逐字阅读的东西不能用小模型糊
  for (const t of ['speech', 'pk_speech', 'sheriff_speech', 'reflection', 'digest', 'review']) {
    assert.strictEqual(context.taskModel(t, cfg), 'big-model', `${t} 必须留在主模型`);
  }
});

test('chatCompletion：模型按调用级覆盖，且请求体里发出去的确实是它', async () => {
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => '',
    };
  };
  try {
    const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'big-model', retries: 0, stream: false };
    await llm.chatCompletion(cfg, [{ role: 'user', content: 'hi' }], { logger: silentLogger, model: 'small-model' });
    await llm.chatCompletion(cfg, [{ role: 'user', content: 'hi' }], { logger: silentLogger });
    assert.deepStrictEqual(seen, ['small-model', 'big-model'], '覆盖生效，缺省回落主模型');
  } finally { global.fetch = orig; }
});
