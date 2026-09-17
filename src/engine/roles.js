/**
 * roles.js — 身份牌唯一数据源
 * 同一份数据驱动：AI 提示词、游戏内 UI（身份牌/角色图鉴）、docs/roles.md。
 * 新增身份只需在此注册能力，不需要改编排代码（flow.js 按 nightStep / deathTrigger / 能力标记驱动）。
 *
 * category 用于屠边判定：'wolf' | 'god' | 'villager'
 * nightStep  为夜晚行动步骤键（与 rules.nightOrder 对应；wolf 阵营统一为 'wolf'）
 */
'use strict';

const ROLES = {
  villager: {
    id: 'villager',
    name: '平民',
    team: 'good',
    category: 'villager',
    emoji: '🌾',
    color: '#7cb342',
    nightStep: null,
    deathTrigger: null,
    short: '没有任何能力，一觉睡到天亮，用推理和发言帮好人赢。',
    description: '你没有任何特殊能力，每晚闭眼睡觉。白天请用逻辑推理找出狼人，用发言帮助好人阵营获胜。',
  },

  wolf: {
    id: 'wolf',
    name: '狼人',
    team: 'wolf',
    category: 'wolf',
    emoji: '🐺',
    color: '#e53935',
    nightStep: 'wolf',
    deathTrigger: null,
    selfExplode: true,
    short: '每晚袭击一人；白天可自爆立即天黑。',
    description: '每晚与狼队友一起袭击一名玩家。白天隐藏身份、带偏视听。轮到你发言时可以选择自爆，自爆后立即天黑。',
  },

  wolfking: {
    id: 'wolfking',
    name: '狼王',
    team: 'wolf',
    category: 'wolf',
    emoji: '👑',
    color: '#d32f2f',
    nightStep: 'wolf',
    deathTrigger: { shoot: true, on: ['wolf_kill', 'vote_out', 'shot'] },
    selfExplode: true,
    short: '死后可开枪带走一人（被毒杀不可）。',
    description: '狼人阵营。与狼队友一起袭击玩家。你出局时（被狼袭、被放逐、被枪带走）可以开枪带走一名玩家；被毒杀时不能开枪。普通自爆不能带人。',
  },

  whitewolfking: {
    id: 'whitewolfking',
    name: '白狼王',
    team: 'wolf',
    category: 'wolf',
    emoji: '⚡',
    color: '#b71c1c',
    nightStep: 'wolf',
    deathTrigger: null,
    selfExplode: true,
    explodeShot: true,
    short: '仅白天自爆时可带走一名玩家。',
    description: '狼人阵营。与狼队友一起袭击玩家。你只能在白天自爆时带走一名玩家（被带走者没有遗言）；其他任何方式出局都不能发动技能。',
  },

  seer: {
    id: 'seer',
    name: '预言家',
    team: 'good',
    category: 'god',
    emoji: '🔮',
    color: '#5c6bc0',
    nightStep: 'seer',
    deathTrigger: null,
    short: '每晚查验一人阵营（好人/狼人）。',
    description: '每晚可以查验一名玩家的阵营（好人或狼人）。查验结果只有你自己知道。白天要带领好人找出狼人。',
  },

  witch: {
    id: 'witch',
    name: '女巫',
    team: 'good',
    category: 'god',
    emoji: '⚗️',
    color: '#8e24aa',
    nightStep: 'witch',
    deathTrigger: null,
    short: '解药救被袭者、毒药毒一人；每晚限一瓶，夜间知晓刀口。',
    description: '拥有一瓶解药和一瓶毒药。每晚你会得知今晚被狼人袭击的玩家；可以用解药救活他，或用毒药毒死一名玩家，每晚最多使用一瓶药，也可以都不用。解药只能救当晚被袭击的人。',
  },

  hunter: {
    id: 'hunter',
    name: '猎人',
    team: 'good',
    category: 'god',
    emoji: '🎯',
    color: '#f4511e',
    nightStep: null,
    deathTrigger: { shoot: true, on: ['wolf_kill', 'vote_out', 'shot'] },
    short: '被狼袭或被放逐时可开枪带走一人；被毒不可。',
    description: '当且仅当你被狼人袭击或被投票放逐时（含被枪带走），可以翻牌开枪带走一名玩家；被女巫毒杀时不能开枪。你可以选择不开枪。',
  },

  guard: {
    id: 'guard',
    name: '守卫',
    team: 'good',
    category: 'god',
    emoji: '🛡️',
    color: '#00897b',
    nightStep: 'guard',
    deathTrigger: null,
    short: '每晚守护一人免于狼袭；不能连续两晚守同一人。',
    description: '每晚可以守护一名玩家（可以守自己），使其当晚免于狼人袭击；不能连续两晚守护同一名玩家。你的守护对女巫的毒药无效。',
  },

  idiot: {
    id: 'idiot',
    name: '白痴',
    team: 'good',
    category: 'god',
    emoji: '🃏',
    color: '#039be5',
    nightStep: null,
    deathTrigger: null,
    voteImmunity: true,
    short: '被放逐时翻牌免疫，之后可发言不可投票。',
    description: '当你被投票放逐时，可以翻牌亮出身份免于出局，之后可以继续发言但不能投票；你死于夜间袭击、毒杀或枪杀时技能失效，直接死亡。',
  },
  knight: {
    id: 'knight',
    name: '骑士',
    team: 'good',
    category: 'god',
    emoji: '⚔️',
    color: '#8e7dff',
    nightStep: null,
    deathTrigger: null,
    selfExplode: false,
    short: '白天可翻牌决斗：决斗狼人则其出局入夜；决斗好人则骑士以死谢罪。',
    description: '除警长竞选阶段外，你可以在白天任意玩家的发言阶段翻牌发起决斗：指定一名玩家，若他是狼人则其立即出局并直接进入黑夜；若是好人则你出局以死谢罪，白天继续。决斗不能指定自己。',
  },

  dreamer: {
    id: 'dreamer',
    name: '摄梦人',
    team: 'good',
    category: 'god',
    emoji: '🌙',
    color: '#7e57c2',
    nightStep: 'dreamer',
    deathTrigger: null,
    short: '每晚必须摄梦一人：梦游者当夜免疫袭击与毒杀；连摄两晚同一人则其死亡（救不活）；摄梦人夜里死则梦游者连带出局。',
    description: '每晚你必须选择一名其他玩家摄梦，使其成为当夜的梦游者。梦游者当夜免疫狼人袭击和毒药（女巫的药会白白消耗）。若你连续两晚摄梦同一名玩家，该玩家死亡，女巫救不活。若你在夜里死亡，当晚的梦游者会连带出局。被摄梦死亡的猎人/狼王不能开枪。',
  },

  wolfbeauty: {
    id: 'wolfbeauty',
    name: '狼美人',
    team: 'wolf',
    category: 'wolf',
    emoji: '💃',
    color: '#c2185b',
    nightStep: 'wolfbeauty',
    deathTrigger: null,
    selfExplode: false,
    short: '每晚魅惑一人（不能是自己或狼队）；你被毒/放逐/枪杀等出局时被魅惑者殉情出局；死于骑士决斗则魅惑失效；不能自爆。',
    description: '狼人阵营，参与狼队的讨论与刀口。你另有单独技能：每晚可以魅惑一名玩家（不能是自己，也不能是狼队成员）。当你被毒杀、被放逐、被开枪带走、被摄梦等方式出局时，被你魅惑的玩家立即殉情出局，没有遗言、不能发动技能；但你若死于骑士决斗，魅惑失效。你不能自爆。',
  },

  crow: {
    id: 'crow',
    name: '乌鸦',
    team: 'good',
    category: 'god',
    emoji: '🐦',
    color: '#546e7a',
    nightStep: 'crow',
    deathTrigger: null,
    short: '每晚诅咒一人：被诅咒者次日的放逐投票中额外多 0.5 票（警长竞选投票不受影响）。',
    description: '每晚你可以诅咒一名玩家（不能是自己）。被诅咒的玩家在接下来白天的放逐投票中会被额外计入 0.5 票；警长竞选投票不受影响。每晚重新诅咒会覆盖之前的诅咒。',
  },

  hiddenwolf: {
    id: 'hiddenwolf',
    name: '隐狼',
    team: 'wolf',
    category: 'wolf',
    emoji: '🌫️',
    color: '#6d4c41',
    nightStep: null,
    deathTrigger: null,
    selfExplode: false,
    short: '狼营暗牌：夜里不睁眼、不参与刀口，也不知道刀口；你知道狼队友但狼队不知道你；被查验结果永远是好人；不能自爆。',
    description: '狼人阵营的暗牌。夜晚你不睁眼：不参与狼队讨论、不参与刀口投票，也看不到今晚的刀口。开局时你知道狼队友是谁，但狼队友不知道你的存在。预言家查验你时结果永远是"好人"。白天请伪装成好人发言，把水搅浑；你与狼队共享胜负。你不能自爆。',
  },

  admirer: {
    id: 'admirer',
    name: '暗恋者',
    team: 'good',
    category: 'villager',
    // 有效阵营**不固定**：绑定暗恋对象后随对方终身变动（实现见 Game.categoryOf()，
    // 屠边胜负按变动后的类别判）。所以 category 只是"还没绑定时的基线"，不是它的阵营。
    // UI 与文档必须读这个标记，否则会把暗恋者当成平民展示 —— 那是错的。
    categoryDynamic: 'crush',
    emoji: '💗',
    color: '#ec407a',
    nightStep: 'admirer',
    deathTrigger: null,
    short: '首夜最先行动暗选一名暗恋对象，胜负阵营与其终身绑定；预言家查验你永远是好人。',
    description: '第一夜你最先行动，必须暗中选择一名其他玩家作为暗恋对象（对方不会知道）。你的胜负阵营与暗恋对象终身绑定：他是神职你就算神职、平民就算平民、狼人阵营则你随狼人阵营获胜——即使他死了绑定依然有效。但无论绑定谁，预言家查验你的结果永远是"好人"。不要暴露你的身份。',
  },
};

const ROLE_IDS = Object.keys(ROLES);

/** 内置板子模板（默认 = 网易 12 人进阶场 / 守卫局） */
const BOARDS = {
  adv12: {
    id: 'adv12',
    name: '12人进阶场 · 守卫局（官方默认）',
    desc: '狼王+3狼 + 预女猎守 + 4民，网易官方"12人进阶场"',
    roles: { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
  },
  guard12: {
    id: 'guard12',
    name: '12人守卫局 · 纯狼版',
    desc: '4狼 + 预女猎守 + 4民，无狼王的守卫局变体',
    roles: { wolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
  },
  std12: {
    id: 'std12',
    name: '12人标准场 · 白痴版',
    desc: '4狼 + 预女猎白 + 4民，网易官方"12人标准场"',
    roles: { wolf: 4, seer: 1, witch: 1, hunter: 1, idiot: 1, villager: 4 },
  },
  quick10: {
    id: 'quick10',
    name: '10人速推局',
    desc: '3狼 + 预女猎 + 3民，节奏快、消耗少',
    roles: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 3 },
  },
  wwknight12: {
    id: 'wwknight12',
    name: '12人白狼王骑士场',
    desc: '白狼王+3狼 + 预女骑白 + 4民，决斗与自爆的操作型快节奏板子',
    roles: { whitewolfking: 1, wolf: 3, seer: 1, witch: 1, knight: 1, idiot: 1, villager: 4 },
  },
  wwkguard12: {
    id: 'wwkguard12',
    name: '12人白狼王守卫场',
    desc: '白狼王+3狼 + 预女猎守 + 4民，网易官方板子',
    roles: { whitewolfking: 1, wolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
  },
  dreamer12: {
    id: 'dreamer12',
    name: '12人狼王摄梦人场',
    desc: '狼王+3狼 + 预女猎摄 + 4民，网易官方板子：连摄是武器也是双刃剑',
    roles: { wolf: 3, wolfking: 1, seer: 1, witch: 1, hunter: 1, dreamer: 1, villager: 4 },
  },
  wolfbeautyknight12: {
    id: 'wolfbeautyknight12',
    name: '12人狼美人骑士场',
    desc: '狼美人+3狼 + 预女守骑 + 4民；板规：女巫全程不能自救',
    roles: { wolfbeauty: 1, wolf: 3, seer: 1, witch: 1, guard: 1, knight: 1, villager: 4 },
    rules: { witchSelfSave: 'never' },
  },
  crowhidden12: {
    id: 'crowhidden12',
    name: '12人乌鸦隐狼场',
    desc: '狼王+2狼+隐狼 + 预女猎乌 + 4民：查验结果里有陷阱的诅咒板',
    roles: { wolfking: 1, wolf: 2, hiddenwolf: 1, seer: 1, witch: 1, hunter: 1, crow: 1, villager: 4 },
  },
  admirer12: {
    id: 'admirer12',
    name: '12人暗恋者场',
    desc: '4狼 + 预女猎 + 4民 + 暗恋者，首夜绑定阵营的暗牌屠边局',
    roles: { wolf: 4, seer: 1, witch: 1, hunter: 1, admirer: 1, villager: 4 },
  },
};

/** 校验自定义板子：角色合法、总数 >= 4、至少 1 狼、好人 >= 2 */
function validateBoard(boardRoles) {
  const errors = [];
  let total = 0;
  let wolves = 0;
  let goods = 0;
  for (const [id, count] of Object.entries(boardRoles || {})) {
    if (!ROLES[id]) { errors.push(`未知角色：${id}`); continue; }
    if (!Number.isInteger(count) || count < 0) { errors.push(`${ROLES[id].name} 数量非法`); continue; }
    total += count;
    if (ROLES[id].team === 'wolf') wolves += count; else goods += count;
  }
  if (total < 4) errors.push('总人数至少 4 人');
  if (wolves < 1) errors.push('至少需要 1 名狼人');
  if (goods < 2) errors.push('好人阵营至少需要 2 人');
  if (wolves >= goods) errors.push('狼人数量应少于好人数量');
  return { ok: errors.length === 0, errors, total, wolves, goods };
}

/** 给定板子生成打乱前的角色数组 */
function buildRoleDeck(boardRoles) {
  const deck = [];
  for (const [id, count] of Object.entries(boardRoles)) {
    for (let i = 0; i < count; i++) deck.push(id);
  }
  return deck;
}

module.exports = { ROLES, ROLE_IDS, BOARDS, validateBoard, buildRoleDeck };
