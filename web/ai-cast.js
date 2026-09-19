/**
 * AI 玩家肖像名册。浏览器与 Node 共用；只含公开外观，不含游戏身份。
 * 头像分配仅依赖昵称、座位和是否为人类，不能读取 role / 阵营 / 存活状态。
 */
(function (root, factory) {
  'use strict';
  const cast = factory();
  if (typeof module === 'object' && module.exports) module.exports = cast;
  else root.AICast = cast;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PORTRAITS = [
    { id: 'hawk', name: '赤绒', aliases: ['烬羽', '红茶未凉', '锋芒藏袖'], persona: 'hawk', caption: '敢先落子，也肯认错' },
    { id: 'turtle', name: '墨泊', aliases: ['深巷慢雨', '松烟客', '半盏静水'], persona: 'turtle', caption: '多听一轮，再下判断' },
    { id: 'detective', name: '雾尺', aliases: ['旧案第七页', '灰帽来客', '线索在场'], persona: 'detective', caption: '沿着票型，寻找矛盾' },
    { id: 'trickster', name: '绯铃', aliases: ['纸牌不睡', '笑里留问', '转角戏法'], persona: 'trickster', caption: '玩笑轻落，试探很准' },
    { id: 'softie', name: '温烛', aliases: ['晚灯留座', '毛衣口袋', '半糖长夜'], persona: 'softie', caption: '语气温柔，立场清楚' },
    { id: 'snarky', name: '黛棘', aliases: ['缎面冷笑', '黑茶加冰', '礼貌带刺'], persona: 'snarky', caption: '话有棱角，判断有据' },
    { id: 'dramallama', name: '幕间', aliases: ['谢幕之前', '绒幕独白', '一折夜曲'], persona: 'dramallama', caption: '表达有戏，推理落地' },
    { id: 'enigma', name: '空弦', aliases: ['无声落款', '留白三秒', '月下省略号'], persona: 'enigma', caption: '留一点静，讲清证据' },
    { id: 'grumpy', name: '铁杉', aliases: ['冷炉余温', '直话直说', '硬面包先生'], persona: 'grumpy', caption: '不绕弯子，不靠喊赢' },
    { id: 'scholar', name: '砚冬', aliases: ['书脊微光', '术语校对员', '墨水将干'], persona: 'scholar', caption: '规则为尺，逐句校验' },
    { id: 'peacemaker', name: '和弦', aliases: ['圆桌留席', '慢声定调', '风停再议'], persona: 'peacemaker', caption: '先把话听完，再归票' },
    { id: 'shadow', name: '默川', aliases: ['低声过桥', '寂静来信', '最后半句'], persona: 'shadow', caption: '惜字如金，一句到点' },
    { id: 'rookie', name: '拾星', aliases: ['新页折角', '问题收藏家', '还在记笔记'], persona: 'rookie', caption: '敢问为什么，也敢表态' },
    { id: 'veteran', name: '旧棋', aliases: ['茶馆末席', '熟局生客', '第十把椅子'], persona: 'veteran', caption: '经验作参考，不作证据' },
    { id: 'archivist', name: '绢页', aliases: ['票型记事簿', '时间线拾遗', '折页备忘录'], persona: 'archivist', caption: '把每次改口放回时间线' },
    { id: 'skeptic', name: '折镜', aliases: ['再问一个为何', '反例收藏室', '证据待补'], persona: 'skeptic', caption: '替热门结论找反例' },
    { id: 'diplomat', name: '绛笺', aliases: ['红封来信', '长桌中间人', '杯沿共识'], persona: 'diplomat', caption: '求得共识，不抹平分歧' },
    { id: 'minimalist', name: '霜句', aliases: ['三句定论', '言简有据', '句号先到'], persona: 'minimalist', caption: '一个结论，一条依据' },
    { id: 'counterfactual', name: '岔路', aliases: ['假设另一边', '逆向脚印', '如果再推一步'], persona: 'counterfactual', caption: '换一个假设，再验一次' },
    { id: 'cartographer', name: '经纬', aliases: ['连线未闭合', '同票不同路', '关系图边角'], persona: 'cartographer', caption: '看清连线，不急着组队' },
    { id: 'auditor', name: '铜筹', aliases: ['票数守恒', '算盘未合', '差一票的夜'], persona: 'auditor', caption: '先算清票，再谈局势' },
    { id: 'listener', name: '回音', aliases: ['听见后半句', '余音笔记', '请把话说完'], persona: 'listener', caption: '听清原意，再指出偏差' },
    { id: 'improviser', name: '雀斑', aliases: ['临场小转弯', '雨靴轻响', '灵光不保真'], persona: 'improviser', caption: '直觉起步，证据收尾' },
    { id: 'closer', name: '终章', aliases: ['末席定音', '收束长夜', '落票之前'], persona: 'closer', caption: '收拢分歧，给出选择' },
  ].map((p) => Object.freeze({ ...p, aliases: Object.freeze(p.aliases), src: '/assets/avatars/' + p.id + '.png' }));
  const byName = new Map();
  for (const p of PORTRAITS) for (const n of [p.name, ...p.aliases]) byName.set(n, p);
  const NAMES = Object.freeze([...byName.keys()]);

  function profileForName(name) { return byName.get(String(name || '').trim()) || null; }
  function hash(text) {
    let value = 2166136261;
    for (const ch of String(text)) { value ^= ch.codePointAt(0); value = Math.imul(value, 16777619); }
    return value >>> 0;
  }

  /** 优先保留名册昵称的专属肖像；撞图时顺延，24 个 AI 以内不重复。 */
  function assignPortraits(players) {
    const ai = (players || []).filter((p) => !p.isHuman).slice().sort((a, b) => Number(a.seat) - Number(b.seat));
    const assigned = new Map();
    const used = new Set();
    // 先给具名人物保留肖像，避免普通昵称的哈希碰巧占了其专属图。
    for (const p of ai) {
      const profile = profileForName(p.name);
      if (profile && !used.has(profile.id)) { assigned.set(p.seat, profile); used.add(profile.id); }
    }
    for (const p of ai) {
      if (assigned.has(p.seat)) continue;
      const start = hash(String(p.name || '') + ':' + p.seat) % PORTRAITS.length;
      let chosen = PORTRAITS[start];
      for (let offset = 0; offset < PORTRAITS.length; offset++) {
        const candidate = PORTRAITS[(start + offset) % PORTRAITS.length];
        if (!used.has(candidate.id)) { chosen = candidate; break; }
      }
      assigned.set(p.seat, chosen); used.add(chosen.id);
    }
    return assigned;
  }

  /** 装饰头像，不吞掉座位号、徽记或点击事件。图片失败时保留原有数字。 */
  function decorate(element, profile) {
    if (!element || !profile) return;
    const doc = element.ownerDocument;
    const image = doc.createElement('img');
    image.className = 'ai-portrait';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.decoding = 'async';
    image.draggable = false;
    image.addEventListener('load', () => element.classList.add('portrait-ready'));
    image.addEventListener('error', () => { element.classList.remove('portrait-ready'); image.remove(); });
    element.classList.add('has-ai-portrait');
    element.dataset.portrait = profile.id;
    element.prepend(image);
    image.src = profile.src;
  }

  return Object.freeze({ PORTRAITS: Object.freeze(PORTRAITS), NAMES, profileForName, assignPortraits, decorate });
});
