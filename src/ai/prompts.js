/**
 * prompts.js — 提示词构建
 * system 消息整局不变（规则 + 身份 + 座位表 + 人格），是前缀缓存命中的基础；
 * 动态信息（新事件、当前任务）只出现在追加的最后一条 user 消息里。
 */
'use strict';
const { ROLES } = require('../engine/roles');
const { describeRules } = require('../engine/rules');
const { strategyBlockFor } = require('./strategies');

/** 每种任务的指令与 JSON 格式要求 */
function taskInstruction(game, player, req) {
  const cand = (list) => (list && list.length ? `可选目标座位：${list.join('、')}。` : '');
  const retryNote = req._retryNote ? `\n\n⚠️ ${req._retryNote}` : '';
  const base = '请只输出一个 JSON 对象，不要输出任何其他文字或代码围栏。';
  switch (req.task) {
    case 'speech':
      if (req.canExplode) {
        const explodeNote = player.role === 'whitewolfking'
          ? '你若选择自爆，必须同时给出带走目标。'
          : '普通狼人/狼王自爆不能带人。';
        return `轮到你白天发言了。直接发言输出 {"text":"你的发言"}。` +
          `作为狼阵营，你也可以选择自爆（公开狼人身份并立即天黑）：{"text":"...","explode":true}` +
          (player.role === 'whitewolfking' ? `，白狼王自爆会带走一人：{"text":"...","explode":true,"target":<座位号>}` : `：{"text":"...","explode":true}`) +
          `。${explodeNote}请谨慎使用。${base}${retryNote}`;
      }
      return `轮到你白天发言了。请输出 {"text":"你的发言"}。${base}${retryNote}`;
    case 'pk_speech':
      return `你进入平票 PK，需要再次发言争取信任。请输出 {"text":"你的发言"}。${base}${retryNote}`;
    case 'lastwords': {
      const team = ROLES[player.role].team;
      const stance = team === 'wolf'
        ? (player.revealed
          ? '你的狼人身份已翻牌公开。遗言打法任选：①认狼护队：爽快认狼换好感，然后只咬 1 个具体好人（优先神职嫌疑）。②真假参半：用死无对证的"真"（如夜里刀口倾向）建信誉，夹带关键假信息。③反向咬人：恳切咬死 1 个好人，埋内耗种子。④好人榜：名单里好人与队友数量参半（相差≤1），队友放中段，只报名单不解释。⑤不配合：戏谑、谜语人，不给任何真信息。红线：不翻供、不求饶；名单配比失衡等于卖队友。'
          : '你的身份尚未公开。遗言可继续伪装（表水卖惨、引开怀疑），也可主动摊牌认狼做反向操作；无论哪种，别给出指向队友的真信息。'
        )
        : '把对你阵营有价值的东西留下来：查验信息、心证推理、票型分析，帮好人锁定狼人。';
      return `你已出局，请留遗言。${stance}\n请只输出 {"text":"你的遗言"}。${base}${retryNote}`;
    }
    case 'duel_check':
      return `又一位玩家发言结束了。你是骑士，可翻牌发起决斗：指定一名玩家，若他是狼人则其出局并直接天黑；若是好人则你出局以死谢罪（白天继续）。只在高度确信对方是狼时才发动——决斗错好人等于白送骑士。请输出 {"duel":false} 继续观察，或 {"duel":true,"target":<决斗目标座位号>}。${base}${retryNote}`;
    case 'explode_check':
      return `天亮了，你可随时自爆（公开狼身份并立即天黑${player.role === 'whitewolfking' ? '，并可带走一人' : ''}），只在收益明显大于潜伏时用。请输出 {"explode":false}${player.role === 'whitewolfking' ? ' 或 {"explode":true,"target":<带走目标座位号>}' : ''}。${base}${retryNote}`;
    case 'wolf_propose':
      return `狼队频道：请简短表态今晚刀谁（1~2 句）。请输出 {"text":"你的表态"}。${base}${retryNote}`;
    case 'wolf_chat':
      return `狼队频道讨论：请基于你目前的记忆（白天发言、票型、之前夜里的信息）提出今晚的刀口建议，并说明理由（1~3 句，像真人玩家一样讲思路）。${cand(req.candidates)}${req.allowNone ? '如果你认为空刀更好，target 填 0。' : '本局不允许空刀，必须建议一名目标。'}${game.day === 1 ? '另外，警长竞选在即：建议顺带商量好谁上警、是否由其中一人悍跳预言家（只能一个人跳，别撞车）。' : ''}请输出 {"text":"你的发言","target":<建议的座位号或0>}。${base}${retryNote}`;
    case 'wolf_kill':
      return `狼队频道：请投票决定今晚的刀口。${cand(req.candidates)}${req.allowNone ? '可以投 0 表示空刀。' : '本局不允许空刀，必须选一人。'}请输出 {"target":<座位号或0>}。${base}${retryNote}`;
    case 'night_guard':
      return `请选择今晚守护的对象（可以守自己${req.allowNone ? '，也可以选 0 空守' : ''}）。注意规则限制${game.rules.guardNoRepeat ? '：不能连续两晚守护同一人（列表中已排除）' : ''}。${cand(req.candidates)}请输出 {"target":<座位号或0>}。${base}${retryNote}`;
    case 'seer_check':
      return `请选择今晚查验的对象。${cand(req.candidates)}请输出 {"target":<座位号>}。${base}${retryNote}`;
    case 'witch': {
      const ex = req.extra || {};
      const lines = [];
      if (ex.canAntidote) lines.push(`今晚 ${ex.killTarget}号 被袭击，你可以用解药救他${ex.killTarget === player.seat ? (ex.selfSaveAllowed ? '（这是你自己，允许自救）' : '（这是你自己，但本局规则不允许自救）') : ''}）`);
      else lines.push(`解药${game.witch.antidoteUsed ? '已用完' : '今晚无法使用（无人被袭或规则限制）'}`);
      lines.push(ex.canPoison ? '毒药可用，可毒杀任意存活玩家' : '毒药已用完');
      return `请决定用药。${lines.join('；')}。两瓶药每晚限用一瓶。请输出 {"antidote":true/false,"poison":<座位号或0>}（0 表示不用毒）。${base}${retryNote}`;
    }
    case 'sheriff_run':
      return `警长竞选开始，是否上警？上警将参与竞选演讲并有机会成为警长（1.5票、决定发言顺序），但会暴露身份受关注。${ROLES[player.role].team === 'wolf' ? '作为狼人，上警可抢警徽、悍跳、掩护队友；狼队商量过由你上就务必上。' : ''}请输出 {"run":true/false}。${base}${retryNote}`;
    case 'sheriff_speech':
      return `轮到你警上竞选演讲。请输出 {"text":"你的演讲","withdraw":false}` +
        (req.canWithdraw ? '。演讲后如果你想退出竞选可设 "withdraw":true（退水后无被投票权也无投票权）' : '') +
      (req.canExplode ? `。作为狼阵营你也可以自爆吞警徽/打断局势：{"text":"...","explode":true}` : '') +
      (ROLES[player.role].team === 'wolf' ? '。作为狼人可悍跳预言家（假查验+警徽流+心路历程）；队友已跳则别撞车；自洽红线：首夜只能声称 1 个查验结果，报 2 个等于当场穿帮' : '') +
      `。${base}${retryNote}`;
    case 'sheriff_vote':
      return `警长竞选投票：${cand(req.candidates)}0 表示弃票。请输出 {"target":<座位号或0>}。${base}${retryNote}`;
    case 'badge_pass':
      return `你是警长且即将离场，请决定警徽去向：移交给任意存活玩家，或撕毁警徽。请输出 {"target":<座位号>}（0 表示撕毁）。${base}${retryNote}`;
    case 'direction':
      return `你是警长，请决定今天白天的发言方向：cw（顺时针）或 ccw（逆时针），从昨晚死者下家开始。请输出 {"direction":"cw"/"ccw"}。${base}${retryNote}`;
    case 'vote':
      return `放逐投票：请选出你认为最可能是狼人的玩家。${cand(req.candidates)}0 表示弃票。投票互相保密。请输出 {"target":<座位号或0>}。${base}${retryNote}`;
    case 'pk_vote':
      return `平票 PK 投票：只能在 PK 玩家中选择。${cand(req.candidates)}0 表示弃票。请输出 {"target":<座位号或0>}。${base}${retryNote}`;
    case 'shoot':
      return `你触发了开枪技能，可以带走一名玩家${req.allowNone !== false ? '，也可以选 0 放弃开枪' : ''}。请输出 {"target":<座位号或0>}。${base}${retryNote}`;
    default:
      return `请根据当前情况输出 JSON。${base}${retryNote}`;
  }
}

/**
 * system 公共部分：同一局所有 AI 逐字节一致，且位于 system 最前。
 * 服务商前缀缓存按 (model, 前缀) 共享——11 个 AI 互相预热，谁先调用谁付冷启动成本。
 * 因此一切玩家专属信息（座位/身份/性格/立场）都必须放在 buildPersonalPrompt。
 */
function buildCommonPrompt(game) {
  const lines = [];
  lines.push('你正在参与一局狼人杀游戏。你必须始终以一名真实玩家身份行动，绝不能提及自己是 AI、模型或程序，也不能跳出角色。');
  lines.push('');
  lines.push('## 全体座位表');
  lines.push(game.players.map((p) => `${p.seat}号 ${p.name}${p.isHuman ? '（真人）' : ''}`).join('，'));
  lines.push('');
  lines.push('## 本局规则');
  lines.push(describeRules(game.rules));
  lines.push('遗言：首夜死者' + (game.rules.lastWords.night1 ? '有' : '无') + '遗言；被放逐者' + (game.rules.lastWords.exiled ? '有' : '无') + '遗言。');
  lines.push('');
  lines.push('');
  lines.push('## 本局职业配置');
  lines.push(Object.entries(game.board).filter(([, n]) => n > 0).map(([rid, n]) => `${ROLES[rid].name}×${n}`).join('，'));
  lines.push('');
  lines.push('## 职业一览（本局存在的职业）');
  for (const rid of Object.keys(game.board)) {
    if (!game.board[rid]) continue;
    lines.push(`【${ROLES[rid].name}】${ROLES[rid].short}`);
  }
  lines.push('');
  lines.push('## 流程常识');
  lines.push('- 狼人夜里只决定刀口，当晚没有任何关于结果的消息：刀口可能被守护或被女巫救下，是否得手要等天亮公告才知道。');
  lines.push('- 天亮时公布昨夜死讯；死者身份是否公开由本局翻牌规则决定。不要声称自己不可能知道的夜间信息（比如猜测的死者身份）。');
  lines.push('- 女巫首夜可以救人也可以不救，解药毒药整场各限一次；猎人被毒杀时无法开枪。');
  lines.push('');
  lines.push('## 胜负条件');
  lines.push('好人阵营：所有狼人出局即获胜。狼人阵营：屠边——所有神职出局或所有平民出局即获胜。');
  lines.push('');
  lines.push('## 时间与信息常识（防幻觉铁律）');
  lines.push('- 游戏按"夜晚→天亮→白天发言→投票"循环推进。事件都按发生顺序给出，【局面快照】开头的"当前时刻"就是唯一的现在，一切以快照为准。');
  lines.push('- 第1夜你只知道发牌时系统告诉你的信息（身份、队友）。狼人第1夜不知道任何人的身份——"狼人首夜刀预言家/刀神职"这类剧本没有任何信息支撑，绝不要臆测。');
  lines.push('- 只基于时间线上真实出现过的事件与发言推理。日志里没有的事就是没发生过，不要脑补"按常理应该已经发生了什么"。');
  lines.push('- 已翻牌的身份是确定事实；出局玩家不再有任何发言与行动。');
  lines.push('- 你的私密信息（查验/刀口/用药/守护/队友）以快照中"你确知"清单为准；其余玩家未翻牌前身份一律未知，对方的"声称"只是声称。');
  lines.push('- **声称必须自洽（穿帮红线）**：编造的信息要经得起规则核对。硬账目：预言家每晚只验一人——第1天白天最多声称 1 个查验，之后每过一夜可多报 1 个，"一夜双验"等于自爆；女巫两药各限一次；死人不会发言行动。战术谎言可以撒，账目错的谎言是低级穿帮。');
  lines.push('');
  lines.push('## 行为要求（通用）');
  lines.push('- 全程中文口语化发言，像真人玩家，正常发言 50~150 字，有明确观点和逻辑。用符合你性格的方式说话，但不要每句都提自己的性格标签。');
  lines.push('- 白天发言要有内容：站边、质疑、报查验、梳理票型等，不要每次都说套话。');
  lines.push('- 保护自己阵营的秘密。除非战术需要，不主动交代夜晚私密信息。');
  lines.push('- 你只能基于对话中出现过的信息行动，不要编造未发生的事件。');
  lines.push('- 决策要果断高效：内心思考尽量简短直接，快速基于已有信息下结论，把输出空间留给最终答案。');
  lines.push('- 严格按要求输出 JSON。');
  return lines.join('\n');
}

/** system 个性部分：座位/身份/技能/队友/性格/阵营立场铁律（各玩家不同，置于公共段之后） */
function buildPersonalPrompt(game, player) {
  const role = ROLES[player.role];
  const mates = game.wolves().filter((p) => p.seat !== player.seat).map((p) => `${p.seat}号${p.name}`);
  const lines = [];
  lines.push('## 你的身份');
  lines.push(`座位：${player.seat}号（昵称：${player.name}）`);
  lines.push(`身份：${role.name}`);
  lines.push(`技能说明：${role.description}`);
  if (role.team === 'wolf') lines.push(`你的狼队队友：${mates.length ? mates.join('、') : '（暂无其他狼人存活信息）'}。夜里狼队频道内可以互相交流。`);
  lines.push('');
  if (player.personality) {
    lines.push('## 你的性格');
    lines.push(player.personality + '（性格只影响说话风格，不改变你的阵营目标。）');
    lines.push('');
  }
  const strat = strategyBlockFor(player.role);
  if (strat) {
    lines.push('## 推荐打法（供参考，可灵活应变，不必照搬）');
    lines.push(strat);
    lines.push('');
  }
  if (role.team === 'wolf') {
    lines.push('## 立场铁律');
    lines.push('- 一切发言与遗言都服务狼阵营胜利：不给出指向队友的可验证真信息，不替好人复盘正确结论。');
    lines.push('- 被推上放逐台先求生（表水、质疑查验来源、引开矛盾）；自感必死则转为埋假线索。');
    lines.push('- 悍跳时全队只一人跳同一身份，先在狼队频道商量；狼人可虚构查验与身份——战术性伪装是正当策略，但不影响你对真实历史的判断。');
  } else {
    lines.push('## 立场铁律');
    lines.push('- 你属于好人阵营：发言、投票与遗言都帮好人找狼取胜，别无谓暴露神职身份；狼人遗言可能是假话，别当铁证。');
  }
  return lines.join('\n');
}

/** system 消息：整局不变 = 公共段（全场共享前缀）+ 个性段 */
function buildSystemPrompt(game, player) {
  return buildCommonPrompt(game) + '\n\n' + buildPersonalPrompt(game, player);
}

/** 每日反思指令：把刚结束的一天压缩成结构化纪要（Generative-Agents 式 reflection） */
function reflectionInstruction(game, player, day, eventsText) {
  return [
    `你是狼人杀游戏中的 ${player.seat}号。第 ${day} 天已经结束，下面是你以自己的视角看到的这一天全部事件。`,
    '请把它压缩成一份不超过 400 字的纪要，供你在之后的天数里回忆这一天。必须包含：',
    '1.【身份判断】对每个仍在场玩家的一句话判断（怀疑谁/信任谁 + 核心理由 + 置信度高/中/低）；',
    '2.【关键发言】这一天最重要的 3~5 条发言（谁、什么立场、声称了什么）；',
    '3.【硬事实】死亡、翻牌、票型中的关键结论；',
    '4.【我的状态】我说过的话、做过的承诺、暴露程度，以及我下一步的打算。',
    '直接输出纪要正文，不要任何解释或开场白。',
    '',
    '──── 第' + day + '天事件 ────',
    eventsText,
  ].join('\n');
}

module.exports = { buildSystemPrompt, buildCommonPrompt, buildPersonalPrompt, taskInstruction, reflectionInstruction };
