/**
 * rules-tuning.test.js — 两条"规则调优"的回归测试（用户批准）。
 *
 * 1) 狼王平票加权：狼王在平票时权重更高（那一票所指目标再 +1），从而打破平票、不再靠抽签。
 * 2) 对局层僵局护栏：连续 N 天（昼+夜）无人出局即结算，避免"没人出局 → 无限循环"。
 *
 * 两条都测**纯函数**，所以是确定性的、零依赖、零成本。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../src/engine/flow');

const { tallyWolfKill, advanceStaleDays, STALE_DAYS } = _internals;

test('狼王加权：三方各投一人时，狼王那一票打破平票', () => {
  // 1 号是狼王，投 8；另两狼投 5 / 11 —— 不加权就是 {5:1, 8:1, 11:1} 的三方平票（要抽签）
  const votes = [
    { seat: 1, target: 8 },
    { seat: 4, target: 5 },
    { seat: 12, target: 11 },
  ];
  assert.deepStrictEqual(tallyWolfKill(votes, null), { 5: 1, 8: 1, 11: 1 }, '无狼王时不加权');
  assert.deepStrictEqual(tallyWolfKill(votes, 1), { 5: 1, 8: 2, 11: 1 }, '狼王票按两票计，8 号独得 2 票');
});

test('狼王加权：狼王已出局（kingSeat=null）时退回原行为', () => {
  const votes = [
    { seat: 1, target: 8 },
    { seat: 4, target: 5 },
  ];
  assert.deepStrictEqual(tallyWolfKill(votes, null), { 8: 1, 5: 1 });
});

test('狼王加权：狼王投空刀（target=0）时不影响计票', () => {
  const votes = [
    { seat: 1, target: 0 },
    { seat: 4, target: 5 },
    { seat: 12, target: 5 },
  ];
  assert.deepStrictEqual(tallyWolfKill(votes, 1), { 5: 2 }, '空刀票不计入，也不会把别人的票加权');
});

test('僵局护栏：有人出局就归零，连续无人出局才累加并结算', () => {
  // 起始 12 人存活
  let last = 12;
  let stale = 0;
  for (let i = 1; i <= STALE_DAYS - 1; i++) {
    const r = advanceStaleDays(last, 12, stale); // 这一天没人出局
    stale = r.staleDays;
    assert.strictEqual(r.settle, false, `第 ${i} 天还不该结算`);
    assert.strictEqual(stale, i);
  }
  // 中间有人出局 → 计数归零
  let r = advanceStaleDays(last, 11, stale);
  assert.strictEqual(r.staleDays, 0, '有人出局必须归零');
  assert.strictEqual(r.settle, false);
  last = 11;
  // 重新连续无出局到阈值 → 结算
  for (let i = 1; i <= STALE_DAYS; i++) {
    r = advanceStaleDays(last, last, r.staleDays);
  }
  assert.strictEqual(r.settle, true, `连续 ${STALE_DAYS} 天无人出局必须结算`);
});

test('僵局护栏：阈值是 3 天（早于既有 40 天保险兜底）', () => {
  assert.strictEqual(STALE_DAYS, 3);
});

// ---- 平局（draw）：僵局护栏与 40 天保险都判平局，这是用户批准的语义 ----

test('平局：引擎接受 winner=draw，并通过 winReason 传出去', () => {
  const { setWinner } = _internals;
  const fake = {
    winner: null, winReason: null, _lastWin: null,
    emit: () => {},
    logger: { info() {}, warn() {} },
  };
  setWinner(fake, { winner: 'draw', reason: `连续 ${STALE_DAYS} 天无人出局，判定平局（僵局护栏）。` });
  assert.strictEqual(fake.winner, 'draw', '平局必须被引擎接受（不是 none，也不是好人胜）');
  assert.match(fake.winReason, /平局/);
  // setWinner 只做登记；发 game_over 事件是 finish() 的职责，而 finish() 取的是
  // `checkWin() || _lastWin` —— 所以 _lastWin 里必须是这个平局，否则结算会被判成"对局终止"。
  assert.strictEqual(fake._lastWin && fake._lastWin.winner, 'draw', 'finish() 要从 _lastWin 取到这个平局');
});

test('平局：game_over 文案渲染为"平局"，不再显示成狼人/好人获胜', () => {
  const { renderEvent } = require('../src/engine/render');
  const line = renderEvent({ players: [] }, { type: 'game_over', data: { winner: 'draw', reason: '连续 3 天无人出局，判定平局（僵局护栏）。' } });
  assert.match(line, /平局/, `实际渲染：${line}`);
  assert.ok(!/狼人阵营获胜|好人阵营获胜/.test(line), `平局不该渲染成某方获胜：${line}`);
});

test('对局层僵局护栏（整局级）：全场无人出局时判平局，而不是无限打下去', async () => {
  // 为什么需要这条：纯函数测试测不到"接线"——在主循环哪个位置比较存活人数、结算分支有没有真的 break。
  // 护栏失效的表现形式恰好是"对局卡死"，所以必须有一条真正跑完 runGame 的测试守住它。
  const { Game } = require('../src/engine/game');
  const { runGame } = require('../src/engine/flow');
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  global.fetch = async (url) => { throw new Error(`测试禁止真实网络请求：${url}`); };

  // 一个"谁都别死"的脚本化智能体：狼队空刀、女巫不用药、全员弃票、自爆/开枪/决斗一律否。
  // 载荷形状对齐 src/ai/schemas.js（放逐与 PK 投票的 allowNone 为 true → target:0 是合法弃票）。
  const peacefulFactory = (player, game) => ({
    async decide(req) {
      const others = game.aliveSeats().filter((s) => s !== player.seat);
      const first = others.length ? others[0] : 0;
      switch (req.task) {
        case 'speech': case 'sheriff_speech': case 'pk_speech':
          return { text: '过。', explode: false, target: 0, withdraw: false, claims: [] };
        case 'wolf_chat': return { text: '过。', target: 0 };
        case 'wolf_propose': case 'wolf_say': case 'lastwords': return { text: '过。' };
        case 'wolf_kill': case 'vote': case 'pk_vote': case 'sheriff_vote': case 'badge_pass': case 'shoot':
          return { target: 0 };
        case 'witch': return { antidote: false, poison: 0 };
        case 'sheriff_run': return { run: false };
        case 'direction': return { direction: 'cw' };
        case 'duel_check': return { duel: false, target: first };
        case 'explode_check': return { explode: false, target: first };
        case 'seer_check': case 'night_guard': case 'night_dream': case 'crow_curse':
        case 'wolfbeauty_charm': case 'admirer_crush':
          return { target: first };
        default: return { text: '过。', target: 0 };
      }
    },
  });

  const board = { wolf: 2, seer: 1, witch: 1, villager: 3 };
  const players = Array.from({ length: 7 }, (_, i) => ({ name: `P${i + 1}` }));
  const g = new Game({ id: 'stale-guard', board, players, agentFactory: peacefulFactory, stepPauseMs: 0, logger: silent });
  await runGame(g);

  assert.strictEqual(g.aliveSeats().length, 7, '这一局的前提是"没人出局"');
  assert.ok(g.finished, '对局必须结束（护栏失效就会无限打下去）');
  assert.strictEqual(g.winner, 'draw', `无人出局必须判平局，实际 ${g.winner}`);
  assert.match(g.winReason, /无人出局/, `结算原因要写清是僵局护栏：${g.winReason}`);
  assert.ok(g.day <= STALE_DAYS + 1, `应在 ${STALE_DAYS} 天左右结算，实际打到第 ${g.day} 天`);
});
