/**
 * visibility.js — 事件可见性的**单一权威表** + 运行时断言（P2-3）
 *
 * 为什么需要它：`emit()` 原来的默认值是 `visibleTo = 'all'`，也就是 **fail-open**——
 * 任何一个私密事件只要作者忘了写 `visibleTo`，就会被当成公开发出去，
 * 而"事件流是唯一的隔离出口"，泄漏就此发生且没人会立刻发现。
 *
 * 现在改成 fail-closed：每种事件类型必须在下表里显式登记，`emit()` 会按登记的模式校验，
 * **未登记的类型直接抛错**。新增事件类型时忘记登记 → 第一次跑就炸，而不是悄悄泄漏。
 *
 * 四种模式：
 *   · public  —— 公开事件。可省略 `visibleTo`（省略即公开），给了就必须是 'all'。
 *   · private —— 私密事件。**必须**显式给出座位数组；省略即抛错。
 *   · god     —— 仅上帝视图可见。
 *   · mixed   —— 同一类型既可能公开也可能定向（如 `role_reveal` 受翻牌规则影响）。
 *                **必须显式声明**，不允许走默认值——这是"混合类型"唯一的防呆方式。
 *
 * 分类依据不是猜的：用多配置 mock 探针（默认/暗牌/无警长/禁自爆…）跑出来的实际形态，
 * 见 docs/upgrade-plan.md §8 P2-3。少数规则相关或罕见类型按代码语义登记并注明。
 */
'use strict';

/** 座位数组的合法化检查用得上 */
const isSeatArray = (v) => Array.isArray(v) && v.every((s) => Number.isInteger(s));

const EVENT_VISIBILITY = {
  // ---------- 公开：所有人可见 ----------
  phase: 'public',
  night_step: 'public',
  speech: 'public',
  withdraw: 'public',
  deaths: 'public',
  vote_reveal: 'public',
  // 私密投票的"进度可见"：只播报已收集的**条数**，绝不带目标/座位 ——
  // 投票方向是游戏信息，泄露它就是改游戏。所以它同时进 context 的 NOISE_TYPES 与
  // effort 的 CHATTER_TYPES：AI 上下文与思考预算都不受它影响（纯 UI 反馈）。
  vote_progress: 'public',
  // 宣称账本（B2）：记录"某人公开说过什么"。**说了什么是事实，说的内容不是** ——
  // 事件里永远带 verifiedBy:null，且绝不携带说话者的真实身份；快照把它单独成区，与硬事实隔开。
  claim: 'public',
  sheriff_run: 'public',
  sheriff_none: 'public',
  sheriff_elected: 'public',
  badge_pass: 'public',
  direction: 'public',
  explode: 'public',
  shoot: 'public',
  duel: 'public',            // 骑士决斗 = 公开翻牌，技能的一部分
  idiot_save: 'public',      // 白痴翻牌免死，全场可见
  game_over: 'public',
  game_paused: 'public',

  // ---------- 私密：必须显式给出座位数组 ----------
  deal: 'private',           // 只给本人看身份牌
  teammates: 'private',      // 只给该狼看队友
  ai_thinking: 'private',    // "正在思考"提示只给本人
  vote_cast: 'private',      // 投票保密：只给投票者自己
  seer_check: 'private',     // 查验结果只给预言家
  witch_info: 'private',
  witch_action: 'private',
  night_guard: 'private',
  night_dream: 'private',
  wolfbeauty_charm: 'private',
  crow_curse: 'private',
  admirer_crush: 'private',
  wolf_propose: 'private',   // 狼队讨论只给狼队（含人类狼）
  wolf_kill: 'private',
  wolf_kill_vote: 'private',

  // ---------- 仅上帝 ----------
  llm_error: 'god',
  ai_reasoning: 'god',

  // ---------- 混合：必须显式声明 ----------
  // 暗牌局私有、明牌局公开
  role_reveal: 'mixed',
  // 既用于全场公告，也用于狼队私密提示（如"狼队讨论 1/3 轮"）
  system: 'mixed',
};

const describe = (v) => (v === undefined ? '未提供' : v === 'all' ? "'all'" : v === 'god' ? "'god'" : Array.isArray(v) ? `[${v.join(',')}]` : String(v));

/**
 * 校验一次 emit 的可见性。抛错即 fail-closed。
 * @param {string} type 事件类型
 * @param {'all'|'god'|number[]|undefined} visibleTo
 * @param {number} [playerCount] 给出时会校验座位号范围（防"座位 0 / 越界"这类笔误）
 */
function assertEventVisibility(type, visibleTo, playerCount) {
  const mode = EVENT_VISIBILITY[type];
  if (!mode) {
    throw new Error(
      `未声明可见性的事件类型 '${type}'：请在 src/engine/visibility.js 的 EVENT_VISIBILITY 里显式登记`
      + `（public / private / god / mixed）。这是 fail-closed 设计——宁可现在报错，也不要默认公开而泄漏。`,
    );
  }
  const isPublic = visibleTo === 'all' || visibleTo === undefined;
  const isGod = visibleTo === 'god';
  const isSeats = isSeatArray(visibleTo);
  if (visibleTo !== undefined && !isPublic && !isGod && !Array.isArray(visibleTo)) {
    throw new Error(`事件 '${type}' 的 visibleTo 非法：${describe(visibleTo)}（只能是 'all' / 'god' / 座位数组）`);
  }
  if (Array.isArray(visibleTo) && !isSeats) {
    throw new Error(`事件 '${type}' 的 visibleTo 必须是整数座位数组，当前：${describe(visibleTo)}`);
  }
  switch (mode) {
    case 'public':
      if (!isPublic) throw new Error(`公开事件 '${type}' 不允许定向可见（当前 ${describe(visibleTo)}）`);
      break;
    case 'private':
      if (!isSeats) {
        throw new Error(
          `私密事件 '${type}' 必须显式给出座位数组，当前 ${describe(visibleTo)}。`
          + '这正是"忘记声明就被当成公开发出去"的泄漏入口，因此这里直接拒绝。',
        );
      }
      break;
    case 'god':
      if (!isGod) throw new Error(`上帝事件 '${type}' 只能 visibleTo: 'god'，当前 ${describe(visibleTo)}`);
      break;
    case 'mixed':
      if (visibleTo === undefined) {
        throw new Error(`混合可见性事件 '${type}' 必须显式声明 visibleTo（'all' 或座位数组），不允许走默认值`);
      }
      break;
    default:
      throw new Error(`事件 '${type}' 登记了未知模式 '${mode}'`);
  }
  if (isSeats) {
    if (!visibleTo.length) throw new Error(`事件 '${type}' 的 visibleTo 不能是空数组（空数组等于谁都看不到，几乎总是笔误）`);
    for (const s of visibleTo) {
      if (s < 1 || (playerCount != null && s > playerCount)) {
        throw new Error(`事件 '${type}' 的 visibleTo 含非法座位 ${s}（合法范围 1..${playerCount == null ? '?' : playerCount}）`);
      }
    }
  }
  return true;
}

/**
 * 语义审计（把原来只在测试/模拟里跑的 auditIsolation 提升为可随时调用的运行时断言）。
 * 结构校验（上面那个）看的是"有没有声明"，这里看的是"声明得对不对"：
 * 比如 seer_check 只能给预言家本人，vote_cast 只能给投票者本人。
 * 返回问题列表（空 = 通过）；调用方决定是抛错还是记录。
 */
function auditEventSemantics(game) {
  const { ROLES } = require('./roles');
  const problems = [];
  const role = (s) => (game.player(s) ? game.player(s).role : null);
  const isWolfSeat = (s) => !!ROLES[role(s)] && ROLES[role(s)].team === 'wolf';
  const seatsOf = (e) => (Array.isArray(e.visibleTo) ? e.visibleTo : null);
  const PRIVATE_ROLE_RULES = {
    seer_check: 'seer',
    witch_info: 'witch',
    witch_action: 'witch',
    night_guard: 'guard',
    night_dream: 'dreamer',
    wolfbeauty_charm: 'wolfbeauty',
    crow_curse: 'crow',
    admirer_crush: 'admirer',
  };
  for (const e of game.events) {
    const seats = seatsOf(e);
    switch (e.type) {
      case 'deal':
        if (!seats || seats.length !== 1 || seats[0] !== e.actor) problems.push(`deal 可见性异常 seq=${e.seq}`);
        break;
      case 'teammates':
      case 'wolf_propose':
      case 'wolf_kill':
      case 'wolf_kill_vote':
        if (!seats || !seats.length || seats.some((s) => !isWolfSeat(s))) {
          problems.push(`狼队私密事件泄漏 seq=${e.seq} type=${e.type} vis=${describe(e.visibleTo)}`);
        }
        break;
      case 'vote_cast':
        if (!seats || seats.length !== 1 || seats[0] !== e.actor) problems.push(`投票保密性被破坏 seq=${e.seq}`);
        break;
      case 'ai_thinking':
      case 'ai_reasoning':
        if (e.type === 'ai_thinking' && (!seats || seats.length !== 1 || seats[0] !== e.actor)) {
          problems.push(`思考提示可见性异常 seq=${e.seq}`);
        }
        break;
      default:
        if (PRIVATE_ROLE_RULES[e.type]) {
          const want = PRIVATE_ROLE_RULES[e.type];
          if (!seats || seats.length !== 1 || role(seats[0]) !== want) {
            problems.push(`${e.type} 结果泄漏 seq=${e.seq} vis=${describe(e.visibleTo)}（应只给 ${want}）`);
          }
        }
        break;
    }
  }
  return problems;
}

module.exports = { EVENT_VISIBILITY, assertEventVisibility, auditEventSemantics, isSeatArray };
