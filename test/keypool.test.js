/**
 * keypool.test.js — 多 Key 通道池（keypool P1/P2/P3）
 *
 * 先说结论（实测，见 docs/fluency-plan.md §1.4）：多 Key 的天花板约 **-23%**，不是"减半"，
 * 因为语义串行的发言链占了 73% 的耗时。所以这一层的定位是"**本来就有多个 Key 时别浪费**"，
 * 不是"买 Key 提速"。默认仍然是单通道。
 *
 * 本文件的守卫围绕两件事：
 *   ① **单 Key 零变化**：通道数 1 时，队列语义（优先级/老化/FIFO/快照字段）必须与旧版一致 ——
 *      这是敢动调度器的前提；
 *   ② **多 Key 才并行**：n 个 Key → 至多 n 个在途；坏 Key 被摘掉后不影响其他通道；
 *      而且 `game.parallelLlm` 为假时引擎**不扇出**（否则"正在思考"提示会显示错人）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LlmScheduler, PRIORITY } = require('../src/ai/scheduler');
const { parseApiKeys, resolveChannels, perKeyChannels, canFanOut, DEFAULT_CONFIG } = require('../src/config');
const { Game } = require('../src/engine/game');
const { makeMockAgentFactory } = require('../scripts/mock-agent');
const { _internals } = require('../src/engine/flow');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('解析 Key 池：数组与字符串合并、去重、忽略脱敏占位', () => {
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'a' }), ['a']);
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'a,b c\nd' }), ['a', 'b', 'c', 'd'], '逗号/空格/换行都要支持');
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'a', apiKeys: ['b', 'a'] }), ['a', 'b'], '合并去重');
  // 同一个 Key 填两遍会产生两条通道 = 自己撞自己的限流，必须在解析层就消掉
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'x,x,x' }), ['x']);
  assert.deepStrictEqual(parseApiKeys({ apiKey: 'sk-****abcd' }), [], '脱敏占位不是真 Key');
  assert.deepStrictEqual(parseApiKeys({}), []);
  assert.deepStrictEqual(parseApiKeys(null), []);
});

test('单通道：串行语义与稳定性不变（入队即刻开跑；积压内按优先级 + FIFO）', async () => {
  const s = new LlmScheduler({ channels: 1 });
  const order = [];
  // 语义澄清（旧版就是这样，别改错）：enqueue 会立刻尝试开跑，
  // 所以"第一个入队的一定先跑"；优先级只对**积压中**的任务排序。
  const gate = s.enqueue(async () => { await sleep(15); order.push('first'); }, { label: 'gate' });
  const a = s.enqueue(async () => { order.push('reflection'); }, { priority: PRIORITY.reflection, label: 'r' });
  const b = s.enqueue(async () => { order.push('decision'); }, { priority: PRIORITY.decision, label: 'd' });
  await Promise.all([gate, a, b]);
  assert.deepStrictEqual(order, ['first', 'decision', 'reflection'], `积压内必须按优先级：${order}`);
  // 快照的旧字段必须还在（api.js 的空转检测依赖 depth/busy/current）
  const snap = s.snapshot();
  for (const k of ['depth', 'busy', 'current', 'total', 'failed', 'avgWaitMs', 'maxWaitMs', 'avgRunMs', 'byPriority', 'recent']) {
    assert.ok(k in snap, `快照缺少旧字段 ${k}（改名会让上帝面板与手机端静默失效）`);
  }
  assert.strictEqual(snap.channels, 1);
  assert.strictEqual(snap.slots.length, 1);
});

test('多通道：至多 n 个在途，且槽位与 Key 一一对应', async () => {
  const s = new LlmScheduler({ channels: 3 });
  let inFlight = 0;
  let peak = 0;
  const slots = [];
  const jobs = [];
  for (let i = 0; i < 9; i++) {
    jobs.push(s.enqueue(async (slot) => {
      slots.push(slot);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(6);
      inFlight--;
    }, { label: `j${i}` }));
  }
  await Promise.all(jobs);
  assert.strictEqual(peak, 3, `3 条通道同时最多 3 个在途（实际 ${peak}）`);
  assert.deepStrictEqual([...new Set(slots)].sort(), [0, 1, 2], '三个槽位都被用到（槽位即 Key 序号）');
  const snap = s.snapshot();
  assert.strictEqual(snap.channels, 3);
  assert.strictEqual(snap.slots.length, 3);
  assert.strictEqual(Object.values(snap.bySlot).reduce((a, b) => a + b, 0), 9, '每个任务都要归到某个槽位');
});

test('坏 Key 隔离：某通道致命失败后被临时摘除，其余通道继续干活', async () => {
  const s = new LlmScheduler({ channels: 2 });
  const fatal = new Error('配额已用尽');
  fatal.fatal = true;
  const seen = [];
  const first = s.enqueue(async (slot) => { seen.push(slot); throw fatal; }, { label: 'bad' });
  await assert.rejects(() => first, /配额已用尽/);
  const disabledSlot = seen[0];
  // 摘除后新请求只会派到另一个槽位
  const slots2 = [];
  for (let i = 0; i < 4; i++) {
    await s.enqueue(async (slot) => { slots2.push(slot); }, { label: `ok${i}` });
  }
  assert.ok(!slots2.includes(disabledSlot), `被摘除的通道 ${disabledSlot} 不应再派活：${slots2}`);
  const snap = s.snapshot();
  assert.ok(snap.slots[disabledSlot].disabled, '快照要能看出哪个通道被摘除');
  assert.match(snap.slots[disabledSlot].lastError, /配额/, '摘除原因要留档');
});

test('引擎扇出开关：只要"可能跑出 >1 并发"就开（含单 Key + 自适应）', () => {
  const board = { wolf: 1, seer: 1, villager: 4 };
  const players = [];
  for (let i = 0; i < 6; i++) players.push({ name: `P${i + 1}` });
  const mk = (parallelLlm) => new Game({ id: 'kp', board, players, agentFactory: makeMockAgentFactory(Math.random), stepPauseMs: 0, logger: { debug() {}, info() {}, warn() {}, error() {} }, parallelLlm });
  assert.strictEqual(mk(true).parallelLlm, true, '显式开：扇出');
  assert.strictEqual(mk(false).parallelLlm, false, '显式关：不扇出（严格串行的回滚开关）');
  // 真正的并发度由调度器按住每把 Key 的实时额度决定，引擎只表达"这些调用互不依赖"。
  // 所以单 Key + 自适应开着时也要扇出 —— 否则调度器把额度探到 3 条也白搭。
  assert.strictEqual(canFanOut({ apiKey: 'a' }), true, '单 Key + 默认自适应 → 允许扇出');
  assert.strictEqual(canFanOut({ apiKey: 'a', adaptiveConcurrency: false }), false, '单 Key + 关自适应 → 严格串行');
  assert.strictEqual(canFanOut({ apiKey: 'a,b' }), true, '多 Key → 允许扇出');
  assert.strictEqual(canFanOut({ apiKey: 'a,b', adaptiveConcurrency: false }), true, '多 Key 关自适应仍有多条泳道');
  assert.strictEqual(canFanOut({ apiKey: 'a', llmChannels: 3 }), true, '显式总并发 → 允许扇出');
});

test('目录一致性：默认配置起手仍是单泳道（不能悄悄改变所有人的计费/限流行为）', () => {
  assert.deepStrictEqual(parseApiKeys(DEFAULT_CONFIG), [], '出厂默认没有 Key → 单泳道');
  assert.strictEqual(resolveChannels(DEFAULT_CONFIG), 1, '默认起始通道数 1');
  assert.strictEqual(perKeyChannels(DEFAULT_CONFIG, 1), 1, '默认每把 Key 起始 1 条泳道');
  assert.strictEqual(DEFAULT_CONFIG.adaptiveConcurrency, true, '自适应默认开（否则单 Key 用户拿不到任何并发收益）');
  const s = new LlmScheduler();
  assert.strictEqual(s.channels, 1, '调度器默认 1 条泳道');
  assert.strictEqual(s.maxPerKey, DEFAULT_CONFIG.maxChannelsPerKey, '调度器默认上限与配置一致');
});

test('每把 Key 的起始泳道数：llmChannels 平均摊到各 Key；自适应则从 1 起', () => {
  assert.strictEqual(perKeyChannels({ llmChannels: 0 }, 1), 1, '自适应：从最保守的 1 起');
  assert.strictEqual(perKeyChannels({ llmChannels: 0 }, 3), 1, '三把 Key 也是每把 1 起');
  assert.strictEqual(perKeyChannels({ llmChannels: 4 }, 1), 4, '显式 4 → 单 Key 4 条泳道');
  assert.strictEqual(perKeyChannels({ llmChannels: 4 }, 2), 2, '显式 4 → 两把 Key 各 2 条');
  assert.strictEqual(perKeyChannels({ llmChannels: 2 }, 3), 1, '显式 2 分给 3 把 Key 也不能是 0');
});

test('resolveChannels：起始通道数只有一个来源（否则会出现"配了没生效"）', () => {
  assert.strictEqual(resolveChannels({ apiKey: 'a' }), 1);
  assert.strictEqual(resolveChannels({ apiKey: 'a,b,c' }), 3, 'Key 数 = 起始通道数');
  assert.strictEqual(resolveChannels({ apiKey: 'a', apiKeys: ['b'] }), 2);
  assert.strictEqual(resolveChannels({ apiKey: 'a,b', llmChannels: 4 }), 4, '显式指定优先');
  assert.strictEqual(resolveChannels({ apiKey: 'a,b,c', llmChannels: 1 }), 1, '显式指定也能强制串行（回滚开关）');
  assert.strictEqual(resolveChannels({}), 1, '什么都没配也是 1，不能算出 0 条通道');
});

test('探测并发额度：逐档加并发，撞限流立即停在上一档', async () => {
  const { probeKey } = require('../src/ai/probe');
  const seen = [];
  const oneCall = async ({ tag }) => {
    const n = Number(String(tag).split('-')[0].slice(1));
    seen.push(n);
    // 服务商允许 2 并发：第 3 档返回 429
    return n >= 3 ? { ok: false, status: 429, ms: 5, body: '{"error":{"code":1302,"message":"触发限流"}}' } : { ok: true, status: 200, ms: 10, body: '{}' };
  };
  const r = await probeKey({ baseUrl: 'http://x', apiKey: 'k', model: 'm', max: 5, oneCall });
  assert.strictEqual(r.limit, 2, '已知能跑通的最高并发是 2');
  assert.match(r.reason, /限流/);
  assert.strictEqual(r.fatal, true, '限流是额度边界，应标记为"到此为止"');
  assert.deepStrictEqual([...new Set(seen)].sort(), [1, 2, 3], '探到 3 撞限流就该停，不许继续加档');
  assert.strictEqual(r.results.filter((x) => x.ok).length, 2, '成功档数 = limit');
});

test('探测并发额度：全部档都成功时报"探到上限"，而不是谎称服务商只允许这么多', async () => {
  const { probeKey } = require('../src/ai/probe');
  const oneCall = async () => ({ ok: true, status: 200, ms: 8, body: '{}' });
  const r = await probeKey({ baseUrl: 'http://x', apiKey: 'k', model: 'm', max: 3, oneCall });
  assert.strictEqual(r.limit, 3);
  assert.strictEqual(r.fatal, false);
  assert.match(r.reason, /可能还能更高/, '不能把"我没探更高"说成"服务商就这么点额度"');
});

test('探测并发额度：缺配置时不发请求就返回 1（避免无意义地打服务商）', async () => {
  const { probeKey } = require('../src/ai/probe');
  let called = 0;
  const r = await probeKey({ baseUrl: '', apiKey: '', model: '', oneCall: async () => { called++; return { ok: true }; } });
  assert.strictEqual(r.limit, 1);
  assert.strictEqual(called, 0);
});

// ---------- 夜晚扇出（keypool P3 的第二块收益） ----------

/**
 * 按 **LLM 调用**观察并发（而不是按步骤函数）：给每次 game.ask 加一个 4ms 的在途窗口，
 * 没有并发时永远不会有两次调用同时在飞 —— 这比"看函数进出"更贴近我们真正关心的东西。
 */
function instrumentAsks(game) {
  const log = [];
  let open = 0;
  let peak = 0;
  const orig = game.ask.bind(game);
  game.ask = async (seat, req) => {
    open++;
    if (open > peak) peak = open;
    log.push({ task: req.task, seat, at: 'start' });
    try {
      await sleep(4);
      return await orig(seat, req);
    } finally {
      open--;
      log.push({ task: req.task, seat, at: 'end' });
    }
  };
  return { log, peak: () => peak };
}

const NIGHT_BOARD = { wolf: 2, seer: 1, witch: 1, guard: 1, dreamer: 1, villager: 2 };
/**
 * 夜晚测试局必须**完全确定**：固定 seed（发牌确定）+ 恒定 rnd（mock 决策确定）。
 * 否则"串行 vs 并发"比较的其实是两局不同的牌 —— 第一版就踩了这个坑：
 * 用 Math.random 时两种路径的事件类型当然会不同，于是用例偶发失败（假警报）。
 */
function makeNightGame(parallelLlm) {
  const players = [];
  for (let i = 0; i < 8; i++) players.push({ name: `P${i + 1}` });
  const g = new Game({
    id: 'night', board: NIGHT_BOARD, players, parallelLlm, stepPauseMs: 0, seed: 4242,
    agentFactory: makeMockAgentFactory(() => 0.5),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  g.deal(); // 必须发牌：夜晚步骤的 present()/actors() 都看真实身份
  return g;
}

test('夜晚并发：单通道下夜晚调用严格串行（峰值在途恒为 1）', async () => {
  const g = makeNightGame(false);
  const probe = instrumentAsks(g);
  await _internals.nightPhase(g);
  const tasks = probe.log.filter((e) => e.at === 'start').map((e) => e.task);
  assert.ok(tasks.includes('wolf_kill') || tasks.includes('wolf_chat'), `狼人步骤必须跑过（实际调用：${tasks}）`);
  assert.ok(tasks.includes('witch'), `女巫步骤必须跑过（实际调用：${tasks}）`);
  assert.strictEqual(probe.peak(), 1, '单通道下任何时刻至多 1 个在途调用 —— 这是单 Key 用户的既有行为');
});

test('夜晚并发：多通道下独立步骤重叠，但女巫永远在狼刀之后', async () => {
  const g = makeNightGame(true);
  const probe = instrumentAsks(g);
  await _internals.nightPhase(g);
  const endOf = (t) => probe.log.map((e) => e.task).lastIndexOf(t) >= 0
    ? probe.log.filter((e) => e.task === t).slice(-1)[0] : null;
  const startOf = (t) => probe.log.find((e) => e.task === t && e.at === 'start');
  const wolfEnd = probe.log.filter((e) => (e.task === 'wolf_kill' || e.task === 'wolf_chat') && e.at === 'end').length;
  assert.ok(wolfEnd > 0, '狼队必须有调用');
  const wolfLastEnd = probe.log.map((e, i) => (e.task === 'wolf_kill' && e.at === 'end' ? i : -1)).filter((i) => i >= 0).pop();
  const witchStart = probe.log.findIndex((e) => e.task === 'witch' && e.at === 'start');
  assert.ok(witchStart > wolfLastEnd, `女巫必须等狼刀结束（witch@${witchStart} vs wolf_kill end@${wolfLastEnd}）`);
  assert.ok(probe.peak() >= 2, `多通道下应当出现并发在途（峰值 ${probe.peak()}）`);
  void endOf; void startOf;
  // 步骤播报顺序不受并发影响：仍按 nightOrder，序号 1..N
  const announced = g.events.filter((e) => e.type === 'night_step').map((e) => e.data.step);
  const idx = g.events.filter((e) => e.type === 'night_step').map((e) => e.data.index);
  assert.deepStrictEqual(idx, announced.map((_, i) => i + 1), '序号必须是 1..N');
  assert.ok(announced.length >= 4, `夜晚步骤数应为板子里存在的角色数（实际 ${announced})`);
});

test('上警报名：先问完所有人再公布（真实规则是"同时举手"）', async () => {
  // 旧实现是"问一个公布一个"：第 12 位报名者看得到前 11 位谁上警了。
  // sheriff_run 不在 NOISE_TYPES 里，所以那是**真的进了 AI 上下文**的信息泄露。
  // 现在两种通道数都必须满足：任何人在报名时，事件流里一条 sheriff_run 都还没有。
  for (const parallel of [false, true]) {
    const g = makeNightGame(parallel);
    const seen = [];
    const orig = g.ask.bind(g);
    g.ask = async (seat, req) => {
      if (req.task === 'sheriff_run') seen.push(g.events.filter((e) => e.type === 'sheriff_run').length);
      return orig(seat, req);
    };
    await _internals.electionPhase(g);
    assert.ok(seen.length >= 2, `应当逐人报名（实际 ${seen.length} 次，parallel=${parallel}）`);
    assert.deepStrictEqual([...new Set(seen)], [0], `报名时必须"盲选"（parallel=${parallel}，看到过 ${JSON.stringify(seen)}）`);
    const evs = g.events.filter((e) => e.type === 'sheriff_run');
    assert.strictEqual(evs.length, seen.length, '问过几个人就公布几条');
    assert.deepStrictEqual(evs.map((e) => e.actor), evs.map((e) => e.actor).slice().sort((a, b) => a - b), '公布顺序必须按座位');
  }
});

test('狼队投刀：先收完所有票再公布（人类狼与 AI 狼的信息条件一致）', async () => {
  for (const parallel of [false, true]) {
    const g = makeNightGame(parallel);
    const seen = [];
    const orig = g.ask.bind(g);
    g.ask = async (seat, req) => {
      if (req.task === 'wolf_kill') seen.push(g.events.filter((e) => e.type === 'wolf_kill_vote').length);
      return orig(seat, req);
    };
    await _internals.nightPhase(g);
    assert.ok(seen.length >= 2, `两只 AI 狼都要指刀（实际 ${seen.length} 次，parallel=${parallel}）`);
    assert.deepStrictEqual([...new Set(seen)], [0], `指刀时不能看到队友的票（parallel=${parallel}，看到过 ${JSON.stringify(seen)}）`);
  }
});

test('局终经验：多通道时各 AI 并行复盘，但经验池仍按顺序串行入库', async (t) => {
  const { Api } = require('../src/api');
  // NEW-17：必须显式给独占存档目录 —— 不传 saveDir 会落到默认 <repo>/saves，
  // 构造函数用 dirname 推导出的 <repo>/profiles、<repo>/migrations 是全机共享写点
  const { makeDataDir, savesOf, terminateAfter } = require('./helpers-tmpdir');
  const dataDir = makeDataDir('keypool-lessons');
  const added = [];
  // keyBinding 必须按服务端同一算法计算（baseUrl|apiKey|apiKeys 的 SHA-256）
  const kb = require('crypto').createHash('sha256').update('§k§').digest('hex');
  const api = new Api({
    config: { get: () => ({ apiKey: 'k', journal: false, keyBinding: kb }), save() {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    saveDir: savesOf(dataDir),
  });
  terminateAfter(t, api, dataDir);
  // Api 构造时会自建经验池（要落盘），测试里换成内存假实现 —— 只验证调用时序
  api.experience = { add: (l) => { added.push(l[0]); return l.length; } };
  let started = 0;
  let peak = 0;
  const mkAgent = (seat) => ({
    player: { seat, role: 'villager' },
    generateLessons: async () => {
      started++;
      peak = Math.max(peak, started);
      await sleep(6); // 没有并发时这个窗口里永远只有 1 个
      started--;
      return [`${seat}号的教训`];
    },
  });
  const entry = (parallelLlm) => ({
    game: {
      id: 'lessons', finished: true, started: true, parallelLlm,
      _agents: new Map([1, 2, 3, 4].map((s) => [s, mkAgent(s)])),
    },
  });
  peak = 0;
  await api.generateLessons(entry(false));
  assert.strictEqual(peak, 1, '单通道：逐个复盘');
  peak = 0;
  await api.generateLessons(entry(true));
  assert.strictEqual(peak, 4, `多通道：4 个 AI 应同时复盘（实际峰值 ${peak}）`);
  assert.deepStrictEqual(added, ['1号的教训', '2号的教训', '3号的教训', '4号的教训', '1号的教训', '2号的教训', '3号的教训', '4号的教训'], '入库顺序按座位，与并发无关');
});

test('夜晚并发：两种路径的事件类型与结算结果一致（并发不改变游戏语义）', async () => {
  const run = async (parallelLlm) => {
    const g = makeNightGame(parallelLlm);
    await _internals.nightPhase(g);
    return g;
  };
  // 固定 seed + 恒定 rnd ⇒ 两局除了"并发与否"之外完全同构，任何差异都来自并发本身
  const a = await run(false);
  const b = await run(true);
  const types = (g) => [...new Set(g.events.map((e) => e.type))].sort();
  assert.deepStrictEqual(types(b), types(a), '并发路径不得引入/遗漏任何事件类型');
  assert.deepStrictEqual(b.night.guardActions, a.night.guardActions, '守卫行动一致');
  assert.deepStrictEqual(b.night.dreamActions, a.night.dreamActions, '摄梦行动一致');
  assert.deepStrictEqual(b.night.charmActions, a.night.charmActions, '魅惑行动一致');
  assert.deepStrictEqual(b.night.poisonTargets, a.night.poisonTargets, '毒杀一致');
  assert.strictEqual(b.night.wolfKill, a.night.wolfKill, '刀口一致');
  assert.strictEqual(b.night.saved, a.night.saved, '是否用解药一致');
  assert.deepStrictEqual(
    b.events.filter((e) => e.type === 'night_step').map((e) => e.data.step),
    a.events.filter((e) => e.type === 'night_step').map((e) => e.data.step),
    '步骤播报序列必须完全一致',
  );
  // 私密性：夜事件仍然只给当事人（并发绝不能把别人的行动漏给第三方）
  for (const e of b.events) {
    if (['night_guard', 'night_dream', 'seer_check', 'witch_info', 'witch_action', 'crow_curse'].includes(e.type)) {
      assert.deepStrictEqual(e.visibleTo, [e.actor], `${e.type} 必须只对 ${e.actor} 可见`);
    }
  }
});
