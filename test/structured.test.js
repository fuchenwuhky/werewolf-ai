/**
 * structured.test.js — 结构化输出（response_format: json_schema）
 *
 * 关键验收：schema 里 target 的 enum 必须**恰好等于** validatePayload 接受的集合。
 *   - 若 enum ⊃ 接受集：模型仍可能吐出会被拒的值（等于没解决问题）
 *   - 若 enum ⊂ 接受集：白白缩小了模型的合法选择空间，可能逼它犯规
 * 这条交叉验证把"服务商约束"和"引擎校验"钉在一起，两边都不会漂移。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { schemaFor, seatProp } = require('../src/ai/schemas');
const { validatePayload } = require('../src/engine/flow');
const { Game } = require('../src/engine/game');
const { chatCompletion, currentStructuredMode, resetStructuredMode } = require('../src/ai/llm');
const { LlmScheduler } = require('../src/ai/scheduler');
const { Agent } = require('../src/ai/agent');
const { runGame } = require('../src/engine/flow');
const { ROLES } = require('../src/engine/roles');
const { makeMockAgentFactory } = require('../scripts/mock-agent');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeGame(board) {
  const b = board || { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 12; i++) players.push({ name: `P${i + 1}`, isHuman: false });
  const g = new Game({ id: 'schema-test', board: b, players, stepPauseMs: 1, logger: silentLogger });
  g.deal();
  return g;
}

const jsonResp = (content) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
});
const errResp = (status, body) => ({
  ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body),
});

// ---------- Schema 形状 ----------
test('Schema：严格模式要求全部属性必填且不允许额外属性', () => {
  const rf = schemaFor('vote', { candidates: [1, 2, 3], allowNone: true }, { aliveSeats: [1, 2, 3] });
  assert.strictEqual(rf.type, 'json_schema');
  assert.strictEqual(rf.json_schema.strict, true);
  assert.strictEqual(rf.json_schema.name, 'ww_vote');
  const s = rf.json_schema.schema;
  assert.strictEqual(s.additionalProperties, false);
  assert.deepStrictEqual(s.required, Object.keys(s.properties));
  assert.ok(s.required.includes('target'));
});

test('Schema：target 枚举来自候选座位；allowNone 才允许 0', () => {
  const withNone = schemaFor('night_guard', { candidates: [3, 5, 7], allowNone: true }).json_schema.schema.properties.target;
  assert.deepStrictEqual(withNone.enum, [0, 3, 5, 7]);
  const noNone = schemaFor('wolf_kill', { candidates: [3, 5, 7], allowNone: false }).json_schema.schema.properties.target;
  assert.deepStrictEqual(noNone.enum, [3, 5, 7]);
  assert.ok(!noNone.enum.includes(0), '不允许空刀时不得出现 0');
});

test('Schema：无候选时不加 enum（空 enum 非法），交给校验层兜底', () => {
  const p = seatProp([], {});
  assert.strictEqual(p.type, 'integer');
  assert.strictEqual(p.enum, undefined);
  // 过滤非法值与非正整数
  assert.deepStrictEqual(seatProp([2, 'x', null, -1, 0, 2, 4], {}).enum, [2, 4]);
});

test('Schema：未知任务返回 null（不加约束，不报错）', () => {
  assert.strictEqual(schemaFor('reflection', {}), null);
  assert.strictEqual(schemaFor('some_future_task', {}), null);
  assert.strictEqual(schemaFor('direction', {}).json_schema.schema.properties.direction.enum.length, 2);
});

// ---------- 交叉验证：enum ≡ 引擎接受的集合 ----------
test('交叉验证：target 的 enum 恰好等于 validatePayload 接受的集合', () => {
  const g = makeGame();
  const seat = 4;
  const alive = g.aliveSeats().filter((s) => s !== seat);
  // probe(t) 必须构造出"该条件真正生效"的载荷，否则校验层会放行任意 target（条件为假时它不看 target）
  const plain = (t) => ({ target: t });
  const cases = [
    ['night_guard', { candidates: alive, allowNone: true }, plain],
    ['wolf_kill', { candidates: alive, allowNone: false }, plain],
    ['vote', { candidates: alive, allowNone: true }, plain],
    ['sheriff_vote', { candidates: alive, allowNone: true }, plain],
    ['pk_vote', { candidates: alive, allowNone: true }, plain],
    ['seer_check', { candidates: alive }, plain],
    ['night_dream', { candidates: alive }, plain],
    ['crow_curse', { candidates: alive }, plain],
    ['wolfbeauty_charm', { candidates: alive }, plain],
    ['admirer_crush', { candidates: alive }, plain],
    ['badge_pass', {}, plain],
    ['shoot', {}, plain],
    ['duel_check', { candidates: alive }, (t) => ({ duel: true, target: t })],
  ];
  for (const [task, req, probe] of cases) {
    const schema = schemaFor(task, req, { aliveSeats: g.aliveSeats(), seat }).json_schema.schema.properties.target;
    const accepted = [];
    for (let t = 0; t <= 12; t++) {
      if (validatePayload(task, probe(t), req, g, seat).ok) accepted.push(t);
    }
    assert.ok(accepted.length > 0, `${task} 至少应有一个可接受值`);
    assert.deepStrictEqual(schema.enum || [], accepted,
      `${task}: schema enum 与校验层接受集不一致（enum 必须严丝合缝）`);
  }
  // 发言类的自爆带人目标只在白狼王身上被校验 → 必须真发一张含白狼王的板子才测得到。
  // 这条覆盖"白狼王技能曾因 request 缺 candidates 而永远无法通过校验（死代码 + 每次白烧两次重试）"。
  const gw2 = makeGame({ wolf: 2, whitewolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 5 });
  const wwk = gw2.players.find((p) => p.role === 'whitewolfking');
  assert.ok(wwk, '板子应包含白狼王');
  for (const task of ['speech', 'sheriff_speech', 'pk_speech']) {
    const cand = gw2.aliveSeats().filter((x) => x !== wwk.seat);
    const req = { candidates: cand, canExplode: true };
    const enumVals = schemaFor(task, req, { aliveSeats: gw2.aliveSeats(), seat: wwk.seat }).json_schema.schema.properties.target.enum;
    const acceptedExplode = [];
    for (let t = 0; t <= 12; t++) {
      if (validatePayload(task, { text: 'x', explode: true, target: t }, req, gw2, wwk.seat).ok) acceptedExplode.push(t);
    }
    assert.deepStrictEqual(enumVals, acceptedExplode, `${task}: 白狼王自爆带人目标 enum 必须与校验层一致`);
    assert.ok(enumVals.length > 0, `${task}: 白狼王自爆必须有合法目标可选（否则技能仍是死代码）`);
    assert.ok(!enumVals.includes(wwk.seat), `${task}: 不得带走自己`);
  }
  // 反向验证：缺 candidates 时白狼王自爆必然失败——这就是修复前的真实状态
  const brokenReq = { canExplode: true }; // 故意不传 candidates
  const broken = validatePayload('speech', { text: 'x', explode: true, target: 1 }, brokenReq, gw2, wwk.seat);
  assert.strictEqual(broken.ok, false, '缺 candidates 时确实无法通过校验（修复前状态）');
  // 女巫毒药走同一套
  const gw = makeGame();
  const wreq = { extra: { canAntidote: false, canPoison: true, killTarget: 0, selfSaveAllowed: false } };
  const poisonEnum = schemaFor('witch', wreq, { aliveSeats: gw.aliveSeats() }).json_schema.schema.properties.poison.enum;
  const acceptedPoison = [];
  for (let t = 0; t <= 12; t++) {
    if (validatePayload('witch', { poison: t }, wreq, gw, 3).ok) acceptedPoison.push(t);
  }
  assert.deepStrictEqual(poisonEnum, acceptedPoison, 'witch.poison enum 必须与校验层一致');
});

test('交叉验证：条件任务（展开后才检查目标）至少必须"可靠"——enum 里的值绝不被拒', () => {
  const g = makeGame();
  const seat = 7;
  // explode_check 的 target 只在白狼王身上被校验；本板无白狼王 → 校验层放行任意值。
  // 因此这里只要求可靠性：schema 允许的值，校验层必须接受（不能出现"照 schema 填还被拒"）。
  const cases = [
    ['explode_check', {}, (t) => ({ explode: true, target: t }), { aliveSeats: g.aliveSeats(), seat }],
    ['speech', { candidates: g.aliveSeats().filter((x) => x !== seat), canExplode: true }, (t) => ({ text: 'x', explode: true, target: t }), { aliveSeats: g.aliveSeats(), seat }],
    ['sheriff_speech', { candidates: g.aliveSeats().filter((x) => x !== seat), canExplode: true }, (t) => ({ text: 'x', explode: true, target: t }), { aliveSeats: g.aliveSeats(), seat }],
    ['pk_speech', { candidates: g.aliveSeats().filter((x) => x !== seat), canExplode: true }, (t) => ({ text: 'x', explode: true, target: t }), { aliveSeats: g.aliveSeats(), seat }],
  ];
  for (const [task, req, probe, opts] of cases) {
    const schema = schemaFor(task, req, opts).json_schema.schema.properties.target;
    assert.ok(schema.enum && schema.enum.length, `${task} 必须给出可选目标`);
    for (const t of schema.enum) {
      const v = validatePayload(task, probe(t), req, g, seat);
      assert.strictEqual(v.ok, true, `${task}: schema 允许 target=${t}，校验层却拒绝了——模型照 schema 填也会被判非法`);
    }
  }
});

// ---------- 下发与降级 ----------
test('下发：auto 模式下请求体带 response_format', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return jsonResp('{"target":2}'); };
  try {
    const rf = schemaFor('vote', { candidates: [1, 2, 3], allowNone: false });
    await chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, structuredOutput: 'auto' },
      [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), responseFormat: rf, meta: {} });
    assert.deepStrictEqual(sent.response_format, rf);
  } finally { global.fetch = orig; resetStructuredMode(); }
});

test('下发：structuredOutput=off 时从不下发 response_format', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return jsonResp('{"target":2}'); };
  try {
    const rf = schemaFor('vote', { candidates: [1, 2, 3] });
    await chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, structuredOutput: 'off' },
      [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), responseFormat: rf, meta: {} });
    assert.strictEqual(sent.response_format, undefined);
  } finally { global.fetch = orig; resetStructuredMode(); }
});

test('降级：400 → json_object → off，逐级自适应且不消耗重试预算', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  const bodies = [];
  let n = 0;
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    n++;
    if (n <= 2) return errResp(400, { error: { code: '1214', message: 'response_format 参数非法' } });
    return jsonResp('{"target":3}');
  };
  try {
    const rf = schemaFor('vote', { candidates: [1, 2, 3] });
    const out = await chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, structuredOutput: 'auto' },
      [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), responseFormat: rf, meta: {} });
    assert.strictEqual(bodies.length, 3, 'retries:0 也要完成两级降级重试（降级不占重试预算）');
    assert.strictEqual(bodies[0].response_format.type, 'json_schema');
    assert.deepStrictEqual(bodies[1].response_format, { type: 'json_object' });
    assert.strictEqual(bodies[2].response_format, undefined, '最终退回纯提示词模式');
    assert.strictEqual(currentStructuredMode(), 'off');
    assert.strictEqual(out.content, '{"target":3}');
  } finally { global.fetch = orig; resetStructuredMode(); }
});

test('降级：只降一次到 json_object 后成功（服务商支持 json_object 但不支持 json_schema）', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  let n = 0;
  const bodies = [];
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    n++;
    if (n === 1) return errResp(400, { error: { code: '1214' } });
    return jsonResp('{"target":1}');
  };
  try {
    const rf = schemaFor('vote', { candidates: [1, 2, 3] });
    await chatCompletion({ baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, structuredOutput: 'auto' },
      [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), responseFormat: rf, meta: {} });
    assert.strictEqual(currentStructuredMode(), 'json_object');
    assert.deepStrictEqual(bodies[1].response_format, { type: 'json_object' });
  } finally { global.fetch = orig; resetStructuredMode(); }
});

test('强制 json_schema：不降级，失败直接暴露（便于配置排查）', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  let n = 0;
  global.fetch = async () => { n++; return errResp(400, { error: { code: '1214', message: '不支持 json_schema' } }); };
  try {
    const rf = schemaFor('vote', { candidates: [1, 2, 3] });
    await assert.rejects(() => chatCompletion(
      { baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, structuredOutput: 'json_schema' },
      [{ role: 'user', content: 'hi' }], { scheduler: new LlmScheduler(), responseFormat: rf, meta: {} }));
    assert.strictEqual(n, 1, '强制模式不得静默降级重试');
    assert.strictEqual(currentStructuredMode(), 'json_schema');
  } finally { global.fetch = orig; resetStructuredMode(); }
});

// ---------- Agent 集成 ----------
test('集成：Agent.decide 为任务生成带候选枚举的 response_format', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return jsonResp('{"target":5}'); };
  try {
    const g = makeGame();
    g.day = 1;
    const agent = new Agent(g.player(2), g, {
      baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, contextBudget: 4000, structuredOutput: 'auto', effortPolicy: 'flat',
    }, silentLogger);
    const alive = g.aliveSeats();
    const p = await agent.decide({ task: 'seer_check', candidates: alive.filter((s) => s !== 2) });
    assert.strictEqual(p.target, 5);
    assert.ok(sent.response_format, '应下发结构化约束');
    const enumVals = sent.response_format.json_schema.schema.properties.target.enum;
    assert.ok(enumVals.includes(5));
    assert.ok(!enumVals.includes(2), '自己不应出现在查验候选里');
    assert.strictEqual(g.llmStats.structuredLevel, 'json_schema', '生效级别应进入遥测');
  } finally { global.fetch = orig; resetStructuredMode(); }
});

test('集成：结构化输出不改变游戏语义——仍由 validatePayload 拍板（纵深防御）', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  // 假服务商无视 schema，硬吐一个非法目标
  global.fetch = async () => jsonResp('{"target":99}');
  try {
    const g = makeGame();
    g.day = 1;
    const agent = new Agent(g.player(6), g, {
      baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, contextBudget: 4000, structuredOutput: 'auto', effortPolicy: 'flat',
    }, silentLogger);
    const req = { task: 'seer_check', candidates: g.aliveSeats().filter((s) => s !== 6) };
    const payload = await agent.decide(req); // 解析层不校验语义
    assert.strictEqual(payload.target, 99);
    const v = validatePayload('seer_check', payload, req, g, 6);
    assert.strictEqual(v.ok, false, '非法目标必须仍被引擎拒绝——schema 只是第一道闸，不是唯一一道');
  } finally { global.fetch = orig; resetStructuredMode(); }
});

test('集成：未知任务（反思等）不加结构化约束，一次调用照常完成', async () => {
  resetStructuredMode();
  const orig = global.fetch;
  let sent = null;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return jsonResp('{"target":1}'); };
  try {
    const g = makeGame();
    const agent = new Agent(g.player(3), g, {
      baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 0, contextBudget: 4000, structuredOutput: 'auto', effortPolicy: 'flat',
    }, silentLogger);
    await agent.decide({ task: 'unknown_future_task' });
    assert.strictEqual(sent.response_format, undefined);
  } finally { global.fetch = orig; resetStructuredMode(); }
});

// ---------- 回归：白狼王的自爆带人（修复前是死代码） ----------
test('流程回归：白狼王白天发言自爆可带走目标（此前永远无法通过校验）', async () => {
  // 9 人局：5 人局里 2 狼对 2 好会立即判狼胜，白狼王根本来不及发言
  const board = { wolf: 2, whitewolfking: 1, seer: 1, hunter: 1, villager: 4 };
  const players = Array.from({ length: 9 }, (_, i) => ({ name: `P${i + 1}`, isHuman: false }));
  const mock = makeMockAgentFactory(Math.random, {});
  const g = new Game({
    id: 'wwk-explode', board, rules: { sheriff: false, allowSelfExplode: true }, players,
    stepPauseMs: 1, logger: silentLogger,
    agentFactory: (player, game) => {
      const base = mock(player, game);
      return {
        async decide(req) {
          const isWolfSide = ROLES[player.role] && ROLES[player.role].team === 'wolf';
          // 白狼王在白天发言时必定自爆带人（技能正是这么用的）
          if (player.role === 'whitewolfking' && req.task === 'speech') {
            const t = game.aliveSeats().find((x) => x !== player.seat);
            return t ? { text: '我是白狼王，爆了，带他走。', explode: true, target: t } : { text: '我过。' };
          }
          if (isWolfSide) {
            // 夜间的自爆意向一律否掉：普通狼人自爆不带人是合法行为，会干扰"恰好一次 explode"的断言
            if (req.task === 'explode_check') return { explode: false };
            // 固定刀村民：刀到猎人会被开枪随机带走白狼王，刀光神职会触发屠边直接判狼胜，
            // 两种情况都会让白狼王来不及在白天发言（测试要确定性地走到"发言时自爆"这条路径）
            if (req.task === 'wolf_kill' || req.task === 'wolf_chat' || req.task === 'wolf_propose') {
              const alive = game.aliveSeats();
              const prey = alive.find((x) => game.player(x).role === 'villager')
                || alive.find((x) => {
                  const r = game.player(x).role;
                  return r !== 'whitewolfking' && ROLES[r].team !== 'wolf';
                });
              if (prey) return req.task === 'wolf_kill' ? { target: prey } : { text: '今晚刀他。', target: prey };
            }
          }
          return base.decide(req);
        },
      };
    },
  });
  await runGame(g);

  const wwkSeat = g.players.find((p) => p.role === 'whitewolfking').seat;
  const explodes = g.events.filter((e) => e.type === 'explode');
  const mine = explodes.filter((e) => e.actor === wwkSeat);
  assert.strictEqual(mine.length, 1, `白狼王应自爆一次（修复前这次自爆根本无法通过校验，只会降级成"我过。"）；实际 explode 事件：${JSON.stringify(explodes.map((e) => [e.actor, e.data.target]))}`);
  const target = mine[0].data.target;
  assert.ok(target > 0, `白狼王应带走一名玩家，实际 target=${target}`);
  const victim = g.player(target);
  assert.strictEqual(victim.alive, false, '被带走的玩家应出局');
  assert.strictEqual(g.player(wwkSeat).alive, false, '自爆者自己出局');
  // rules.md：白狼王自爆"被带走者没有遗言"（默认 lastWords.shotVictim=false）
  const victimLastWords = g.events.filter((e) => e.type === 'speech' && e.actor === target && e.data && e.data.context === 'lastwords');
  assert.strictEqual(victimLastWords.length, 0, '被自爆带走者不得有遗言');
  // 已知问题（本轮有意不改）：死因用的是 'shot'，因此 UI 会把"被自爆带走"显示成"被枪带走"。
  // 词表里的 'explode_target' 在死亡路径上不可达；但改成它会连带改变狼王开枪触发与狼美人殉情链
  // （CHARM_TRIGGER_CAUSES 不含 explode_target），属于游戏语义改动，需单独决策。
  assert.strictEqual(victim.cause, undefined, '引擎不记录 per-player 死因（死因只在 deaths 事件里）');
  console.log(`      → 白狼王 ${wwkSeat}号 自爆带走 ${target}号；降级事件 ${g.events.filter((e) => e.type === 'llm_error').length} 次`);
});
