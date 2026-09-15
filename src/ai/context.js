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

const NOISE_TYPES = new Set(['await_input', 'ai_thinking', 'llm_error', 'ai_reasoning']);
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

/** 中文为主文本的 token 估算（GLM 约 1.5~1.8 字/token，取保守值） */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 1.5);
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
    const line = renderEvent(game, e);
    if (line && line.trim()) lines.push(`  ${line}`);
  }
  return lines;
}

/** 局面快照：时钟 + 座位 + 确知/不知 + 公开硬事实 + 新事件清单（易变区，放最末保证缓存前缀稳定） */
function renderSnapshot(game, player, ledger, request, lastSeq = 0, suspicion = null) {
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
  const factLines = [];
  const days = [...ledger.byDay.keys()].sort((a, b) => a - b);
  for (const d of days) {
    const f = dayFacts(game, ledger.byDay.get(d));
    if (f.length) factLines.push(`第${d}天：\n${f.join('\n')}`);
  }
  const fresh = ledger.events.filter((e) => e.seq > lastSeq && !NOISE_TYPES.has(e.type));
  const freshText = fresh.length
    ? '自你上次行动后的新事件（此前实录中未出现的部分）：\n' + fresh.map((e) => {
      const line = renderEvent(game, e);
      return line && line.trim() ? '  ◆ ' + line : '';
    }).filter(Boolean).join('\n')
    : '';
  return [
    head,
    `座位与状态：${seatLine}`,
    '你确知（私密）：\n' + youKnow,
    '你不知道（不要臆测）：\n' + notKnow.map((s) => `  · ${s}`).join('\n'),
    factLines.length ? '公开硬事实时间线：\n' + factLines.join('\n') : '',
    freshText,
  ].filter(Boolean).join('\n');
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
      const line = renderEvent(game, e);
      if (line && line.trim()) out.push(line);
    }
  }
  return out.join('\n');
}

/** L1 纪要拼接（day→digest 有序） */
function renderDigests(digests) {
  const days = [...digests.keys()].sort((a, b) => a - b);
  if (!days.length) return '';
  const parts = ['──── 早期记忆纪要（更早天数的事实与判断要点）────'];
  for (const d of days) parts.push(`◆ 第${d}天纪要：\n${digests.get(d)}`);
  return parts.join('\n');
}

/** 反思失败时的确定性骨架（当天的公开硬事实 + 私密行动） */
function skeletonDigest(game, ledger, day) {
  const evs = ledger.byDay.get(day) || [];
  const facts = dayFacts(game, evs);
  const mine = [];
  for (const e of evs) {
    if (['wolf_kill', 'seer_check', 'witch_action', 'night_guard', 'vote_cast',
      'night_dream', 'wolfbeauty_charm', 'crow_curse', 'admirer_crush'].includes(e.type)) {
      const line = renderEvent(game, e);
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
  const digestsText = renderDigests(state.digests || new Map());
  const transcriptText = renderTranscript(game, ledger, days);
  const snapshotText = renderSnapshot(game, player, ledger, request, state.lastSeq || 0, state.suspicion || null);
  const { taskInstruction } = require('./prompts');
  const taskText = `## 当前任务（你是 ${player.seat}号）\n${taskInstruction(game, player, request)}`;
  return { ledger, digestsText, transcriptText, snapshotText, taskText };
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

/** 预算裁剪：快照与任务永远完整，只裁记忆区（昨日降级 → 实录保尾 → 丢最旧纪要） */
function trimToBudget(game, player, request, state, budgetTokens) {
  const P = assembleParts(game, player, request, state);
  const fixedTokens = estimateTokens(P.snapshotText) + estimateTokens(P.taskText);
  const avail = Math.max(500, budgetTokens - fixedTokens);
  const digests = new Map(state.digests || []);
  const today = game.day || 0;
  let days = state.transcriptDays != null ? state.transcriptDays.slice() : [today - 1, today].filter((d) => d >= 1);
  let digestsText = P.digestsText;
  let transcriptText = P.transcriptText;
  let trimmed = false;
  const over = () => estimateTokens(digestsText) + estimateTokens(transcriptText) > avail;
  // 1) 昨日实录降级：只留今日逐字（昨日事实仍在快照时间线里）
  if (over() && days.includes(today - 1)) {
    days = [today];
    transcriptText = renderTranscript(game, P.ledger, days);
    trimmed = true;
  }
  // 2) 实录保尾截断（近期发言比开局的更重要）
  if (over() && transcriptText) {
    const keepChars = Math.max(200, Math.floor(avail * 1.5) - Math.floor(estimateTokens(digestsText) * 1.5));
    transcriptText = '（早期实录已因预算截断）\n' + transcriptText.slice(-keepChars);
    trimmed = true;
  }
  // 3) 丢弃最旧纪要
  let keep = [...digests.entries()].sort((a, b) => a[0] - b[0]);
  while (over() && keep.length > 0) {
    keep = keep.slice(1);
    digestsText = renderDigests(new Map(keep));
    trimmed = true;
  }
  // 4) 极端情况：实录再压一档
  if (over() && transcriptText) {
    transcriptText = transcriptText.slice(-Math.max(200, Math.floor(avail * 1.2)));
    trimmed = true;
  }
  const text = [digestsText, transcriptText, P.snapshotText, P.taskText].filter(Boolean).join('\n\n');
  return {
    text,
    sections: { digests: digestsText, transcript: transcriptText, snapshot: P.snapshotText },
    tokens: estimateTokens(text),
    trimmed,
    ledger: P.ledger,
  };
}

module.exports = {
  FAST_TASKS, taskEffort, taskMaxTokens, estimateTokens, aggregate,
  renderSnapshot, renderTranscript, renderDigests, skeletonDigest, dayFacts,
  privateLedger, assemble, trimToBudget,
};
