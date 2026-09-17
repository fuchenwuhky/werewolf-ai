/**
 * consistency.js — 一致性审计（B5）
 *
 * 宣称账本（B2）刻意只记"某人说过什么"、绝不替它背书 —— 这是对的：一旦程序替宣称背书，
 * 没被证实的东西就混进了事实层，AI 后面的推理全建在幻觉上。但**局后复盘**是另一回事：
 * 此时真值已经揭晓，再让"未经证实"含糊过去，教练就会漏掉最该复核的那类发言
 * （真预言家报错查验、好人假跳神职）。所以审计放在局后：只读、只给结论。
 * "与真值相矛盾"不等于"有罪"——狼撒谎本来就是策略，审计的作用是复盘，不是禁止欺骗。
 *
 * 三条边界写死在这里（越界的诱惑很大，逐条说明为什么）：
 *   ① **狼人的任何宣称都不算矛盾**：狼必须能撒谎；但他的宣称仍然进 rows，
 *      因为复盘要看的是"谁说过什么"，不是"只留好人的话"。
 *   ② **好人藏身份不算矛盾**：神职自称村民是合法策略；只有"好人假跳神职"才算，
 *      因为那会把"真神职是谁"告诉狼队——这是必须人工复核的行为。
 *   ③ **只有当时有渠道知道的，才谈得上"说错了"**：不是预言家的人报查验，
 *      当时根本无从知道，那是诈牌/说谎（推理层的事），不是记错；审计只判可硬核对的部分。
 *
 * 纯函数、确定性、无 IO、不修改 game：复盘工具最怕"每次跑出来不一样"。
 */
'use strict';
const { ROLES } = require('../engine/roles');
const { renderClaim } = require('../engine/claims');

/** 神职 kind：好人假跳只有这几个才算矛盾（自称村民/other 都不是"假跳神职"） */
const GOD_KINDS = new Set(['seer', 'witch', 'guard', 'hunter']);
const KIND_NAME = { seer: '预言家', witch: '女巫', guard: '守卫', hunter: '猎人', villager: '村民', other: '身份' };

/** 取玩家的座位对象。座位越界或对局还没发牌时不抛错——审计退化成"未知"，而不是把整份复盘炸掉 */
function playerAt(game, seat) {
  if (!game) return null;
  if (typeof game.player === 'function') return game.player(seat) || null;
  return (game.players || [])[seat - 1] || null;
}

/** 座位真值（角色/阵营/类别）。角色为空（未发牌、空座位）时返回 null，由调用方写成"身份未知" */
function roleTruthOf(game, seat) {
  const p = playerAt(game, seat);
  const role = p && p.role;
  if (!role || !ROLES[role]) return null;
  return { role, name: ROLES[role].name, team: ROLES[role].team, category: ROLES[role].category };
}

/**
 * 身份真值文案：狼人/村民按"牌面口径"说，神职报具体身份。
 * 村民牌在 roles.js 里叫"平民"，但复盘里说"村民"更顺口，也与审计需求的示例一致。
 */
function describeRole(t) {
  if (!t) return '身份未知';
  if (t.category === 'wolf') return '狼人';
  if (t.category === 'villager') return '村民';
  return t.name;
}

/**
 * 引擎的**查验口径**：隐狼与暗恋者的查验结果永远是"好人"（flow.js 的 seerStep 官方裁定）。
 * 判"真预言家有没有说错"必须用这个口径——若用"实际阵营"判，
 * 真预言家如实报出隐狼的金水反而会被标成矛盾：那不是他说谎，是查验被设计的陷阱骗了。
 */
function seenAsWolf(role) {
  return role !== 'hiddenwolf' && role !== 'admirer' && ROLES[role].category === 'wolf';
}

/** 被谈论座位的真值文案：隐狼这类"实际是狼但查验为好人"的陷阱要写清楚，否则复盘看不到理由 */
function targetTruthText(seat, t) {
  if (!t) return `${seat}号身份未知`;
  const trap = t.category === 'wolf' && !seenAsWolf(t.role) ? '（查验口径为好人）' : '';
  return `${seat}号实际是${describeRole(t)}${trap}`;
}

/**
 * 判一条宣称是否算矛盾，返回一句中文理由；不算则返回 null。
 * 判定顺序即边界顺序：身份未知 → 不判；狼 → 不判；自认身份 → 只有"好人假跳神职"；
 * 查验 → 只有真预言家才判（其余人当时无从知道，不属于"说错"）。
 */
function contradictionReason({ kind, subject, value, speaker, target }) {
  if (!speaker) return null; // 座位/角色未知（未发牌、越界）：宁缺勿错，不判矛盾
  if (speaker.team === 'wolf') return null; // 边界①：狼必须能撒谎

  if (subject === 0) {
    if (!GOD_KINDS.has(kind)) return null; // 自称村民/other 不是"假跳神职"
    if (kind === speaker.role) return null; // 他真的就是这个神职，如实报牌
    return `好人阵营假跳神职（自称${KIND_NAME[kind] || '身份'}，实际是${describeRole(speaker)}）：这会把"真神职是谁"送给狼队，必须复核`;
  }

  if (kind !== 'seer') return null; // 用药类宣称不进矛盾：审计只判可硬核对的身份真值
  if (speaker.role !== 'seer') return null; // 边界③：他不是预言家，当时不可能知道，算什么"说错"
  if (!target) return null;
  const actualWolf = seenAsWolf(target.role);
  if (value === 'wolf' && !actualWolf) return `真预言家的查验结论与真值相反：${subject}号的实际查验结果是好人，不可能得出查杀`;
  if (value === 'good' && actualWolf) return `真预言家的查验结论与真值相反：${subject}号的实际查验结果是狼人，不可能得出金水`;
  return null;
}

/**
 * 一致性审计：把宣称账本逐条与真值对照。
 * @param {object} game 对局（只读；events/players 缺字段时退化为空结果，不抛错）
 * @returns {{rows:Array<{day,seat,said,truth,wasKnowable}>, contradictions:Array<{day,seat,kind,subject,value,said,truth,reason}>}}
 */
function consistencyFacts(game) {
  const rows = [];
  const contradictions = [];
  const events = game && Array.isArray(game.events) ? game.events : [];

  for (const e of events) {
    if (!e || e.type !== 'claim') continue;
    const d = e.data || {};
    const seat = Number(e.actor) || 0;
    const kind = String(d.kind || 'other');
    const subject = Number(d.subject) || 0; // 0 = 自认身份
    const value = String(d.value || '');
    // data.day 是"说这句话的那一天"（claims.js 落账时写入），顶层 e.day 是事件发生的天数，两者一致时取前者
    const day = Number(d.day != null ? d.day : e.day) || 0;

    const speaker = roleTruthOf(game, seat);
    const target = subject ? roleTruthOf(game, subject) : null;
    const said = renderClaim(d);
    const truth = subject ? targetTruthText(subject, target) : (speaker ? `${seat}号实际是${describeRole(speaker)}` : `${seat}号身份未知`);
    // 当时有没有渠道知道：自己的牌自己当然知道；别人的查验/用药，只有真的坐在那个位置上才知道
    const wasKnowable = subject === 0 ? true : !!(speaker && speaker.role === kind);

    rows.push({ day, seat, said, truth, wasKnowable });

    const reason = contradictionReason({ kind, subject, value, speaker, target });
    if (reason) contradictions.push({ day, seat, kind, subject, value, said, truth, reason });
  }

  return { rows, contradictions };
}

module.exports = { consistencyFacts };
