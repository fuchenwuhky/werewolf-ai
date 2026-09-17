/**
 * lint.test.js — 门禁自身的测试（P1-5）
 *
 * 门禁必须可验证：每条规则都要能"抓到合成违规"，也要能"放过正确写法"，
 * 否则规则要么形同虚设、要么把正确代码拦住。
 * 最后一条还会检查**本仓库当前真的干净**，等于把 lint 也接进了 `npm test`。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { lintSource, lintAll, listFiles, stripCommentsAndStrings } = require('../scripts/lint.js');

const rules = (code, file) => lintSource(code, file).map((v) => v.rule);

test('syntax：语法错误必须被抓到（第 8 轮的 attempt is not defined 就是这类问题）', () => {
  const bad = 'const x = ;';
  const out = lintSource(bad, 'src/x.js');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].rule, 'syntax');
});

test('no-runtime-deps：第三方依赖被拦截，Node 内建与相对路径放行', () => {
  assert.deepStrictEqual(rules("const _ = require('lodash');", 'src/x.js'), ['no-runtime-deps']);
  assert.deepStrictEqual(rules("const fs = require('fs');", 'src/x.js'), []);
  assert.deepStrictEqual(rules("const p = require('node:path');", 'src/x.js'), []);
  assert.deepStrictEqual(rules("const a = require('./a');", 'src/x.js'), []);
  assert.deepStrictEqual(rules("const w = require('undici');", 'server.js'), ['no-runtime-deps']);
  // 测试与脚本允许用开发依赖（CI 里会装），不在此规则范围内
  assert.deepStrictEqual(rules("const e = require('eslint');", 'test/x.test.js'), []);
});

test('engine-rng：Math.random() 被拦截，默认参数写法 = Math.random 放行', () => {
  assert.deepStrictEqual(rules('const a = Math.random();', 'src/engine/flow.js'), ['engine-rng']);
  assert.deepStrictEqual(rules('const a = arr[Math.floor(Math.random() * n)];', 'src/engine/game.js'), ['engine-rng']);
  // 默认参数（无括号）是合法写法：调用方会传入 game.rnd
  assert.deepStrictEqual(rules('function shuffle(arr, rnd = Math.random) { return arr; }', 'src/engine/game.js'), []);
  // 引擎之外不受此规则约束（例如 AI 层重试抖动可以用随机）
  assert.deepStrictEqual(rules('const a = Math.random();', 'src/ai/llm.js'), []);
});

test('llm-must-go-through-scheduler：HTTP 只能在 llm.js 发；引擎层允许扇出（它会排进 scheduler）', () => {
  // 唯一入队 scheduler 的地方是 llm.js；别处直接 fetch 等于绕过调度器
  const fetchCall = 'async function f(){ const r = await fetch(url, o); return r; }';
  assert.deepStrictEqual(rules(fetchCall, 'src/engine/flow.js'), ['llm-must-go-through-scheduler']);
  assert.deepStrictEqual(rules(fetchCall, 'src/ai/agent.js'), ['llm-must-go-through-scheduler']);
  assert.deepStrictEqual(rules(fetchCall, 'src/ai/llm.js'), [], 'llm.js 是唯一允许发 HTTP 的地方');
  // AI 业务层不得自己开并发（并发扇出只由 scheduler 决定）
  assert.deepStrictEqual(rules('async function f(){ await Promise.all([a, b]); }', 'src/ai/agent.js'), ['llm-must-go-through-scheduler']);
  assert.deepStrictEqual(rules('async function f(){ await Promise.all([a, b]); }', 'src/ai/scheduler.js'), [], '调度器自己就是用来开并发的');
  // 引擎层允许扇出：每条分支最终都会经 llm.js 排进 scheduler —— 这正是多 Key 并行需要的写法
  assert.deepStrictEqual(rules('async function f(){ await Promise.all([a, b]); }', 'src/engine/flow.js'), []);
  // 测试里的网络禁令（global.fetch = ...）不算违规
  assert.deepStrictEqual(rules('global.fetch = async (u) => { throw new Error(u); };', 'src/engine/flow.js'), []);
});

test('api-no-sync-write：同步写被拦截——注释里出现同名词不应误报', () => {
  assert.deepStrictEqual(rules("fs.writeFileSync(f, data);", 'src/api.js'), ['api-no-sync-write']);
  assert.deepStrictEqual(rules("fs.appendFileSync(f, data);", 'src/api.js'), ['api-no-sync-write']);
  // 注释中的说明文字不能触发规则（api.js 里真的有这样一句注释）
  assert.deepStrictEqual(rules('// 旧实现用 writeFileSync，会阻塞事件循环\nasync function f(){ await fs.promises.writeFile(p, d); }', 'src/api.js'), []);
  // 其它文件的同步写（配置、日志）不在本规则范围内
  assert.deepStrictEqual(rules('fs.writeFileSync(f, d);', 'src/config.js'), []);
});

test('no-console：直接 console 被拦截，logger 放行', () => {
  assert.deepStrictEqual(rules("console.log('x');", 'src/api.js'), ['no-console']);
  assert.deepStrictEqual(rules("logger.warn('api', 'x');", 'src/api.js'), []);
  assert.deepStrictEqual(rules("console.log('x');", 'web/app.js'), [], '前端代码不受此规则约束');
});

test('no-console：豁免必须写明理由，且必须紧贴该行（防止随手关规则）', () => {
  const withReason = "// lint-allow: no-console — 未注入 logger 时的兜底\nconsole.error('x');";
  assert.deepStrictEqual(rules(withReason, 'src/api.js'), []);
  const sameLine = "console.error('x'); // lint-allow: no-console — 兜底";
  assert.deepStrictEqual(rules(sameLine, 'src/api.js'), []);
  // 只有标记、没有理由 → 不豁免
  assert.deepStrictEqual(rules('// lint-allow\nconsole.error(\'x\');', 'src/api.js'), ['no-console']);
  // 理由写得离得太远（隔了一行以上）→ 不豁免
  assert.deepStrictEqual(rules("// lint-allow: no-console — 兜底\nconst a = 1;\nconsole.error('x');", 'src/api.js'), ['no-console']);
});

test('分层规则：engine 不得依赖 ai，ai 不得反向依赖 api', () => {
  assert.deepStrictEqual(rules("const a = require('../ai/agent');", 'src/engine/flow.js'), ['engine-no-ai']);
  assert.deepStrictEqual(rules("const a = require('../api');", 'src/ai/agent.js'), ['ai-no-api']);
  assert.deepStrictEqual(rules("const a = require('../engine/game');", 'src/ai/agent.js'), [], 'AI 依赖引擎是正确方向');
});

test('注释/字符串剥离：不会把字符串里的关键字当代码', () => {
  assert.strictEqual(stripCommentsAndStrings("const s = 'Promise.all(';").includes('Promise.all('), false);
  assert.deepStrictEqual(rules("const s = 'Promise.all(';", 'src/ai/agent.js'), []);
  assert.deepStrictEqual(rules('/* Promise.all( */ const a = 1;', 'src/ai/agent.js'), []);
  assert.deepStrictEqual(rules('const s = `Math.random()`;', 'src/engine/game.js'), [], '模板字符串里的文本不是调用');
  // 剥离后必须保持行号不变（否则报错位置会飘）
  const stripped = stripCommentsAndStrings('const a = 1; // 注释\nconst b = 2;');
  assert.strictEqual(stripped.split('\n').length, 2);
});

test('门禁自检：本仓库当前必须零违规（等价于把 lint 接入 npm test）', () => {
  const results = lintAll();
  assert.deepStrictEqual(results, [], `本仓库存在 ${results.length} 处 lint 违规：\n` + results.map((r) => `  ${r.file}:${r.line} [${r.rule}] ${r.msg}`).join('\n'));
  const files = listFiles();
  assert.ok(files.length >= 40, `应扫描到全部源码，实际 ${files.length} 个文件`);
  assert.ok(files.every((f) => f.endsWith('.js')));
  assert.ok(!files.some((f) => /node_modules|saves|logs/.test(f)), '不应扫描运行时产物目录');
});
