/**
 * prompt-discipline.test.js — AI 发言/投票/警徽纪律的回归测试（用户实战反馈驱动）。
 *
 * 三个真实问题：
 * 1) 有玩家反映狼人爱说"有些事，天黑之后你们自然会懂"——查下来它不是模型即兴发挥，
 *    而是 personalities.js 的"神秘主义者"人设里**明写着**这句话。那句话等于宣称自己掌握
 *    夜晚信息，而好人夜里闭眼：谁说谁被当狼。这里用正则把这类"暗示信息优势"的句子钉死。
 * 2) 发言指令原先只有"请输出你的发言"，于是人设成了唯一约束 → 空话/偏题。现在必须带发言要求。
 * 3) 投票指令原先只有一句"选出你认为最可能是狼人的玩家" → 弃票随手、言票不一、狼队整齐同投。
 *    现在必须带投票纪律，且狼的纪律只给狼看（省 token，也避免向好人的 AI 交底）。
 * 4) 狼的警徽流转原先是无条件的"优先交给狼队友"——身份已被查杀时当众交给队友=把队友钉死。
 *    现在必须区分"身份暴露与否"。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PERSONALITIES } = require('../src/ai/personalities');
const { BADGE_STRATEGIES } = require('../src/ai/strategies');
const { taskInstruction } = require('../src/ai/prompts');

const game = { rules: { sheriffVoteWeight: 1.5 }, day: 2, aliveSeats: () => [1, 2, 3, 4] };
const mkPlayer = (role, extra) => Object.assign({ seat: 1, role, isHuman: false, isSheriff: false }, extra);
const req = (task, more) => Object.assign({ task, candidates: [2, 3, 4], aliveSeats: [1, 2, 3, 4] }, more);

test('人设不许暗示自己掌握夜晚信息（"天黑之后你们自然会懂"这类等于自曝）', () => {
  const bad = /天黑之后|自然会懂|(你们|你)会明白|以后会明白|有些事(我)?不能(说|讲)|我心里有数/;
  for (const p of PERSONALITIES) {
    assert.ok(!bad.test(p.prompt), `人设「${p.name}」含暗示夜晚信息的句子：${p.prompt}`);
  }
  const enigma = PERSONALITIES.find((p) => p.id === 'enigma');
  assert.ok(enigma, '神秘主义者人设必须还在（只是不能再教人说那句话）');
  assert.match(enigma.prompt, /必须|落地/, '神秘主义人设必须强制"话要落地"，否则就只剩空话');
});

test('发言纪律：白天发言 / PK 发言 / 可自爆的发言都要"落地 + 禁止谜语"', () => {
  for (const task of ['speech', 'pk_speech']) {
    const t = taskInstruction(game, mkPlayer('villager'), req(task));
    assert.match(t, /【发言要求】/, `${task} 缺少发言要求`);
    assert.match(t, /怀疑对象/, `${task} 没要求给出怀疑对象`);
    assert.match(t, /硬红线/, `${task} 缺少硬红线（不许暗示夜晚信息）`);
  }
  const ex = taskInstruction(game, mkPlayer('wolf'), req('speech', { canExplode: true }));
  assert.match(ex, /【发言要求】/, '可自爆的白天发言也要带纪律（它是同一条发言路径）');
});

test('投票纪律：放逐与 PK 都带纪律，且狼的纪律不发给好人', () => {
  const good = taskInstruction(game, mkPlayer('villager'), req('vote'));
  assert.match(good, /【投票要求】/, '放逐投票缺少纪律');
  assert.match(good, /好人纪律/, '好人应看到好人纪律');
  assert.ok(!/狼人纪律/.test(good), '好人的提示词里不该出现狼的战术');
  const wolf = taskInstruction(game, mkPlayer('wolf'), req('vote'));
  assert.match(wolf, /狼人纪律/, '狼应看到狼人纪律');
  assert.match(wolf, /不要和队友整齐投同一个人/, '狼队整齐同投会暴露关系，必须写明');
  assert.match(taskInstruction(game, mkPlayer('villager'), req('pk_vote')), /【投票要求】/, 'PK 投票缺少纪律');
});

test('狼人警徽流转必须分情况：暴露就撕徽，没暴露才给队友', () => {
  for (const r of ['wolf', 'wolfking', 'whitewolfking', 'wolfbeauty', 'hiddenwolf']) {
    const pass = BADGE_STRATEGIES[r] && BADGE_STRATEGIES[r].pass;
    assert.ok(pass, `${r} 缺少警徽流转策略`);
    assert.match(pass, /撕徽/, `${r} 的流转策略必须提到撕徽`);
    assert.match(pass, /暴露|公开/, `${r} 必须区分"身份有没有暴露"——原版无条件"优先交给狼队友"，被查杀时等于当众把队友钉死`);
  }
});
