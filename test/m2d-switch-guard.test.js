/**
 * m2d-switch-guard.test.js — 切档确认 / 归档阻止 / 「返回首页 ≠ 终止」（计划书 §5.2、§8.2）
 *
 * 三条都是"点一下到底发生了什么"的判定，全部做成纯函数后逐分支钉住：
 *   · 本窗口有草稿 ⇒ confirm；没有 ⇒ proceed；
 *   · **其他窗口**切档 ⇒ defer（不弹窗、不销毁本窗口草稿）；
 *   · 有未结束对局的 owner 档案 ⇒ 归档/删除被**明确阻止**（不悄悄终止对局）；
 *   · 返回首页只是 leave，终止才是 terminate。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../web/shared/switch-guard');

test('没有未保存草稿：直接切（不弹确认）', () => {
  assert.deepStrictEqual(S.decideSwitch({ dirty: false, source: S.SELF }), { action: 'proceed', reason: '' });
  assert.strictEqual(S.decideSwitch({}).action, 'proceed', '默认无草稿、来源按本窗口');
});

test('本窗口有未保存资料/笔记：先确认', () => {
  const d = S.decideSwitch({ dirty: true, source: S.SELF });
  assert.strictEqual(d.action, 'confirm');
  assert.strictEqual(d.reason.includes('未保存'), true);
});

test('其他窗口切档：defer —— 不弹窗、更不许销毁本窗口草稿', () => {
  const d = S.decideSwitch({ dirty: true, source: S.OTHER_WINDOW });
  assert.strictEqual(d.action, 'defer', '别的窗口切档不能直接销毁当前草稿');
  assert.strictEqual(d.reason.includes('草稿已保留'), true);
  // 没草稿时其他窗口的切档照常跟随（跨窗口同步必须仍然生效）
  assert.strictEqual(S.decideSwitch({ dirty: false, source: S.OTHER_WINDOW }).action, 'proceed');
});

test('归档阻止：有未结束对局的 owner 档案不可归档/删除，且原因里点名"不会替你终止"', () => {
  const reason = S.archiveBlockReason({ unfinished: 2, usableCount: 3 });
  assert.strictEqual(typeof reason, 'string');
  assert.strictEqual(reason.includes('2 局未结束'), true);
  assert.strictEqual(reason.includes('不能归档或删除'), true);
  assert.strictEqual(reason.includes('不会替你终止'), true, '必须返回明确阻止原因');
});

test('归档阻止：最后一个可用档案也挡（否则设备上会没有可用档案）', () => {
  const reason = S.archiveBlockReason({ unfinished: 0, usableCount: 1 });
  assert.strictEqual(reason, '最后一个可用档案不能归档（可先新建一个）');
  assert.strictEqual(S.archiveBlockReason({ unfinished: 0, usableCount: 2 }), null, '两项都满足 ⇒ 允许');
});

test('归档阻止优先级：未结束对局先于"最后一个档案"（后果更重的那条先报）', () => {
  const reason = S.archiveBlockReason({ unfinished: 1, usableCount: 1 });
  assert.strictEqual(reason.includes('未结束的对局'), true);
});

test('返回首页 ≠ 终止：离开只说 leave，只有显式 terminate 才是危险操作', () => {
  assert.deepStrictEqual(S.leaveIntent({ target: 'home' }),
    { target: 'home', action: 'leave', terminates: false, needsDangerConfirm: false });
  assert.deepStrictEqual(S.leaveIntent({}),
    { target: 'home', action: 'leave', terminates: false, needsDangerConfirm: false }, '默认目标就是首页');
  const term = S.leaveIntent({ target: 'home', terminate: true });
  assert.strictEqual(term.action, 'terminate');
  assert.strictEqual(term.terminates, true);
  assert.strictEqual(term.needsDangerConfirm, true, '终止始终是独立危险操作');
});
