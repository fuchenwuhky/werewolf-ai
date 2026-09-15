/**
 * memory.test.js — L1 记忆流与检索（P2-5）
 *
 * 这一层改的是"AI 到底记得什么"，比改代码风格危险得多，所以测试要钉死三件事：
 *   ① **确定性**：同样的输入必须给出逐字相同的输出（决策 journal 靠 promptHash 重放，
 *      上下文只要不可复现，"命中 journal 省一次调用"就会变成"两次答案不一样"）；
 *   ② **不倒退**：装得下时不做任何检索（短局常态），与旧的"全量拼接"逐字一致；
 *   ③ **不静默**：一旦裁剪，必须写明保留/省略条数，而不是让 AI 以为那就是全部记忆。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  splitDigest, toEntries, importanceOf, recencyOf, relevanceOf, rankEntries, selectMemory,
} = require('../src/ai/memory');
const { estimateTokens } = require('../src/ai/tokens');

test('记忆流：一天纪要按项目符号拆成原子条目，续行并入上一条', () => {
  const entries = splitDigest('- 3号跳预言家\n- 5号对跳\n  并给了警徽流\n- 9号沉默', 2);
  assert.strictEqual(entries.length, 3);
  assert.deepStrictEqual(entries.map((e) => e.day), [2, 2, 2]);
  assert.strictEqual(entries[1].text, '5号对跳 并给了警徽流', '续行应并入上一条而不是丢成独立条目');
  // 没有项目符号时整天作为一条（不能把一句话切成碎片）
  assert.strictEqual(splitDigest('今天很平静', 1).length, 1);
  assert.deepStrictEqual(splitDigest('', 1), []);
});

test('记忆流：条目来自 Map<day,text>，按天有序，index 连续', () => {
  const digests = new Map([[3, '- 后一天的事'], [1, '- 第一天的事\n- 还有一件']]);
  const entries = toEntries(digests);
  assert.deepStrictEqual(entries.map((e) => `${e.day}#${e.index}`), ['1#0', '1#1', '3#0']);
});

test('记忆流：重要性由关键词确定性计价（死亡/跳身份高于寒暄）', () => {
  const death = importanceOf('5号夜里被刀出局');
  const claim = importanceOf('3号跳预言家，给了2号金水');
  const idle = importanceOf('8号说今天天气不错');
  assert.ok(death.score > idle.score, '死亡事实应比寒暄重要');
  assert.ok(claim.score > idle.score, '身份声明应比寒暄重要');
  assert.ok(death.why.includes('死亡事实'));
  assert.strictEqual(importanceOf('5号夜里被刀出局').score, death.score, '同一文本必须得到同一分数');
  assert.ok(death.score <= 10, '重要性上限 10');
});

test('记忆流：新近度按天数指数衰减，当天为 1', () => {
  assert.strictEqual(recencyOf(5, 5), 1);
  assert.ok(recencyOf(4, 5) > recencyOf(3, 5), '越近越该记得');
  assert.ok(recencyOf(1, 5) < 0.4, '第 1 天相对第 5 天应显著衰减');
  assert.strictEqual(recencyOf(5, 5, 3), recencyOf(5, 5, 1), '当天恒为 1，与半衰期无关');
});

test('记忆流：相关度看"当前在盘谁"，正在讨论的座位会加分', () => {
  const entry = { day: 3, index: 0, text: '5号发言很划水，像是在保9号' };
  const hot = relevanceOf(entry, { seats: new Set([5]), terms: [] });
  const cold = relevanceOf(entry, { seats: new Set([11]), terms: [] });
  assert.ok(hot > cold, '提到 5号的记忆，在盘 5号时更相关');
  assert.strictEqual(relevanceOf(entry, null), 0);
});

test('记忆流：三条线索加权后，越相关越重要的排越前（且排序稳定）', () => {
  const entries = [
    { day: 1, index: 0, text: '3号跳预言家，声称5号是狼' },
    { day: 4, index: 0, text: '8号说今天天气不错' },
    { day: 2, index: 0, text: '9号随意附和了一句' },
  ];
  const ranked = rankEntries(entries, { nowDay: 5, query: { seats: new Set([3, 5]), terms: ['投票'] } });
  const order = ranked.map((e) => e.day);
  assert.strictEqual(order[0], 1, '老但高度相关的"跳预言家"应排第一（这正是旧策略会先丢掉的）');
  // 关键对比：**无关但新近**必须排在**相关但久远**之后 —— 这是 P2-5 相对"丢最旧"的核心价值
  assert.ok(order.indexOf(1) < order.indexOf(4), '相关度必须能压过新近度');
  assert.strictEqual(order[order.length - 1], 2, '又旧又无关的那条应垫底');
  // 同分并列时顺序必须稳定（day 降序 → index 升序）
  const a = rankEntries(entries, { nowDay: 5, query: null });
  const b = rankEntries(entries, { nowDay: 5, query: null });
  assert.deepStrictEqual(a.map((e) => `${e.day}#${e.index}`), b.map((e) => `${e.day}#${e.index}`));
});

test('记忆流：装得下必须全量、逐字等于旧行为（短局零变化）', () => {
  const digests = new Map([[1, '- 3号跳预言家'], [2, '- 5号被放逐']]);
  const out = selectMemory(digests, { nowDay: 3, budgetTokens: 100000, query: { seats: new Set([3]), terms: [] } });
  assert.strictEqual(out.retrieved, false, '装得下就不该触发检索');
  assert.strictEqual(out.omitted, 0);
  assert.strictEqual(out.total, 2);
  // 与旧的 renderDigests 输出格式一致（逐字对照，防止"顺手改了格式"）
  const { renderDigests } = require('../src/ai/context');
  assert.strictEqual(out.text, renderDigests(digests));
});

test('记忆流：超预算时按相关度取舍，并如实标注保留/省略条数', () => {
  const digests = new Map();
  for (let d = 1; d <= 6; d++) {
    digests.set(d, `- 第${d}天的无关寒暄，内容很长用来撑爆预算 ${'啰嗦'.repeat(40)}\n- ${d}号跳预言家并声称3号是狼`);
  }
  const all = selectMemory(digests, { nowDay: 6, budgetTokens: 1e9 });
  // 预算取全量的三分之一：既保证一定超预算，又不依赖"内容多长"的假设
  const budget = Math.max(120, Math.floor(all.tokens / 3));
  const small = selectMemory(digests, { nowDay: 6, budgetTokens: budget, query: { seats: new Set([3]), terms: ['预言家'] } });
  assert.strictEqual(small.retrieved, true, '超预算应触发检索');
  assert.ok(small.kept < all.total, '应确实省略了条目');
  assert.strictEqual(small.kept + small.omitted, all.total, '保留 + 省略 = 总数（不能凭空多出或丢失）');
  assert.match(small.text, /已按相关度检索：保留 \d+ \/ 共 \d+ 条，省略 \d+ 条/, '必须如实标注裁剪情况');
  assert.ok(small.tokens <= budget, `裁剪后应落回预算内，实际 ${small.tokens} > ${budget}`);
  // 检索保留的应是"跳预言家"这类高相关条目，而不是随机几条
  assert.match(small.text, /跳预言家/);
});

test('记忆流：检索结果可复现（同输入 → 逐字同输出）', () => {
  const digests = new Map([[1, '- 3号跳预言家\n- 5号附和'], [2, '- 9号出局']]);
  const opts = { nowDay: 3, budgetTokens: 260, query: { seats: new Set([9]), terms: ['出局'] } };
  const a = selectMemory(digests, opts).text;
  const b = selectMemory(new Map(digests), { ...opts, query: { seats: new Set([9]), terms: ['出局'] } }).text;
  assert.strictEqual(a, b, '同样的输入必须给出逐字相同的上下文（journal 重放的前提）');
});

test('记忆流：超长条目必须按句子切细（否则"原子检索"退化成全有或全无）', () => {
  // 真实事故：模型不按项目符号输出，一条纪要 568 token，单条就超预算 → 只能整条塞进去
  const sentence = '第若干句说的是三号跳预言家并且给了二号金水，语气非常笃定。';
  const long = sentence.repeat(10); // 约 300 字，远超 120 字阈值
  const entries = splitDigest(long, 1);
  assert.ok(entries.length > 1, `超长段落必须切细，实际 ${entries.length} 条`);
  for (const e of entries) assert.ok(e.text.length <= 240, `切分后单条不应过长：${e.text.length} 字`);
  assert.ok(entries.every((e) => e.day === 1), '切分后仍属同一天');
  assert.strictEqual(entries.map((e) => e.index).join(','), [...entries.keys()].join(','), 'index 必须重新连续编号');
  // 正常长度的条目不允许被切碎
  const short = splitDigest('- 3号跳预言家\n- 5号划水', 2);
  assert.deepStrictEqual(short.map((e) => e.text), ['3号跳预言家', '5号划水']);
});

test('记忆流：预算连一条完整条目都放不下时，保留最重要的一条并明说（不把记忆切成半句话）', () => {
  const huge = '甲乙丙丁戊己庚辛壬癸'.repeat(50); // 500 字无标点，会被硬切成多条
  const out = selectMemory(new Map([[1, huge]]), { nowDay: 2, budgetTokens: 90, query: { seats: new Set([3]), terms: [] } });
  assert.strictEqual(out.retrieved, true);
  assert.strictEqual(out.kept, 1, '只保留一条');
  assert.strictEqual(out.noFit, true, '必须标记"预算不足"');
  assert.match(out.text, /预算不足以容纳任何完整条目/, '必须如实说明，而不是假装裁得很整齐');
  assert.ok(!/截断/.test(out.text), '不得把记忆截成半句话');
  // 保留的条目必须是完整的一条（末尾不是被切断的半个词）
  const body = out.text.split('◆ 第1天纪要：\n')[1];
  assert.ok(body.startsWith('- 甲乙丙丁'), '正文应完整保留条目开头');
  assert.strictEqual(body.trim().split('\n').length, 1, '只应有一条，且未被拆断');
});

test('记忆流：空记忆返回空串（不产生空标题）', () => {
  const out = selectMemory(new Map(), { nowDay: 2, budgetTokens: 100 });
  assert.strictEqual(out.text, '');
  assert.strictEqual(out.total, 0);
});

test('记忆流：估算函数只有一个实现（tokens.js），避免预算口径分叉', () => {
  const { estimateTokens: fromContext } = require('../src/ai/context');
  assert.strictEqual(fromContext, estimateTokens, 'context.js 必须复用 tokens.js 的实现，不允许各写一份');
  assert.strictEqual(estimateTokens('中文文本'), Math.ceil(4 / 1.5));
});
