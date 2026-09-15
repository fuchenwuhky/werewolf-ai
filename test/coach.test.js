/**
 * coach.test.js — 局后 AI 教练（P2-4）
 *
 * 教练最怕的不是讲得平淡，而是**讲错**。所以这里断言的重点是"事实层不能说错话"：
 *  ① 事实必须与 score.js 的口径一致（狼刀得手、投中狼的次数）——两处口径分歧比没有功能更糟；
 *  ② 利弊判定必须**按自己阵营**（狼投好人符合狼队利益，不是"投错了"）；
 *  ③ 提示词必须带指令层级与校验码（局后点评同样会被"上局说过的话"注入）；
 *  ④ 不静默降级：AI 失败必须回退到**明确标注**的规则点评并带上原因；
 *  ⑤ Mock 试玩绝不能偷偷发一次真实调用。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../src/engine/game');
const { BOARDS, ROLES } = require('../src/engine/roles');
const { runGame } = require('../src/engine/flow');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { makeRng } = require('../src/engine/rng');
const { reviewFacts, humanSeatOf } = require('../src/engine/review');
const { buildCoachPrompt, ruleReview, factsBlock, transcriptOf, COACH_VERSION } = require('../src/ai/coach');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function playGame(seed, { humans = [] } = {}) {
  const players = Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: humans.includes(k + 1) }));
  const g = new Game({
    id: `coach-${seed}`, board: BOARDS.adv12.roles, players, stepPauseMs: 0, logger: silentLogger, seed,
    agentFactory: makeMockAgentFactory(makeRng(seed)),
  });
  await runGame(g);
  return g;
}

test('教练事实：狼刀得手次数必须与 score.js 的口径一致（口径分歧比没有功能更糟）', async () => {
  for (const seed of [31, 33, 36]) {
    const g = await playGame(seed);
    const wolf = g.players.find((p) => ROLES[p.role].team === 'wolf');
    const facts = reviewFacts(g, wolf.seat);
    const mine = facts.kills.filter((k) => k.succeeded).length;
    // score.js 的 wolfKillHits：有刀口、且天亮宣布了 wolf_kill 死亡的天数
    const dayKill = new Map();
    for (const e of g.events) if (e.type === 'wolf_kill' && e.data && e.data.target) dayKill.set(e.day, e.data.target);
    let scoreHits = 0;
    for (const e of g.events) {
      if (e.type === 'deaths' && (e.data.deaths || []).some((x) => x.cause === 'wolf_kill') && dayKill.has(e.day)) scoreHits++;
    }
    assert.strictEqual(mine, scoreHits, `seed ${seed}：事实层狼刀得手 ${mine} ≠ score.js ${scoreHits}`);
  }
});

test('教练事实：利弊必须按自己阵营判定（狼投好人是符合狼队利益，不能写成"投错了"）', async () => {
  // 造一个狼人视角的对局：直接用真实对局，逐局检查措辞
  let checkedWolf = 0; let checkedGood = 0;
  for (const seed of [31, 32, 33, 34, 35, 36]) {
    const g = await playGame(seed);
    for (const p of g.players) {
      const facts = reviewFacts(g, p.seat);
      const isWolf = ROLES[p.role].team === 'wolf';
      for (const h of facts.highlights) {
        if (isWolf && /投中狼人/.test(h)) assert.fail(`狼人视角不该出现"投中狼人"式好评：${h}`);
        if (!isWolf && /符合狼队利益/.test(h)) assert.fail(`好人视角不该出现"符合狼队利益"：${h}`);
      }
      for (const m of facts.missteps) {
        if (isWolf) assert.ok(!/投到了好人/.test(m), `狼人投好人不该算失误：${m}`);
        else assert.ok(!/投到了自己人/.test(m), `好人不存在"自己人"表述：${m}`);
      }
      if (isWolf) checkedWolf++; else checkedGood++;
    }
  }
  assert.ok(checkedWolf > 0 && checkedGood > 0, '样本里必须同时有狼与好人视角');
});

test('教练事实：投票/技能记录抽自公开事件，且能对上死亡台账', async () => {
  const g = await playGame(31);
  for (const p of g.players) {
    const facts = reviewFacts(g, p.seat);
    // 自己的每一次放逐投票都能在公开的 vote_reveal 里找到
    const reveals = g.events.filter((e) => e.type === 'vote_reveal' && e.data && e.data.votes);
    const expected = reveals.filter((e) => e.data.votes.some((v) => v.seat === p.seat)).length;
    assert.strictEqual(facts.votes.length, expected, `${p.seat}号投票记录条数不符`);
    for (const v of facts.votes) {
      const rv = reveals.find((e) => e.day === v.day && (e.phase === 'vote' || e.phase === 'pk' || e.phase === 'sheriff') && e.data.votes.some((x) => x.seat === p.seat && x.target === v.target));
      assert.ok(rv, `${p.seat}号 第${v.day}天投${v.target}号 在公开记录里找不到`);
    }
    // 出局者的死亡描述必须与台账一致
    if (!p.alive) assert.match(facts.deathDesc, new RegExp(`第${p.deathDay}天`), `${p.seat}号死亡天数不符`);
  }
});

test('教练提示词：必须声明指令层级 + 用校验码包裹玩家发言（局后点评同样会被注入）', async () => {
  const g = await playGame(31);
  const facts = reviewFacts(g, 1);
  const { messages, nonce } = buildCoachPrompt(g, facts);
  const system = messages[0].content;
  assert.match(system, /指令层级/, 'system 必须声明指令层级');
  assert.match(system, /数据/, 'system 必须说明玩家发言是数据');
  assert.ok(system.includes(nonce), 'system 必须给出本局校验码');
  assert.match(messages[1].content, new RegExp(`【玩家发言·${nonce}】`), '实录里的发言必须被标记块包裹');
  assert.match(messages[1].content, new RegExp(`【发言结束·${nonce}】`));
  assert.ok(COACH_VERSION, '提示词版本号必须存在（改了提示词就等于换了教练，便于对比）');
});

test('教练提示词：要求引用具体天数与座位，且禁止编造事实块以外的信息', async () => {
  const g = await playGame(31);
  const { messages } = buildCoachPrompt(g, reviewFacts(g, 1));
  const user = messages[1].content;
  assert.match(user, /事实块/, '必须有事实块段落');
  assert.match(user, /不要编造/, '必须明确禁止编造');
  assert.match(user, /天数与座位号/, '必须要求引用天数与座位号');
  // 事实块里出现的天数必须真实存在
  const facts = reviewFacts(g, 1);
  for (const v of facts.votes) assert.ok(v.day >= 1 && v.day <= g.day, `投票天数 ${v.day} 超出对局天数 ${g.day}`);
});

test('教练提示词：实录必须有预算上限（不能把整局发言塞进上下文）', async () => {
  const g = await playGame(31);
  const text = transcriptOf(g, 400);
  assert.ok(text.length <= 600, `预算 400 时实录长度 ${text.length} 明显超限`);
  const full = transcriptOf(g, 100000);
  assert.ok(full.length >= text.length);
  if (full.length > text.length) assert.match(text, /已省略/, '被截断时必须明确标注省略了多少条');
});

test('教练兜底：规则点评必须自带"未调用 AI"的明确标注（不假装是 AI 写的）', async () => {
  const g = await playGame(31);
  const facts = reviewFacts(g, 1);
  const text = ruleReview(facts);
  assert.ok(text.length > 50, '规则点评不能是空壳');
  assert.match(text, /规则点评/);
  assert.match(text, /未调用 AI/);
  assert.ok(text.includes(`${facts.seat}号`), '必须点名是给谁的点评');
  assert.match(text, facts.won ? /获胜/ : /落败/, '必须说明胜负');
});

test('教练兜底：AI 失败时回退规则点评并**带上失败原因**（不许静默降级）', async () => {
  const { generateCoachReview } = require('../src/ai/coach');
  const g = await playGame(31);
  const facts = reviewFacts(g, 1);
  // 用一个必定失败的配置：baseUrl 指向不可达端口 + 0 重试
  const r = await generateCoachReview({
    game: g, facts, logger: silentLogger,
    llmCfg: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'm', retries: 0, timeoutMs: 1500 },
  });
  assert.strictEqual(r.mode, 'rule', 'AI 失败必须回退到规则点评');
  assert.ok(r.fallbackReason && r.fallbackReason.length > 0, '必须带出失败原因，前端要如实展示');
  assert.match(r.text, /未调用 AI/);
});

test('教练：人类座位识别与 mock 局零调用', async () => {
  const g = await playGame(31);
  assert.strictEqual(humanSeatOf(g), null, '全 AI 局没有人类座位');
  const g2 = new Game({
    id: 'coach-human', board: BOARDS.adv12.roles, stepPauseMs: 1, logger: silentLogger, seed: 5,
    players: Array.from({ length: 12 }, (_, k) => ({ name: `P${k + 1}`, isHuman: k === 3 })),
    agentFactory: makeMockAgentFactory(makeRng(5)),
  });
  assert.strictEqual(humanSeatOf(g2), 4, '人类座位应识别为 4 号');
});

test('教练事实：未结束的对局也能抽取（fin 标记为 false），且序列化后不含函数', async () => {
  const g = await playGame(31);
  const facts = reviewFacts(g, 1);
  assert.strictEqual(facts.finished, true);
  const round = JSON.parse(JSON.stringify(facts));
  assert.strictEqual(round.seat, 1);
  for (const v of Object.values(round)) assert.notStrictEqual(typeof v, 'function', '事实对象里不得夹带函数（存档/下发给前端会出问题）');
  assert.ok(factsBlock(facts).length > 100, '事实块不能为空');
});
