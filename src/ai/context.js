/**
 * context.js — AI 上下文组装器（局面快照 + 分层记忆）
 *
 * 三层记忆（每次决策 = 一次性组装，不再 append-only 重放全部历史）：
 *   L1 纪要层：过去每天的反思摘要（agent 持有，跨天惰性生成；LLM 生成，失败降级为事实骨架）
 *   L2 实录层：昨天 + 今天的全部可见事件逐字实录（窗口滚动，当日只增）
 *   快照+任务：局面快照（代码实时计算，零幻觉）+ 当前任务指令
 *
 * 组装顺序 = 缓存前缀稳定性优先级：稳定（system/L1/昨日）在前，易变（快照）最后。
 * 隔离原则：一切"知道什么"只从 game.visibleEvents(seat) 聚合，隔离性由构造保证。
 * 时间原则：时钟/天数/阶段全部由代码给出并标注 ◆ 新事件，模型不再自行拼时间线。
 */
'use strict';
const { renderEvent, PHASE_LABEL } = require('../engine/render');
const { spotlightEvent } = require('./spotlight');
const { estimateTokens } = require('./tokens');
const { selectMemory, MEMORY_HEADER } = require('./memory');
const { renderClaim } = require('../engine/claims');

/** 公开宣称分区最多保留的"查验/用药"条数（自认身份每座位只留最近一次，不占这个额度） */
const CLAIM_KEEP = 12;

const NOISE_TYPES = new Set(['await_input', 'ai_thinking', 'llm_error', 'ai_reasoning', 'vote_progress']);
// 快速任务：低思考强度即可胜任的结构化决策（配合局面快照，无需自行拼时间线）
// lastwords：遗言是一次性短内容，high 档推理曾出现 7k tokens/286s 的极差体验，策略菜单已由提示词托底
const FAST_TASKS = new Set([
  'wolf_propose', 'wolf_chat', 'wolf_kill', 'night_guard', 'seer_check', 'witch',
  'sheriff_run', 'sheriff_vote', 'vote', 'pk_vote', 'shoot', 'badge_pass',
  'direction', 'explode_check', 'duel_check', 'lastwords',
  'night_dream', 'crow_curse', 'wolfbeauty_charm', 'admirer_crush',
]);

/** 任务分层：发言类用主思考强度，快速任务用 fastEffort */
function taskEffort(task, cfg) {
  return FAST_TASKS.has(task) ? (cfg.fastEffort || 'low') : (cfg.reasoningEffort || 'high');
}
/** 任务分层输出上限：快速任务压低上限降低最坏延迟；发言档封顶 12000 压思考失控的极值尾巴（实测最长 218s） */
function taskMaxTokens(task, cfg) {
  if (FAST_TASKS.has(task)) return cfg.fastMaxTokens || 8000;
  return Math.min(cfg.maxTokens || 16000, 12000);
}

/** 聚合某玩家视角的全部可见事件 → 结构化账本（隔离性由 visibleEvents 保证） */
function aggregate(game, player) {
  // day 0 = 发牌阶段：身份在 system、队友在私密账本中另行给出，事件本身不进任何上下文分区
  const events = game.visibleEvents(player.seat, 0).filter((e) => !NOISE_TYPES.has(e.type) && e.day !== 0);
  const byDay = new Map(); // day -> [events]
  for (const e of events) {
    const d = e.day;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  return { events, byDay };
}

function roleName(rid) {
  const { ROLES } = require('../engine/roles');
  return (ROLES[rid] && ROLES[rid].name) || rid;
}

/** 私密账本：从自己的可见事件里提取"你确知"的硬信息 */
function privateLedger(game, player, events) {
  const lines = [];
  const role = player.role;
  if (game.wolves().some((w) => w.seat === player.seat)) {
    const mates = game.matesOf(player).filter((w) => w.alive).map((w) => `${w.seat}号${w.name}`);
    const dead = game.matesOf(player).filter((w) => !w.alive).map((w) => `${w.seat}号${w.name}`);
    const label = role === 'hiddenwolf' ? '你已知的狼队队友（他们不知道你）' : '狼队队友';
    lines.push(`${label}：${mates.join('、') || '（无存活）'}${dead.length ? `（已出局：${dead.join('、')}）` : ''}`);
  }
  if (game.crush && game.crush[player.seat]) {
    const t = game.player(game.crush[player.seat]);
    if (t) lines.push(`你的暗恋对象：${t.seat}号${t.name}${t.alive ? '' : '（已出局，绑定依然有效）'}——胜负阵营与他绑定，他的阵营需你自行推断`);
  }
  const kills = [];
  const checks = [];
  const potions = [];
  const guards = [];
  const dreams = [];
  const charms = [];
  const curses = [];
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'wolf_kill') kills.push(`第${e.day}夜→${d.target ? d.target + '号' : '空刀'}`);
    else if (e.type === 'seer_check') checks.push(`第${e.day}夜验 ${d.target}号：${d.isWolf ? '狼人' : '好人'}`);
    else if (e.type === 'witch_action') potions.push(`第${e.day}夜 ${d.antidote ? `解药救${d.killTarget}号` : '未救'}${d.poison ? `、毒${d.poison}号` : ''}`);
    else if (e.type === 'night_guard') guards.push(`第${e.day}夜守 ${d.target ? d.target + '号' : '空'}`);
    else if (e.type === 'night_dream') dreams.push(`第${e.day}夜摄梦 ${d.target}号`);
    else if (e.type === 'wolfbeauty_charm') charms.push(`第${e.day}夜魅惑 ${d.target}号`);
    else if (e.type === 'crow_curse') curses.push(`第${e.day}夜诅咒 ${d.target}号`);
  }
  if (kills.length && role !== 'whitewolfking') lines.push(`狼队历史刀口：${kills.join('，')}`);
  if (checks.length) lines.push(`查验记录：${checks.join('，')}`);
  if (potions.length) lines.push(`用药记录：${potions.join('，')}`);
  if (guards.length) lines.push(`守护记录：${guards.join('，')}`);
  if (dreams.length) lines.push(`摄梦记录：${dreams.join('，')}（连续两晚同一人则其死亡）`);
  if (charms.length) lines.push(`当前魅惑：${charms[charms.length - 1]}（每次魅惑覆盖之前）`);
  if (curses.length) lines.push(`诅咒记录：${curses.join('，')}（最新诅咒次日生效）`);
  return lines;
}

/** 公开硬事实时间线（某一天的行，确定性渲染） */
function dayFacts(game, dayEvents) {
  const lines = [];
  for (const e of dayEvents) {
    if (NOISE_TYPES.has(e.type)) continue;
    if (e.type === 'speech' || e.type === 'phase') continue; // 发言进实录层，阶段标题由分区头承担
    if (e.type === 'claim') continue; // 宣称不是硬事实，单独成区（见 claimSection）
    const line = spotlightEvent(game, e, renderEvent(game, e));
    if (line && line.trim()) lines.push(`  ${line}`);
  }
  return lines;
}

/**
 * 每天的"决定性结论"压成一行 —— 硬事实**脊柱**。
 *
 * 为什么需要它：逐条明细会随天数无限增长，长局里必然要被裁；而"第 3 天到底是谁被票走的"
 * 这种结论是**不能因为对局长就消失**的。所以事实分两层（和卡框的粗/细档同理）：
 *   · 脊柱（本函数）：一天一行，代码生成，永不裁剪；
 *   · 明细（`dayFacts`）：逐条事件行，只保最近几天。
 * 只用引擎自己发过的事件，不做任何推断。
 */
function daySpine(game, dayEvents) {
  const votes = [];
  const bits = [];
  for (const e of dayEvents) {
    const d = e.data || {};
    if (e.type === 'deaths' && Array.isArray(d.deaths) && d.deaths.length) {
      bits.push(`夜里 ${d.deaths.map((x) => `${x.seat}号`).join('、')} 出局`);
    } else if (e.type === 'vote_reveal' && d.tally) {
      // 一天可能有多轮亮票（平票 PK）；只留最后 3 轮 —— 结论以最终那轮为准，
      // 否则"每天一行"会被同一天的多次 PK 撑爆（实测 20 轮亮票 ≈ 2600 token）。
      const top = Object.entries(d.tally)
        .filter(([k, n]) => k !== '0' && n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2);
      if (top.length) {
        votes.push(`亮票 ${top.map(([s, n]) => `${s}号${n}票`).join('、')}`);
        if (votes.length > 3) votes.shift();
      }
    } else if (e.type === 'sheriff_elected' && d.seat) {
      bits.push(`警长 ${d.seat}号`);
    } else if (e.type === 'role_reveal' && d.seat) {
      bits.push(`翻牌 ${d.seat}号=${roleName(d.role)}`);
    } else if (e.type === 'idiot_save' && d.seat) {
      bits.push(`白痴翻牌 ${d.seat}号`);
    } else if (e.type === 'shoot' && d.target) {
      bits.push(`枪杀 ${d.target}号`);
    } else if (e.type === 'explode') {
      bits.push(d.target ? `自爆带走 ${d.target}号` : '自爆');
    } else if (e.type === 'duel') {
      bits.push('骑士决斗');
    }
  }
  const parts = [...bits, ...votes];
  // 硬上限：脊柱是"永不裁剪"的，所以它自己必须有界（否则预算约束形同虚设）
  let out = '';
  for (const p of parts) {
    if (out && (out + '；' + p).length > 120) return `${out}；…（共 ${parts.length} 条）`;
    out = out ? `${out}；${p}` : p;
  }
  return out;
}

/** 局面快照：时钟 + 座位 + 确知/不知 + 公开硬事实 + 新事件清单（易变区，放最末保证缓存前缀稳定） */
function renderSnapshot(game, player, ledger, request, lastSeq = 0, suspicion = null, opts = {}) {
  const phaseName = PHASE_LABEL[game.phase] || game.phase;
  const head = `【局面快照】当前时刻：第 ${game.day} 天 · ${phaseName}${request && request.task === 'speech' ? '（正在逐个发言）' : ''} —— 一切以本快照为准，这是"现在"的唯一事实。`;
  const seatLine = game.players
    .map((p) => {
      const bits = [`${p.seat}号${p.name}${p.seat === player.seat ? '（你）' : ''}`];
      if (p.isSheriff) bits.push('👑警长');
      if (p.role && p.revealed) bits.push(`已翻牌:${roleName(p.role)}`);
      if (!p.alive) bits.push('出局');
      else if (p.seat === player.seat) bits.push('存活');
      return bits.join(' ');
    })
    .join('；');
  const secret = privateLedger(game, player, ledger.events);
  const susEntries = suspicion ? Object.entries(suspicion).filter(([, v]) => Number.isFinite(v)) : [];
  if (susEntries.length) {
    secret.push(`你对各座位的怀疑度（+100 确定是狼 / 0 未知 / -100 确定好人，随每日反思更新）：${susEntries.map(([s, v]) => `${s}号${v > 0 ? '+' : ''}${v}`).join('、')}`);
  }
  const youKnow = secret.length ? secret.map((s) => `  · ${s}`).join('\n') : '  · （暂无私密信息）';
  const notKnow = [];
  notKnow.push('未翻牌玩家的真实身份——夜里你只获得系统明确告诉你的信息，其余一概不知');
  if (player.role !== 'seer') notKnow.push('任何人的查验结果（除非对方主动声称）');
  notKnow.push('已经过去的时间里"本应发生但日志中没有"的事——日志里没有就是没发生');
  const days = [...ledger.byDay.keys()].sort((a, b) => a - b);
  // ① 脊柱：每天一行结论，永不裁剪（事实不能因为对局长就消失）
  const spine = [];
  for (const d of days) {
    const s = daySpine(game, ledger.byDay.get(d) || []);
    if (s) spine.push(`  第${d}天·结论：${s}`);
  }
  const spineBlock = spine.length ? `公开硬事实时间线：\n  每日脊柱（代码生成，永不裁剪）：\n${spine.join('\n')}` : '';
  // 公开宣称（B2）：与硬事实**物理隔开** —— "某人说过什么"是事实，"他说的内容"不是。
  // 有界策略：每个座位只留**最近一次**自认身份 + 最近 N 条查验/用药宣称，其余折叠并写明条数；
  // 不设界的话，从第 3 天起账本就会变成上下文里最大的噪声源。
  const claimEvents = ledger.events.filter((e) => e.type === 'claim');
  const selfLatest = new Map();
  const verified = [];
  for (const e of claimEvents) {
    const d = e.data || {};
    if (!d.subject) selfLatest.set(e.actor, e); // subject=0：自认身份
    else verified.push(e);
  }
  const lineOf = (e) => `  · 第${(e.data && e.data.day) || e.day}天 ${e.actor}号 ${renderClaim(e.data || {})}`;
  const selfLines = [...selfLatest.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(lineOf);
  const recentClaims = verified.slice(-CLAIM_KEEP);
  const claimLines = [...selfLines, ...recentClaims.map(lineOf)];
  const claimNote = verified.length > recentClaims.length
    ? `  （更早的 ${verified.length - recentClaims.length} 条宣称已省略）`
    : '';
  const claimSection = claimLines.length
    ? '公开宣称（未经证实：以下只是"某人这样说过"，不代表为真，真假要你自己判断）：\n'
      + [...claimLines, claimNote].filter(Boolean).join('\n')
    : '';
  // ② 结构区（时钟/座位/确知/脊柱）是快照的**下限**，任何预算下都不裁 —— 先量出它的体积
  const structural = [
    head,
    `座位与状态：${seatLine}`,
    '你确知（私密）：\n' + youKnow,
    '你不知道（不要臆测）：\n' + notKnow.map((s) => `  · ${s}`).join('\n'),
    spineBlock,
    // 宣称区进结构区：它是"谁说过什么"的唯一索引，被裁掉就等于把 AI 的判断依据抽走
    claimSection,
  ].filter(Boolean);
  const budget = opts.tokenBudget;
  const fixedTokens = structural.reduce((a, s) => a + estimateTokens(s), 0);
  const room = budget != null ? Math.max(0, budget - fixedTokens) : Infinity;
  // ③ 明细：从最新的一天往前放，放不下就整段丢
  //    （最新一天在放得下时总是保留 —— 那是正在讨论的现场）
  const detailOf = (d) => {
    const f = dayFacts(game, ledger.byDay.get(d) || []);
    return f.length ? `  第${d}天：\n${f.join('\n')}` : '';
  };
  const detailBudget = room === Infinity ? Infinity : Math.max(150, Math.floor(room * 0.5));
  const keptDays = [];
  let detailTokens = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const block = detailOf(days[i]);
    if (!block) continue;
    const cost = estimateTokens(block);
    if (keptDays.length && detailTokens + cost > detailBudget) break;
    keptDays.unshift(days[i]);
    detailTokens += cost;
  }
  const detailBlocks = keptDays.map(detailOf).filter(Boolean);
  const folded = days.filter((d) => !keptDays.includes(d) && (ledger.byDay.get(d) || []).length);
  const foldedNote = folded.length
    ? `  （第${folded[0]}~${folded[folded.length - 1]}天的逐条明细已折叠；结论仍在上面的每日脊柱里）`
    : '';
  // ④ 事实区 = 脊柱 + 预算内的明细 + 折叠说明（明细必须真的拼进来：只算不拼等于白算）
  const factSection = spineBlock
    ? [spineBlock, ...detailBlocks, foldedNote].filter(Boolean).join('\n')
    : (detailBlocks.length ? `公开硬事实时间线：\n${[...detailBlocks, foldedNote].filter(Boolean).join('\n')}` : '');
  const fresh = ledger.events.filter((e) => e.seq > lastSeq && !NOISE_TYPES.has(e.type));
  const freshLines = fresh.map((e) => {
    const line = spotlightEvent(game, e, renderEvent(game, e));
    return line && line.trim() ? line : '';
  }).filter(Boolean);
  let freshText = '';
  if (freshLines.length) {
    const head2 = '自你上次行动后的新事件（此前实录中未出现的部分）：';
    const full = `${head2}\n${freshLines.map((l) => '  ◆ ' + l).join('\n')}`;
    // 新事件这栏会随"一次爆发"而增长（例如同轮几十条发言）；超预算时保**最近**的几条，
    // 并如实写明丢了几条 —— 反正更早的那些就在上方实录里，不写清楚反而让人以为"只有这些"。
    const freshRoom = budget != null ? Math.max(0, budget - fixedTokens - detailTokens) : Infinity;
    if (estimateTokens(full) <= freshRoom) {
      freshText = full;
    } else {
      const kept = [];
      let used = 0;
      for (let i = freshLines.length - 1; i >= 0; i--) {
        const cost = estimateTokens(freshLines[i]) + 1;
        if (kept.length && used + cost > freshRoom) break;
        kept.unshift(freshLines[i]);
        used += cost;
      }
      freshText = kept.length
        ? `${head2}共 ${freshLines.length} 条，此处只列最近 ${kept.length} 条（更早的见上方实录）：\n${kept.map((l) => '  ◆ ' + l).join('\n')}`
        : `自你上次行动后的新事件：共 ${freshLines.length} 条，预算不足未展开（见上方实录）。`;
    }
  }
  return [head, `座位与状态：${seatLine}`, '你确知（私密）：\n' + youKnow, '你不知道（不要臆测）：\n' + notKnow.map((s) => `  · ${s}`).join('\n'), factSection, claimSection, freshText]
    .filter(Boolean)
    .join('\n');
}

/** L2 实录：days 数组内每天的可见事件逐字渲染（完全稳定，不掺任何易变标记） */
function renderTranscript(game, ledger, days) {
  const out = [];
  for (const d of days) {
    const evs = ledger.byDay.get(d) || [];
    if (!evs.length) continue;
    out.push(`──── 第${d}天实录 ────`);
    for (const e of evs) {
      if (NOISE_TYPES.has(e.type)) continue;
      const line = spotlightEvent(game, e, renderEvent(game, e));
      if (line && line.trim()) out.push(line);
    }
  }
  return out.join('\n');
}

/** L1 纪要拼接（day→digest 有序）——不做检索，供测试与非预算路径使用 */
function renderDigests(digests) {
  const days = [...digests.keys()].sort((a, b) => a - b);
  if (!days.length) return '';
  const parts = [MEMORY_HEADER];
  for (const d of days) parts.push(`◆ 第${d}天纪要：\n${digests.get(d)}`);
  return parts.join('\n');
}

/**
 * 当前决策的「检索线索」：我正在盘谁的票 + 手头的话题 + 今日的强事实座位。
 *
 * 两个刻意的收窄（P2-5 实现时踩过）：
 *   ① **不把今天的发言者全塞进线索**。今日发言已经逐字躺在 L2 实录里，
 *      让 L1 记忆再去重复提供它们毫无价值；线索一宽，"相关度"就退化成常数、检索等于没检索。
 *   ② 候选过多（超过半数座位）时也不当作线索——那说明这个决定本来就没有区分度。
 * 只由**已经进入该玩家上下文的信息**构成（候选/怀疑度/今日账本），不引入新信息、不破坏隔离。
 */
const QUERY_FOCUS_EVENTS = new Set(['vote_reveal', 'vote_cast', 'exile', 'deaths', 'shoot', 'role_reveal', 'idiot_save', 'badge_pass']);
const QUERY_MAX_SEATS = 5;

function memoryQuery(game, player, request, ledger, suspicion) {
  const seats = new Set();
  const today = game.day || 0;
  const cands = request.candidates || [];
  if (cands.length && cands.length <= Math.max(4, Math.floor(game.players.length / 2))) {
    for (const s of cands) seats.add(Number(s));
  }
  const sus = Object.entries(suspicion || {})
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);
  for (const [s] of sus) seats.add(Number(s));
  for (const e of ledger.byDay.get(today) || []) {
    if (!QUERY_FOCUS_EVENTS.has(e.type)) continue;
    if (e.actor) seats.add(Number(e.actor));
    const t = e.data && (e.data.target != null ? e.data.target : e.data.to);
    if (t) seats.add(Number(t));
  }
  seats.delete(player.seat); // 关于自己的记忆本来就在快照的私密区，不需要靠它来检索
  // 上限：线索必须比"全体座位"小得多，否则相关度没有区分力
  const focused = new Set([...seats].filter((s) => s > 0).slice(0, QUERY_MAX_SEATS));
  const terms = [];
  const taskLabel = { vote: '投票', pk_vote: '投票', sheriff_vote: '投票', speech: '发言', pk_speech: '发言', sheriff_speech: '发言', seer_check: '查验', witch: '用药', night_guard: '守护', wolf_kill: '刀口', wolf_chat: '刀口', night_dream: '摄梦' }[request.task];
  if (taskLabel) terms.push(taskLabel);
  return { seats: focused, terms, nowDay: today };
}

/** 反思失败时的确定性骨架（当天的公开硬事实 + 私密行动） */
function skeletonDigest(game, ledger, day) {
  const evs = ledger.byDay.get(day) || [];
  const facts = dayFacts(game, evs);
  const mine = [];
  for (const e of evs) {
    if (['wolf_kill', 'seer_check', 'witch_action', 'night_guard', 'vote_cast',
      'night_dream', 'wolfbeauty_charm', 'crow_curse', 'admirer_crush'].includes(e.type)) {
      const line = spotlightEvent(game, e, renderEvent(game, e));
      if (line) mine.push(`  ${line}`);
    }
  }
  return [
    `（第${day}天事实骨架）`,
    facts.length ? facts.join('\n') : '  （无公开事实）',
    mine.length ? '我的行动：\n' + mine.join('\n') : '',
  ].filter(Boolean).join('\n');
}

/** 组装各分区（digests / transcript / snapshot / task），供拼装与裁剪共用 */
function assembleParts(game, player, request, state) {
  const ledger = aggregate(game, player);
  const today = game.day || 0;
  const days = state.transcriptDays != null ? state.transcriptDays : [today - 1, today].filter((d) => d >= 1);
  // memoryBudget 由调用方给出（trimToBudget 里按剩余预算算）；不传则退回全量拼接（与旧行为逐字一致）
  const mem = selectMemory(state.digests || new Map(), {
    nowDay: today,
    query: state.memoryBudget != null ? memoryQuery(game, player, request, ledger, state.suspicion) : null,
    budgetTokens: state.memoryBudget != null ? state.memoryBudget : Infinity,
  });
  const digestsText = mem.text;
  const transcriptText = renderTranscript(game, ledger, days);
  const snapshotText = renderSnapshot(game, player, ledger, request, state.lastSeq || 0, state.suspicion || null);
  const { taskInstruction } = require('./prompts');
  const taskText = `## 当前任务（你是 ${player.seat}号）\n${taskInstruction(game, player, request)}`;
  return { ledger, digestsText, transcriptText, snapshotText, taskText, memory: mem };
}

/**
 * 组装完整上下文（system 之外的单条 user 消息内容）
 * @returns {{text, sections:{digests,transcript,snapshot}}}
 */
function assemble(game, player, request, state) {
  const P = assembleParts(game, player, request, state);
  return {
    text: [P.digestsText, P.transcriptText, P.snapshotText, P.taskText].filter(Boolean).join('\n\n'),
    sections: { digests: P.digestsText, transcript: P.transcriptText, snapshot: P.snapshotText },
    ledger: P.ledger,
  };
}

/**
 * 预算裁剪：快照与任务永远完整，只裁记忆区。
 *
 * 顺序：① 昨日实录降级 → ② 先压旧记忆（按 recency × importance × relevance 检索）
 *      → ③ 实录按天保尾 → ④ 极端兜底。
 *
 * B3 修正了两件事：
 *   · **快照有了独立上限**（预算的 25%）。以前它没有上界，长局里能把可用预算挤到 500，
 *     于是"当天的发言被裁光、十天前的死讯却一条不少"——该留的被裁、该省的留着。
 *   · **②③ 顺序对调**。实录是正在讨论的现场（当天发言链），旧纪要是可检索的历史，
 *     必须先省后者；旧顺序先切实录，恰好把最该留的切掉了。
 * 装得下时（短局常态）**不做任何检索与裁剪**，逐字与旧行为一致。
 */
function trimToBudget(game, player, request, state, budgetTokens) {
  const P = assembleParts(game, player, request, state); // 此处不检索：先量出"全量记忆"的体积
  // 快照的独立上限：以前预算只约束"记忆+实录"，而快照（含**全部天数**的逐条事实）没有上界，
  // 长局里它能把 avail 压到 500 → 当天的发言被裁光、十天前的死讯却一条不少。
  // 超限时重渲染：脊柱仍保留每一天，只折叠早期的逐条明细。
  const snapshotCap = Math.max(400, Math.floor(budgetTokens * 0.25));
  let snapshotText = P.snapshotText;
  if (estimateTokens(snapshotText) > snapshotCap) {
    snapshotText = renderSnapshot(game, player, P.ledger, request, state.lastSeq || 0, state.suspicion || null, {
      tokenBudget: snapshotCap,
    });
  }
  const fixedTokens = estimateTokens(snapshotText) + estimateTokens(P.taskText);
  const avail = Math.max(500, budgetTokens - fixedTokens);
  const today = game.day || 0;
  let days = state.transcriptDays != null ? state.transcriptDays.slice() : [today - 1, today].filter((d) => d >= 1);
  let digestsText = P.digestsText;
  let transcriptText = P.transcriptText;
  let memory = P.memory;
  let trimmed = false;
  const over = () => estimateTokens(digestsText) + estimateTokens(transcriptText) > avail;
  // 1) 昨日实录降级：只留今日逐字（昨日事实仍在快照时间线里）
  if (over() && days.includes(today - 1)) {
    days = [today];
    transcriptText = renderTranscript(game, P.ledger, days);
    trimmed = true;
  }
  // 2) 先压**旧记忆**（可检索、可省），再动实录 —— 旧顺序反了：
  //    实录是正在讨论的现场（当天的发言链），旧纪要是可检索的历史，必须先省后者。
  if (over() && state.digests && state.digests.size) {
    const memoryBudget = Math.max(200, Math.floor(avail * 0.4));
    memory = selectMemory(state.digests, {
      nowDay: today,
      query: memoryQuery(game, player, request, P.ledger, state.suspicion),
      budgetTokens: memoryBudget,
    });
    digestsText = memory.text;
    trimmed = true;
  }
  // 3) 实录按天保尾：先丢最旧的那一天（不从句中切），保证当天的发言链完整
  if (over() && transcriptText && days.length > 1) {
    const blocks = days.map((d) => ({ d, text: renderTranscript(game, P.ledger, [d]) })).filter((b) => b.text);
    const kept = [];
    let used = estimateTokens(digestsText);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const cost = estimateTokens(blocks[i].text);
      if (kept.length && used + cost > avail) break;
      kept.unshift(blocks[i]);
      used += cost;
    }
    const droppedDays = blocks.length - kept.length;
    transcriptText = (droppedDays ? `（更早的 ${droppedDays} 天实录已因预算省略）\n` : '') + kept.map((b) => b.text).join('\n');
    days = kept.map((b) => b.d);
    trimmed = true;
  }
  // 4) 极端情况：当天实录本身就超预算 —— 只能从句首截，但**明确标注截断**（不静默）
  if (over() && transcriptText) {
    transcriptText = '（当天的早期发言已因预算截断）\n' + transcriptText.slice(-Math.max(200, Math.floor(avail * 1.2)));
    trimmed = true;
  }
  const text = [digestsText, transcriptText, snapshotText, P.taskText].filter(Boolean).join('\n\n');
  return {
    text,
    sections: { digests: digestsText, transcript: transcriptText, snapshot: snapshotText },
    // 分区体积（应用自报，供上帝面板/评测查看）：预算只约束"记忆+实录"，
    // 快照与任务永不裁剪 —— 没有这几个数，"为什么上下文 3000 tok 而预算是 900"就只能靠猜。
    sectionTokens: {
      memory: estimateTokens(digestsText),
      transcript: estimateTokens(transcriptText),
      snapshot: estimateTokens(snapshotText),
      task: estimateTokens(P.taskText),
      total: estimateTokens(text),
    },
    tokens: estimateTokens(text),
    trimmed,
    // 记忆检索的可观测结果（上帝面板/评测可直接看到"这一轮检索掉了几条"）
    memory: { kept: memory.kept, total: memory.total, omitted: memory.omitted, retrieved: memory.retrieved },
    ledger: P.ledger,
  };
}

module.exports = {
  FAST_TASKS, NOISE_TYPES, taskEffort, taskMaxTokens, estimateTokens, aggregate,
  renderSnapshot, renderTranscript, renderDigests, skeletonDigest, dayFacts, daySpine,
  privateLedger, memoryQuery, assemble, trimToBudget,
};
