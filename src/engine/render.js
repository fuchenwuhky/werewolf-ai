/**
 * render.js — 事件 → 中文文本渲染（AI 上下文与前端兜底显示共用）
 * 注意：渲染永远只用于"已通过可见性过滤"的事件，本模块不做权限判断。
 */
'use strict';
const { ROLES } = require('./roles');

const TASK_META = {
  speech: { label: '发言', needText: true },
  lastwords: { label: '留遗言', needText: true },
  pk_speech: { label: 'PK 发言', needText: true },
  sheriff_speech: { label: '警长竞选演讲', needText: true },
  wolf_propose: { label: '狼队频道表态', needText: true },
  night_guard: { label: '选择守护目标', needTarget: true },
  night_dream: { label: '选择摄梦目标', needTarget: true },
  wolfbeauty_charm: { label: '选择魅惑目标', needTarget: true },
  crow_curse: { label: '选择诅咒目标', needTarget: true },
  admirer_crush: { label: '选择暗恋对象', needTarget: true },
  wolf_kill: { label: '投票选择今晚的刀口', needTarget: true },
  seer_check: { label: '选择查验目标', needTarget: true },
  witch: { label: '使用药剂', special: 'witch' },
  sheriff_run: { label: '是否上警竞选警长', special: 'bool' },
  sheriff_vote: { label: '投票选出警长', needTarget: true },
  badge_pass: { label: '移交警徽或撕毁', needTarget: true },
  direction: { label: '决定今天发言方向', special: 'direction' },
  vote: { label: '投票放逐', needTarget: true },
  pk_vote: { label: 'PK 投票', needTarget: true },
  shoot: { label: '开枪带走一人', needTarget: true },
};

const PHASE_LABEL = {
  setup: '开局', night: '夜晚', dawn: '天亮', sheriff: '警长竞选',
  speech: '白天发言', vote: '放逐投票', pk: 'PK 环节', over: '结算',
};

function seatName(game, seat) {
  if (!seat) return '';
  const p = game.players.find((x) => x.seat === seat);
  return p ? `${seat}号 ${p.name}` : `${seat}号`;
}

/** 单条事件 → 一行中文 */
function renderEvent(game, e) {
  const d = e.data || {};
  switch (e.type) {
    case 'phase': return `—— ${d.title || ''} ——`;
    case 'night_step': return `🕯 ${d.label}（${d.index}/${d.total}）`;
    case 'system': return d.title ? `【${d.title}】${e.text}` : e.text;
    case 'deal': return `你的身份是：${ROLES[d.role].name}。${ROLES[d.role].description}`;
    case 'teammates': return `你的狼队队友：${(d.seats || []).map((s) => seatName(game, s)).join('、') || '（无其他存活狼人）'}`;
    case 'speech': {
      const tag = { wolf: '（狼队频道）', lastwords: '（遗言）', sheriff: '（警上竞选演讲）', pk: '（PK 发言）' }[d.context] || '';
      return `${seatName(game, e.actor)}${tag}：${d.text}`;
    }
    case 'sheriff_run': return d.run ? `${seatName(game, e.actor)} 决定上警竞选警长。` : `${seatName(game, e.actor)} 没有上警。`;
    case 'withdraw': return `${seatName(game, e.actor)} 宣布退水，退出警长竞选。`;
    case 'sheriff_elected': return `${seatName(game, e.actor)} 当选警长！警长在放逐投票中算 ${game.rules.sheriffVoteWeight} 票，每天决定发言方向并压轴发言。`;
    case 'sheriff_none': return '警长竞选结束：本局没有产生警长。';
    case 'badge_pass': return d.to ? `${seatName(game, e.actor)}（警长）将警徽移交给了 ${seatName(game, d.to)}。` : `${seatName(game, e.actor)}（警长）撕毁了警徽。`;
    case 'night_guard': return `你今晚守护了 ${d.target ? seatName(game, d.target) : '无人（空守）'}。`;
    case 'night_dream': return `你今晚摄梦了 ${seatName(game, d.target)}，他是当夜的梦游者${d.consecutive ? '。⚠️ 这是你连续第二晚摄梦此人：他今夜会死亡（女巫救不活）' : ''}。`;
    case 'wolfbeauty_charm': return `你今晚魅惑了 ${seatName(game, d.target)}。你出局时（骑士决斗除外）他将殉情出局。`;
    case 'crow_curse': return `你今晚诅咒了 ${seatName(game, d.target)}，明天的放逐投票中他会额外多 0.5 票。`;
    case 'admirer_crush': return `你暗恋上了 ${seatName(game, d.target)}。你的胜负阵营与他终身绑定（预言家查验你永远是好人）。`;
    case 'wolf_propose': return `${seatName(game, e.actor)}（狼队频道）：${d.text}`;
    case 'wolf_kill_vote': return `${seatName(game, e.actor)} 投刀：${d.target ? seatName(game, d.target) : '空刀'}`;
    case 'wolf_kill': return `狼队最终决定：今晚袭击 ${d.target ? seatName(game, d.target) : '无人（空刀）'}。`;
    case 'seer_check': return `你查验了 ${seatName(game, d.target)}：${d.isWolf ? '狼人' : '好人'}。`;
    case 'witch_info': return d.killTarget ? `今晚被狼人袭击的是 ${seatName(game, d.killTarget)}。` : '今晚是空刀，无人被袭击。';
    case 'witch_action': return `你的用药：${d.antidote ? `对 ${seatName(game, d.killTarget)} 使用了解药。` : '未使用解药。'}${d.poison ? `对 ${seatName(game, d.poison)} 使用了毒药。` : '未使用毒药。'}`;
    case 'deaths': {
      const names = (d.deaths || []).map((x) => `${seatName(game, x.seat)}（${causeLabel(x.cause)}）`).join('、');
      return names ? `天亮了。昨夜死亡：${names}。` : '天亮了。昨夜是平安夜，无人死亡。';
    }
    case 'vote_cast': return `你投给了 ${d.target ? seatName(game, d.target) : '弃票'}。`;
    case 'vote_reveal': {
      const detail = (d.votes || []).map((v) => `${v.seat}号→${v.target ? v.target + '号' : '弃票'}${v.weight !== 1 ? `(×${v.weight})` : ''}`).join('，');
      const tally = Object.entries(d.tally || {}).map(([s, n]) => `${s === '0' ? '弃票' : s + '号'}:${n}票`).join('，');
      const curse = d.curseBonus && Object.keys(d.curseBonus).length
        ? `（${Object.keys(d.curseBonus).map((s) => s + '号').join('、')}受乌鸦诅咒各+0.5票）` : '';
      return `亮票结果：${detail}。${tally ? `票数统计${curse}：${tally}。` : ''}`;
    }
    case 'role_reveal': return `${seatName(game, d.seat)} 的身份是：${ROLES[d.role].name}。`;
    case 'idiot_save': return `${seatName(game, d.seat)} 是白痴，翻牌免疫本次放逐，之后可以发言但不再有投票权。`;
    case 'shoot': return d.target ? `${seatName(game, e.actor)} 开枪带走了 ${seatName(game, d.target)}！` : `${seatName(game, e.actor)} 没有开枪。`;
    case 'explode': return d.target ? `${seatName(game, e.actor)} 自爆（狼人），并带走了 ${seatName(game, d.target)}！` : `${seatName(game, e.actor)} 自爆（狼人），天黑了！`;
    case 'direction': return `${seatName(game, d.by)}（警长）决定今天从 ${seatName(game, d.startSeat)} 开始、${d.direction === 'cw' ? '顺时针' : '逆时针'}方向依次发言。`;
    case 'game_over': return `游戏结束：${d.winner === 'good' ? '好人阵营' : '狼人阵营'}获胜！${d.reason || ''}`;
    default: return e.text || '';
  }
}

function causeLabel(cause) {
  return {
    wolf_kill: '被狼人袭击', poison: '被毒杀', vote_out: '被投票放逐',
    shot: '被开枪带走', explode_self: '自爆', explode_target: '被自爆带走',
    duel_win: '被骑士决斗出局', duel_fail: '决斗失败以死谢罪',
    dream: '被连续摄梦而亡', dream_follow: '因摄梦人出局连带出局', charm_follow: '殉情出局',
  }[cause] || cause;
}

/** 事件流 → AI 阅读文本（按天/阶段分组） */
function renderEventsForAI(game, events) {
  const lines = [];
  let lastHeader = '';
  for (const e of events) {
    if (e.type === 'await_input' || e.type === 'ai_thinking') continue;
    const header = `第${e.day || 0}天·${PHASE_LABEL[e.phase] || e.phase}`;
    if (header !== lastHeader) { lines.push(`【${header}】`); lastHeader = header; }
    const line = renderEvent(game, e);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { TASK_META, PHASE_LABEL, renderEvent, renderEventsForAI, seatName, causeLabel };
