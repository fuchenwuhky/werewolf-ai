/**
 * rules.js — 规则开关系统（唯一事实来源见 docs/rules.md §五）
 * DEFAULT_RULES = 网易 12 人守卫局（官方进阶场）默认值。
 * RULE_META 供设置页自动生成开关控件，也在开局"本局生效规则"里渲染。
 */
'use strict';

const DEFAULT_RULES = {
  // 1. 警长竞选
  sheriff: true,
  // 2. 吞警徽模式：off=自爆不影响竞选 / single=一次自爆取消竞选 / double=两次自爆才取消（12人守卫局官方为双爆）
  badgeSwallow: 'double',
  // 3. 警长票权
  sheriffVoteWeight: 1.5,
  // 4. 女巫自救：never=全程不可（网易12人场）/ firstNight=仅首夜可（网易10人场）/ always=全程可
  witchSelfSave: 'never',
  // 5. 同守同救：die=奶穿死亡(视同被狼袭,猎人可开枪) / cancel=技能互相无效(目标存活) / guardDies=目标为守卫则守卫死,否则存活
  milkThrough: 'die',
  // 6. 守卫禁止连续两晚守护同一人
  guardNoRepeat: true,
  // 7. 狼人允许空刀
  allowEmptyKill: true,
  // 7.5 狼队夜间讨论轮数（每轮每只 AI 狼发言一次并给出建议刀口与理由；人类狼可随时插话、可加轮、可提前结束）
  wolfChatRounds: 2,
  // 8. 允许狼人白天自爆
  allowSelfExplode: true,
  // 9. 狼人自爆遗言：firstDay=仅首日有 / none=无
  explodeLastWords: 'firstDay',
  // 10. 遗言开关组
  lastWords: {
    night1: true,    // 首夜死者有遗言（之后夜晚死者无）
    exiled: true,    // 被放逐者有遗言
    shotVictim: false, // 被枪带走者无遗言（白狼王带走者官方明确无）
    explodeFirstDay: true, // 狼自爆仅首日有遗言
  },
  // 11. 夜晚行动顺序（每晚固定；暗恋者仅首夜行动，板子里不存在的步骤自动跳过）
  nightOrder: ['admirer', 'guard', 'dreamer', 'wolf', 'wolfbeauty', 'seer', 'witch', 'crow'],
  // 12. 死亡翻牌公开（网易线上为翻牌局）
  revealOnDeath: true,
  // 13. 无警长时发言起点：afterDeath=死者下家顺时针（平安夜随机）/ random=随机
  noSheriffSpeechStart: 'afterDeath',
  // 14. 警长压轴最后发言
  sheriffFinalSpeech: true,
};

const NIGHT_STEPS = [
  { key: 'admirer', label: '暗恋者心动' },
  { key: 'guard', label: '守卫行动' },
  { key: 'dreamer', label: '摄梦人行动' },
  { key: 'wolf', label: '狼人行动' },
  { key: 'wolfbeauty', label: '狼美人行动' },
  { key: 'seer', label: '预言家查验' },
  { key: 'witch', label: '女巫用药' },
  { key: 'crow', label: '乌鸦诅咒' },
];

/** 设置页开关元数据：key → 控件定义 */
const RULE_META = [
  {
    key: 'sheriff', label: '警长竞选', type: 'bool', default: true,
    desc: '首夜后、宣布死讯前进行警长竞选；关闭则本局无警长。',
  },
  {
    key: 'badgeSwallow', label: '吞警徽模式', type: 'enum', default: 'double',
    options: [
      { value: 'off', label: '关（自爆不影响竞选）' },
      { value: 'single', label: '单爆吞警徽' },
      { value: 'double', label: '双爆吞警徽（12人守卫局官方）' },
    ],
    desc: '警长竞选阶段狼人自爆对警徽的影响。',
  },
  {
    key: 'sheriffVoteWeight', label: '警长票权', type: 'enum', default: '1.5',
    options: [
      { value: '1', label: '1 票' },
      { value: '1.5', label: '1.5 票（官方）' },
      { value: '2', label: '2 票' },
    ],
    desc: '警长在放逐投票中的票权。',
    parse: (v) => Number(v),
  },
  {
    key: 'witchSelfSave', label: '女巫自救', type: 'enum', default: 'never',
    options: [
      { value: 'never', label: '全程不可自救（网易12人场）' },
      { value: 'firstNight', label: '仅首夜可自救（网易10人场）' },
      { value: 'always', label: '全程可自救' },
    ],
    desc: '女巫能否用解药救自己。',
  },
  {
    key: 'milkThrough', label: '同守同救（奶穿）', type: 'enum', default: 'die',
    options: [
      { value: 'die', label: '奶穿死亡，视同被狼袭（官方）' },
      { value: 'cancel', label: '技能互相无效，目标存活' },
      { value: 'guardDies', label: '目标是守卫则守卫死，否则存活' },
    ],
    desc: '守卫守护与女巫解药同夜作用于同一被袭者时。',
  },
  {
    key: 'guardNoRepeat', label: '守卫禁止连守', type: 'bool', default: true,
    desc: '守卫不能连续两晚守护同一名玩家（官方）。',
  },
  {
    key: 'allowEmptyKill', label: '狼人允许空刀', type: 'bool', default: true,
    desc: '狼人夜晚可以放弃袭击。',
  },
  {
    key: 'wolfChatRounds', label: '狼队夜间讨论轮数', type: 'enum', default: '2',
    options: [
      { value: '0', label: '不讨论（直接投刀）' },
      { value: '1', label: '1 轮' },
      { value: '2', label: '2 轮' },
      { value: '3', label: '3 轮' },
      { value: '4', label: '4 轮' },
    ],
    desc: '每轮每只 AI 狼基于记忆发言一次（建议刀口+理由）；你是狼时可随时插话，可临时 +1 轮（立即生效）或提前结束讨论。',
    parse: (v) => Number(v),
  },
  {
    key: 'allowSelfExplode', label: '狼人允许自爆', type: 'bool', default: true,
    desc: '白天轮到狼阵营发言时可自爆立即天黑；白狼王自爆可带走一人。',
  },
  {
    key: 'explodeLastWords', label: '自爆遗言', type: 'enum', default: 'firstDay',
    options: [
      { value: 'firstDay', label: '仅首日自爆有遗言（官方）' },
      { value: 'none', label: '自爆无遗言' },
    ],
    desc: '狼人自爆后的遗言规则。',
  },
  {
    key: 'revealOnDeath', label: '死亡翻牌', type: 'bool', default: true,
    desc: '玩家死亡时公开其身份（网易线上为翻牌局）。',
  },
  {
    key: 'noSheriffSpeechStart', label: '无警长时发言起点', type: 'enum', default: 'afterDeath',
    options: [
      { value: 'afterDeath', label: '死者下家顺时针（平安夜随机）' },
      { value: 'random', label: '随机起点' },
    ],
    desc: '无警长（或警长已死）时白天发言顺序的起点。',
  },
  {
    key: 'sheriffFinalSpeech', label: '警长压轴发言', type: 'bool', default: true,
    desc: '警长每天最后发言并归票。',
  },
  {
    key: 'lw.night1', label: '首夜死者遗言', type: 'bool', path: 'lastWords.night1', default: true,
    desc: '仅首夜死亡的玩家有遗言，之后夜晚死者无遗言（官方）。',
  },
  {
    key: 'lw.exiled', label: '被放逐者遗言', type: 'bool', path: 'lastWords.exiled', default: true,
    desc: '被投票放逐的玩家有遗言（官方：白天死亡均有遗言）。',
  },
  {
    key: 'lw.shotVictim', label: '被枪带走者遗言', type: 'bool', path: 'lastWords.shotVictim', default: false,
    desc: '被开枪带走的玩家是否有遗言（默认无：白狼王带走者官方明确无遗言）。',
  },
  {
    key: 'nightOrder', label: '夜晚行动顺序', type: 'nightOrder', default: ['admirer', 'guard', 'dreamer', 'wolf', 'wolfbeauty', 'seer', 'witch', 'crow'],
    desc: '每晚固定的行动顺序，可调整先后（板子里不存在的角色自动跳过）。',
  },
];

/** 递归合并用户规则到默认值（仅接受已知键） */
function mergeRules(partial) {
  const out = JSON.parse(JSON.stringify(DEFAULT_RULES));
  if (!partial || typeof partial !== 'object') return out;
  if (typeof partial.lastWords === 'object' && partial.lastWords) {
    Object.assign(out.lastWords, pickKnown(partial.lastWords, out.lastWords));
    delete partial.lastWords;
  }
  Object.assign(out, pickKnown(partial, out));
  // nightOrder 兼容：老版本存档/前端缓存缺新步骤时自动补齐（保留用户已有相对顺序）
  if (Array.isArray(out.nightOrder)) {
    for (const s of DEFAULT_RULES.nightOrder) {
      if (!out.nightOrder.includes(s)) out.nightOrder.push(s);
    }
  }
  return out;
}

function pickKnown(src, ref) {
  const out = {};
  for (const k of Object.keys(ref)) {
    if (k in src && typeof src[k] === typeof ref[k]) out[k] = src[k];
  }
  return out;
}

/** 规则 → 中文生效描述（AI 提示词与本局规则页共用） */
function describeRules(rules) {
  const lines = [];
  lines.push(`警长竞选：${rules.sheriff ? '有（首夜后进行）' : '无（本局无警长）'}`);
  if (rules.sheriff) {
    lines.push(`吞警徽：${{ off: '自爆不影响竞选', single: '竞选阶段狼人自爆一次即取消警长', double: '竞选阶段狼人自爆两次才取消警长（双爆吞警徽）' }[rules.badgeSwallow]}`);
    lines.push(`警长票权：放逐投票中警长算 ${rules.sheriffVoteWeight} 票；警长每天决定发言方向并压轴最后发言`);
  }
  lines.push(`女巫自救：${{ never: '全程不可自救', firstNight: '仅第一夜可以用解药自救', always: '全程可自救' }[rules.witchSelfSave]}`);
  lines.push(`同守同救：${{ die: '守卫守护与解药同夜作用于同一人时，该玩家死亡（奶穿，视同被狼袭）', cancel: '守卫与解药互相抵消，目标存活', guardDies: '若同守同救目标正是守卫，守卫死亡；否则目标存活' }[rules.milkThrough]}`);
  lines.push(`守卫连守：${rules.guardNoRepeat ? '不能连续两晚守护同一人' : '可以连续守护同一人'}`);
  lines.push(`狼人空刀：${rules.allowEmptyKill ? '允许' : '不允许（每晚必须袭击一人）'}`);
  lines.push(`狼队讨论：每夜 ${rules.wolfChatRounds} 轮，按座位顺序轮流发言（轮到人类狼可选发言或跳过；AI 狼给建议刀口并说明理由）`);
  lines.push(`狼人自爆：${rules.allowSelfExplode ? '允许（轮到自己白天发言时可自爆立即天黑）' : '不允许'}`);
  if (rules.allowSelfExplode) lines.push(`自爆遗言：${rules.explodeLastWords === 'firstDay' ? '仅首日自爆有遗言' : '自爆没有遗言'}`);
  lines.push(`死亡翻牌：${rules.revealOnDeath ? '玩家死亡时公开身份' : '暗牌局，死亡不公开身份'}`);
  lines.push(`遗言：首夜死者${rules.lastWords.night1 ? '有' : '无'}遗言；被放逐者${rules.lastWords.exiled ? '有' : '无'}遗言；被枪带走者${rules.lastWords.shotVictim ? '有' : '无'}遗言`);
  const stepNames = { admirer: '暗恋者', guard: '守卫', dreamer: '摄梦人', wolf: '狼人', wolfbeauty: '狼美人', seer: '预言家', witch: '女巫', crow: '乌鸦' };
  lines.push(`夜晚顺序：${rules.nightOrder.map((s) => stepNames[s] || s).join(' → ')}`);
  return lines.map((l) => '· ' + l).join('\n');
}

module.exports = { DEFAULT_RULES, RULE_META, NIGHT_STEPS, mergeRules, describeRules };
