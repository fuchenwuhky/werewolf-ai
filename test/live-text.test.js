/**
 * live-text.test.js — 流式半成品 JSON → 可以直接展示的文本
 *
 * 背景（用户实际反馈）："AI 输出消息的时候会先出现 text 标签，等全部输入完才会正常消失。"
 * 因为 AI 回复被 JSON schema 约束（见 src/ai/schemas.js），`delta.content` 累加出来的是
 *
 *     {"text":"我是好人，昨晚过得很平静…
 *
 * 这种半成品 JSON（test/stream.test.js 的假 SSE 里就是这个形状）。
 * 旧实现把它原样下发，于是玩家先看到 `{"text":"` 这层壳子。
 *
 * 这组测试钉死提取规则，尤其是几个容易写错的地方：
 *   - 值里含转义引号 `\"` 时不能提前截断
 *   - 值里再出现 `"text":"` 字样时不能取错（必须取第一个键）
 *   - 收尾引号后面的 `","explode":false}` 不能混进正文
 *   - 还没吐到 text 值时不能显示半个壳子
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractLiveText, unescapePartial } = require('../src/ai/stream');

const FINAL = '七号发言很短，但逻辑比八号清楚，我倾向出七号。';

test('完整 JSON：取出 text 字段，丢掉其它字段', () => {
  assert.strictEqual(extractLiveText('{"text":"我是好人，先听后置位。","explode":false,"target":0}'), '我是好人，先听后置位。');
  assert.strictEqual(extractLiveText('{"target":3,"text":"过"}'), '过');
  assert.strictEqual(extractLiveText('{"text" : "键与冒号之间有空格"}'), '键与冒号之间有空格');
});

test('半成品：引号还没闭合时，先显示已收到的部分', () => {
  assert.strictEqual(extractLiveText('{"text":"我是好人'), '我是好人');
  assert.strictEqual(extractLiveText('{"text":"我'), '我');
  assert.strictEqual(extractLiveText('{"text":"'), '');
});

test('还没吐到 text 的值：什么都不显示（旧实现的 bug 就在这一步）', () => {
  for (const raw of ['{', '{"', '{"te', '{"text', '{"text"', '{"text":', '{"text": ', '  {  ']) {
    assert.strictEqual(extractLiveText(raw), '', `「${raw}」不该被当成正文显示出来`);
  }
  assert.strictEqual(extractLiveText('{"explode":false,"text'), '', '别的字段先吐出来也不该漏壳子');
});

test('转义：\\" \\n \\t \\uXXXX 都要还原，且不被转义引号截断', () => {
  assert.strictEqual(extractLiveText('{"text":"他说：\\"我不是狼\\"。"}'), '他说："我不是狼"。');
  assert.strictEqual(extractLiveText('{"text":"第一行\\n第二行"}'), '第一行\n第二行');
  assert.strictEqual(extractLiveText('{"text":"制表\\t符"}'), '制表\t符');
  assert.strictEqual(extractLiveText('{"text":"\\u4f60\\u597d"}'), '你好');
  assert.strictEqual(extractLiveText('{"text":"反斜杠\\\\结尾"}'), '反斜杠\\结尾');
  // 转义序列还没吐全 → 先不显示半个字符，也不能报错
  assert.strictEqual(extractLiveText('{"text":"abc\\'), 'abc');
  assert.strictEqual(extractLiveText('{"text":"abc\\u4f'), 'abc');
  assert.strictEqual(unescapePartial('x\\u0041y'), 'xAy');
});

test('值里再出现 "text":" 字样时取自第一个键（不能被内容骗到）', () => {
  assert.strictEqual(extractLiveText('{"text":"他说 \\"text\\":\\"x\\" 哈哈","explode":false}'), '他说 "text":"x" 哈哈');
});

test('非 JSON 的纯文本照原样显示（有的模型会先说一句人话）', () => {
  assert.strictEqual(extractLiveText('我认为 7 号最可疑'), '我认为 7 号最可疑');
  assert.strictEqual(extractLiveText('我先说一句 {"text":"正文"}'), '正文'); // 中间出现 JSON → 取正文
  assert.strictEqual(extractLiveText('') , '');
  assert.strictEqual(extractLiveText(null), '');
  assert.strictEqual(extractLiveText(undefined), '');
});

test('逐字增量：任何前缀的显示内容都必须是最终文本的前缀（壳子一秒都不能露）', () => {
  const full = JSON.stringify({ text: FINAL, explode: false, target: 0 });
  let prev = '';
  for (let i = 1; i <= full.length; i++) {
    const shown = extractLiveText(full.slice(0, i));
    assert.ok(FINAL.startsWith(shown), `第 ${i} 个字符时显示了不属于正文的内容：${JSON.stringify(shown)}`);
    assert.ok(shown.length >= prev.length, `第 ${i} 个字符时显示内容回退了：${JSON.stringify(prev)} → ${JSON.stringify(shown)}`);
    prev = shown;
  }
  assert.strictEqual(prev, FINAL, '吐完必须正好等于全文');
});

test('壳子在最前面就出现（真实 SSE 的第一个增量）→ 第一阶段显示为空', () => {
  // 对应 test/stream.test.js 里那个假响应的第一块 content
  assert.strictEqual(extractLiveText('{"text":"'), '');
  assert.strictEqual(extractLiveText('{"text":"你好"}'), '你好');
});

test('接线：下发给前端的 live.text 必须经过提取（防止有人把 cleanLive 摘掉）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
  assert.match(api, /require\('\.\/ai\/stream'\)/, 'api.js 必须引入 ai/stream');
  assert.match(api, /live: this\.cleanLive\(game\.liveFor\(viewer\)\)/, 'buildView 里的 live 必须走 cleanLive');
  assert.match(api, /cleanLive\(live\) \{[\s\S]{0,400}extractLiveText\(live\.text\)/, 'cleanLive 必须用 extractLiveText 处理 text');
  // 上帝视角的 reasoning（内心独白）是自由文本，不该被当 JSON 处理
  assert.match(api, /Object\.assign\(\{\}, live, \{ text: extractLiveText\(live\.text\) \}\)/, '只能替换 text 字段，reasoning 要原样保留');
});

