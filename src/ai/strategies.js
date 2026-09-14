/**
 * strategies.js — 职业策略模版库
 * 依据官方/高阶主流打法整理，每个职业若干模版，全部常驻注入 system 提示词
 * （放在个性化段，供 AI 参考；可灵活应变，不必照搬）。
 * 每条只做简短介绍 + 关键要点，不写长篇原理。
 */
'use strict';

const STRATEGY_TEMPLATES = {
  wolf: [
    { id: 'wolf-hantiao', name: '悍跳狼', text: '警上悍跳预言家：报假查验（队友发金水、真预言家发查杀）、留警徽流、讲心路历程；每天续报新查验保持人设。' },
    { id: 'wolf-chongfeng', name: '冲锋狼', text: '站边悍跳队友坚定带节奏，攻击真预言家的逻辑破绽，煽动好人把票投向神职嫌疑。' },
    { id: 'wolf-shenshui', name: '深水狼', text: '全程低调表好，少发言、随大流投票，不惹注意；等好人互咬后再收渔利。' },
    { id: 'wolf-daogou', name: '倒钩狼', text: '发言站边真预言家深潜，必要时轻踩队友填狼坑，骗取信任后后期翻边。' },
    { id: 'wolf-haorenbang', name: '好人榜流', text: '可抛出好人榜：名单里好人与队友数量参半（相差≤1），队友放中段；只报名单，不解释推导。' },
  ],
  wolfking: [
    { id: 'wk-hantiao', name: '悍跳狼', text: '警上悍跳预言家：假查验+警徽流+心路历程；记住被放逐时可开枪，带走威胁最大的好人。' },
    { id: 'wk-chongfeng', name: '冲锋狼', text: '站边悍跳队友煽动带节奏；被放逐出局时可开枪，敢站前排换输出。' },
    { id: 'wk-shenshui', name: '深水狼', text: '低调藏身份随大流投票；若被冤枉放逐，开枪带走最像神职的人。' },
  ],
  whitewolfking: [
    { id: 'wwk-bibao', name: '憋爆流', text: '深潜到关键神职暴露或好人将胜时，发言后自爆带走女巫/预言家，一击定胜负。' },
    { id: 'wwk-shenshui', name: '深水流', text: '全程低调混好人伺机而动；自爆权是你的底牌，不要轻易交出。' },
    { id: 'wwk-hantiao', name: '悍跳流', text: '悍跳预言家抢警徽控节奏；局势不利时自爆带走关键神职翻盘。' },
  ],
  seer: [
    { id: 'seer-shangjing', name: '上警警徽流', text: '首日上警跳预言家：报查验、留警徽流（如"我警徽给X号"）、讲验人逻辑，抢警徽带队。' },
    { id: 'seer-qiangyan', name: '强验流', text: '夜里优先验发言强势、站边可疑的牌，不把查验浪费在必然的好人身上。' },
    { id: 'seer-houzhi', name: '后置起跳流', text: '前置位有悍跳对跳时沉住气，后置位再起跳对拼，用更完整的信息取信好人。' },
  ],
  witch: [
    { id: 'witch-shouye', name: '灵活用药流', text: '首夜可救可不救：救则保下核心，不救则留药防后期自刀与关键刀；毒药中后期只毒最确定的狼。' },
    { id: 'witch-jinshen', name: '谨慎毒药流', text: '毒药宁缺毋滥，防盲毒（毒错神职基本输）；信息不足时不用药过夜。' },
    { id: 'witch-qitiao', name: '起跳带队流', text: '预言家死后及时跳女巫报信息（昨夜刀口、该验谁），接过硬正派大旗。' },
  ],
  hunter: [
    { id: 'hunter-shenshui', name: '深水藏枪流', text: '全程不跳身份防被毒；把开枪权留到被刀或被放逐时带走最像狼的人。' },
    { id: 'hunter-tiaoshen', name: '跳猎人震慑流', text: '时机成熟可跳猎人身份震慑狼队（狼怕枪，不敢乱刀你）。' },
    { id: 'hunter-guoduan', name: '果断开枪流', text: '触发开枪不犹豫，按票型与发言带走最像狼的一张牌。' },
  ],
  guard: [
    { id: 'guard-shoushen', name: '守神流', text: '优先守跳出来的预言家/女巫等神职；女巫解药未用时防同守同救奶穿。' },
    { id: 'guard-zishou', name: '自守循环流', text: '首夜可自守，之后在外置位与神职间轮换守护，注意不可连守，用换位骗刀求平安夜。' },
  ],
  knight: [
    { id: 'k-zhencha', name: '侦查决斗流', text: '深潜观察票型与发言矛盾，高度确信某张狼牌后翻牌决斗带走；决斗错好人等于白送骑士，务必确认再动手。' },
    { id: 'k-weishe', name: '威慑流', text: '关键局跳骑士身份威慑：狼队不敢轻易悍跳自爆，好人视线更清晰；威慑本身就是信息。' },
    { id: 'k-shenshui', name: '深水流', text: '全程像平民一样发言，把决斗权留到残局一锤定音，避免前期误判错杀好人。' },
  ],
  idiot: [
    { id: 'idiot-dibiao', name: '低调表水流', text: '平时像普通平民一样发言表好；被放逐翻牌免死后失去投票权，前期尽量别被推出局。' },
    { id: 'idiot-kangtui', name: '扛推翻牌流', text: '不怕被推：翻牌自证后狼人火力转向他人，为好人多挡一轮伤害。' },
  ],
  villager: [
    { id: 'v-luoji', name: '逻辑站边流', text: '认真听发言盘逻辑，坚定站边可信的预言家，用票型帮好人找狼。' },
    { id: 'v-dangdao', name: '挡刀流', text: '关键时刻可勇敢跳神职挡刀（如自称女巫），骗狼人刀口保护真神。' },
    { id: 'v-zhatiao', name: '诈跳预言家流', text: '无人跳预言家或真预言家已死时，可假跳预言家骗狼刀：报一个"查验"（给可信好人发金水）、留警徽流；场上已有人跳预言家就不要抢跳搅局。' },
    { id: 'v-biaoshui', name: '表水扛推流', text: '被怀疑时不慌，条理清晰地表水自证，做一张"推不动"的平民牌。' },
  ],
};

/** 某角色的全部模版格式化成一个提示词段落 */
function strategyBlockFor(roleId) {
  const list = STRATEGY_TEMPLATES[roleId];
  if (!list || !list.length) return '';
  return list.map((t) => `【${t.name}】${t.text}`).join('\n');
}

module.exports = { STRATEGY_TEMPLATES, strategyBlockFor };
