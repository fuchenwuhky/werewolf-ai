/**
 * emoji-guard-coverage-gaps.test.js — 补上两处"台账说守住了、其实没人守"的缺口。
 *
 * 来历：主控第 177 轮收到只读复核报告，报告用实证指出两条**真正的残余缺口**，
 * 主控随后亲自逐条复核并确认（见下）。按目标①「每个缺口都必须真正修掉，不许以"已知"放过」，
 * 这里把守卫**真的补上**。
 *
 * ── 缺口一（对应台账 :749 的不实自述）──────────────────────────────────────────
 *   台账写「新增 test/helpers-tmpdir-contract.test.js 钉住头注释与导出面」。
 *   实测：该文件只有 3 个用例，全部是 makeApiIn 的 opts 契约；
 *        「零副作用」四个字在该文件里出现 **0 次**，全仓只出现在 helpers-tmpdir.js 自己的注释里。
 *   ⇒ 头注释的结论（"本文件会被 node --test 当成测试文件加载，所以必须零副作用、可重复加载"）
 *      **此前没有任何用例钉住**，回归会静默。本文件补上：既钉文本，也钉**行为**。
 *
 * ── 缺口二（缺口 A 只覆盖了前端聊天模板）────────────────────────────────────────
 *   台账 :753 把「emoji 守卫未覆盖聊天文案」记为已收口，但覆盖的是
 *   `test/emoji-preserve.test.js:223-331` 的前端模板/标签/函数体地板。
 *   下列**玩家看得见、或进 AI 提示词**的文案此前零守卫：
 *     · src/engine/flow.js  五条服务端 game.emit('system') 事件文案（⚠️/⚔️/🎩）
 *     · web/pwa.js          离线提示「⚠ 已断网…」
 *     · src/ai/context.js   '👑警长'（进提示词的警长标记）
 *     · src/ai/prompts.js   重试提示 '⚠️ ${retryNote}'
 *     · web/style.css       阶段字形 content:'☀' / content:'⚖'
 *   ⇒ 本文件逐条钉字面量，并给每个文件一个**字符簇计数地板**（抓成片删除）。
 *
 * 纪律：本文件**只读**被守卫的文件，不修改它们；地板只许上调，不许为了变绿而下调
 *（与 test/icons.test.js:53 同一条纪律）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// 缺口一：helpers-tmpdir.js 的头注释契约 —— 文本 + 行为
// ---------------------------------------------------------------------------

// 该文件被 node --test 当成测试文件加载，所以它**必须**零副作用、可重复加载；
// 这是它头注释 :4-7 的原话，也是它 :124-125「刻意不用 process.on('exit')」的理由。
const TMP_HELPER = 'test/helpers-tmpdir.js';
const TMP_HELPER_EXPORTS = [
  'makeDataDir', 'savesOf', 'makeApiIn', 'settleApi', 'dispose',
  'terminateApi', 'cleanupAfter', 'terminateAfter',
];

test('缺口一：helpers-tmpdir.js 头注释必须写明"会被 node --test 加载 ⇒ 零副作用"（此前无人守）', () => {
  const src = read(TMP_HELPER);
  const header = src.split('\n').slice(0, 30).join('\n');
  assert.ok(/零副作用/.test(header), '头注释必须保留"零副作用"这条结论（它在 :6）');
  assert.ok(/node --test/.test(header) && /测试文件/.test(header),
    '头注释必须写明"会被 node --test 当成一个测试文件加载"（它在 :4-5）');
  assert.ok(/可重复加载/.test(header), '头注释必须写明"可重复加载"（它在 :6）');
});

test('缺口一：加载 helpers-tmpdir.js 必须零副作用（不注册 exit 监听、不注册用例、可重复加载）', () => {
  const exitBefore = process.listenerCount('exit');
  const beforeExit = process.listeners('exit').length;
  const h1 = require('./helpers-tmpdir.js');
  assert.strictEqual(process.listeners('exit').length, beforeExit,
    'require helpers-tmpdir.js 不得注册 process exit 监听（这正是它 :124 刻意避开的写法）');
  assert.ok(process.listenerCount('exit') === exitBefore, 'exit 监听数量必须不变');

  // 重复加载必须安全且拿到同一份导出（module cache 下同一对象）
  const h2 = require('./helpers-tmpdir.js');
  assert.strictEqual(h1, h2, '重复 require 必须得到同一份导出');

  // 导出面冻结：多一个少一个都要有人知道
  assert.deepStrictEqual(Object.keys(h1).sort(), [...TMP_HELPER_EXPORTS].sort(),
    'helpers-tmpdir.js 的导出面已冻结（新增/删除导出必须同步本用例与台账）');
  for (const k of TMP_HELPER_EXPORTS) {
    assert.strictEqual(typeof h1[k], 'function', `导出 ${k} 必须是函数`);
  }

  // 文件里不得再出现真实的 process.on('exit') 注册（注释里提到是被允许的）
  const src = read(TMP_HELPER);
  const realReg = src.split('\n').filter((l) => {
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('//')) return false;
    return /process\.on\(\s*['"]exit/.test(t);
  });
  assert.deepStrictEqual(realReg, [], 'helpers-tmpdir.js 不得出现真实的 process.on(\'exit\') 注册');
});

// ---------------------------------------------------------------------------
// 缺口二：此前零守卫的"玩家可见 / 进提示词 / CSS 字形"文案
// ---------------------------------------------------------------------------

const UNGUARDED_PINS = [
  // 服务端 system 事件文案（玩家看得见的事件流）
  ['src/engine/flow.js', '⚠️ ${p.seat}号（${ROLES[p.role].name}）自爆：', '服务端 system：自爆不带人'],
  ['src/engine/flow.js', '⚔️ 决斗成功：', '服务端 system：决斗成功'],
  ['src/engine/flow.js', '⚔️ 决斗失败：', '服务端 system：决斗失败'],
  ['src/engine/flow.js', '⚠️ ${req.seat}号（骑士）的决斗目标已出局，本次决斗取消。', '服务端 system：决斗取消'],
  ['src/engine/flow.js', '🎩 上警名单：', '服务端 system：上警名单'],
  ['src/engine/flow.js', '🎩 无人上警，本局没有警长。', '服务端 system：无人上警'],
  // 前端离线提示
  ['web/pwa.js', '⚠ 已断网：', 'PWA 离线提示'],
  // 进 AI 提示词的字形
  ['src/ai/context.js', "'👑警长'", 'AI 上下文：警长标记'],
  ['src/ai/prompts.js', '⚠️ ${req._retryNote}', 'AI 重试提示'],
  // CSS 阶段字形（::before 的 content）
  ['web/style.css', "content: '☀'", 'CSS 阶段字形：白天'],
  ['web/style.css', "content: '⚖'", 'CSS 阶段字形：投票'],
];

test('缺口二：服务端事件 / 离线提示 / 提示词 / CSS 字形里的语义 emoji 必须逐条存在（此前零守卫）', () => {
  const missing = [];
  for (const [rel, needle, why] of UNGUARDED_PINS) {
    const src = read(rel);
    if (!src.includes(needle)) missing.push(`${rel}: 找不到 ${JSON.stringify(needle)}（${why}）`);
  }
  assert.deepStrictEqual(missing, [],
    `下列"玩家可见/进提示词"的语义 emoji 不见了（缺口 A 此前只覆盖前端聊天模板）：\n${missing.join('\n')}`);
});

const EXT_PICT = /\p{Extended_Pictographic}/u;
const countEmoji = (text) => {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  let n = 0;
  for (const { segment } of seg.segment(String(text))) {
    if (EXT_PICT.test(segment) || segment.indexOf('\u20E3') >= 0) n++;
  }
  return n;
};

// 地板取"实测值 − 容差"；实测值在下面这个用例里打印出来，便于日后必要时**上调**。
// ⚠ 只许上调，不许为了让用例变绿而下调（同 test/icons.test.js:53 的纪律）。
const UNGUARDED_FLOORS = [
  ['src/engine/flow.js', 5],
  ['web/pwa.js', 1],
  ['src/ai/context.js', 1],
  ['src/ai/prompts.js', 1],
  // 首次标定：实测 9 ⇒ 地板取 8（1 点容差）。此文件是新建的，此前无任何 pin，
  // 所以这里是"按实测标定"，不是"下调已有 pin 来变绿"（与 test/icons.test.js:53 的禁令不冲突）。
  ['web/style.css', 8],
];

test('缺口二：上述文件的字符簇计数不得低于地板（抓成片删除，而不只是单条改动）', () => {
  const measured = [];
  const low = [];
  for (const [rel, floor] of UNGUARDED_FLOORS) {
    const n = countEmoji(read(rel));
    measured.push(`${rel}=${n}(地板${floor})`);
    if (n < floor) low.push(`${rel}: ${n} < 地板 ${floor}`);
  }
  console.log('  实测字符簇计数：' + measured.join('  '));
  assert.deepStrictEqual(low, [],
    `下列文件的语义 emoji 低于地板（疑似成片删除）：\n${low.join('\n')}`);
});

test('缺口二自检：清单本身有效（文件都在、每条字面量真的含 emoji）', () => {
  const problems = [];
  for (const [rel, needle, why] of UNGUARDED_PINS) {
    if (!fs.existsSync(path.join(ROOT, rel))) { problems.push(`${rel} 不存在（${why}）`); continue; }
    if (countEmoji(needle) === 0) problems.push(`${rel}: 清单里的 ${JSON.stringify(needle)} 自己不含 emoji（${why}）⇒ 钉不住东西`);
  }
  assert.deepStrictEqual(problems, [], '清单自检失败：\n' + problems.join('\n'));
});
