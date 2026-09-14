/**
 * export-game.js — 导出对局复盘记录（上帝视角全事件）为 Markdown
 * 用法：node scripts/export-game.js <gameId|latest> [输出目录=D:/狼人杀复盘]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROLES, BOARDS } = require('../src/engine/roles');

const arg = process.argv[2] || 'latest';
const outDir = process.argv[3] || 'D:/狼人杀复盘';

const SAVE_DIR = path.join(__dirname, '..', 'saves');
function loadSave(id) {
  const files = fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith('.json'));
  if (id === 'latest') {
    files.sort((a, b) => fs.statSync(path.join(SAVE_DIR, b)).mtimeMs - fs.statSync(path.join(SAVE_DIR, a)).mtimeMs);
    return { id: files[0].replace('.json', ''), json: JSON.parse(fs.readFileSync(path.join(SAVE_DIR, files[0]), 'utf8')) };
  }
  const f = files.find((x) => x.startsWith(id));
  if (!f) throw new Error('找不到对局 ' + id);
  return { id, json: JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), 'utf8')) };
}

const CAUSE = { wolf_kill: '夜刀', poison: '毒杀', vote_out: '放逐', shot: '枪杀', explode_target: '自爆带走', explode_self: '自爆', duel_win: '决斗', duel_fail: '决斗失败' };

function render(json) {
  const g = json.game;
  const name = (s) => { const p = g.players.find((x) => x.seat === s); return p ? `${s}号 ${p.name}` : `${s}号`; };
  const L = [];
  const line = (t) => L.push(t);
  const banner = (t) => { L.push('', '## ' + t, ''); };

  // 头部
  const boardName = BOARDS[Object.keys(BOARDS).find((k) => JSON.stringify(BOARDS[k].roles) === JSON.stringify(g.board))]?.name || '自定义板子';
  line(`# 狼人杀复盘 · ${g.id}`);
  line('');
  line(`- **板子**：${boardName}`);
  line(`- **结果**：${g.finished ? (g.winner === 'none' ? '平局/终止 — ' + (g.winReason || '') : (g.winner === 'good' ? '🎉 好人阵营获胜' : '🐺 狼人阵营获胜') + ' — ' + (g.winReason || '')) : '未结束'}`);
  line(`- **天数**：共 ${g.day} 天 | **AI 调用**：${(g.llmStats && g.llmStats.calls) || 0} 次，输入 ${(g.llmStats && g.llmStats.promptTokens) || 0} tokens（缓存 ${(g.llmStats && g.llmStats.cachedTokens) || 0}），输出 ${(g.llmStats && g.llmStats.completionTokens) || 0}`);
  line('');

  // 死因映射（预扫描）：夜刀/毒/枪/自爆/决斗
  const causeMap = {};
  let lastDuelActor = 0;
  for (const e of g.events) {
    const d = e.data || {};
    if (e.type === 'deaths') for (const x of d.deaths || []) causeMap[x.seat] = x.cause;
    else if (e.type === 'shot' && d.target) causeMap[d.target] = 'shot';
    else if (e.type === 'explode' && d.target) causeMap[d.target] = 'explode_target';
    else if (e.type === 'duel') lastDuelActor = e.actor;
    else if (e.type === 'system' && e.text) {
      const win = e.text.match(/决斗成功：(\d+)号/);
      if (win) causeMap[Number(win[1])] = 'duel_win';
      else if (/决斗失败/.test(e.text) && lastDuelActor) causeMap[lastDuelActor] = 'duel_fail';
    }
  }

  // 座位与身份
  banner('座位与身份');
  line('| 座位 | 昵称 | 身份 | 性格 | 结局 |');
  line('| --- | --- | --- | --- | --- |');
  for (const p of g.players) {
    const r = ROLES[p.role] || {};
    const end = p.alive ? '存活' : `出局（${causeMap[p.seat] ? CAUSE[causeMap[p.seat]] || causeMap[p.seat] : '被放逐'}）`;
    line(`| ${p.seat} | ${p.name}${p.isHuman ? '（你）' : ''} | ${r.emoji || ''} ${r.name || '?'}${p.isSheriff ? ' 👑警长' : ''} | ${p.personaName || '—'} | ${end} |`);
  }

  // 时间线
  banner('对局时间线（上帝视角）');
  let lastPhase = '';
  for (const e of g.events) {
    const d = e.data || {};
    const priv = Array.isArray(e.visibleTo) ? ' 🔒' : '';
    const who = (s) => name(s);
    if (e.type === 'phase' && d.title !== lastPhase) { lastPhase = d.title || ''; line(''); line(`### ${lastPhase}`); line(''); continue; }
    switch (e.type) {
      case 'night_step': break; // 播报节奏，复盘可省
      case 'system': if (e.text) line(`- ℹ️ ${e.text}`); break;
      case 'deal': line(`- 🎴 ${who(e.actor)} 领取身份 **${(ROLES[d.role] || {}).name}**`); break;
      case 'teammates': line(`- 🐺 ${who(e.actor)} 获知队友：${(d.seats || []).join('、')}号`); break;
      case 'night_guard': line(`- 🛡️${priv} ${who(e.actor)} 守护 ${d.target ? who(d.target) : '空守'}`); break;
      case 'wolf_propose': line(`- 🗣️🔒 ${who(e.actor)}：${d.text}`); break;
      case 'wolf_chat': line(`- 💬🔒 ${who(e.actor)}：${d.text}（建议刀 ${d.target || '空刀'}）`); break;
      case 'wolf_kill_vote': line(`- 🗳️🔒 ${who(e.actor)} 刀口票 → ${d.target ? who(d.target) : '空刀'}`); break;
      case 'wolf_kill': line(`- 🔪🔒 今晚刀口：${d.target ? who(d.target) : '空刀'}`); break;
      case 'wolf_say': if (d.text && !d.skipped) line(`- 🗨️🔒 ${who(e.actor)}：${d.text}`); break;
      case 'seer_check': line(`- 🔮${priv} ${who(e.actor)} 查验 ${who(d.target)} → **${d.isWolf ? '狼人' : '好人'}**`); break;
      case 'witch_info': line(`- ⚗️${priv} ${who(e.actor)}（女巫）今晚被袭的是 ${d.killTarget ? who(d.killTarget) : '无人'}`); break;
      case 'witch_action': line(`- ⚗️${priv} ${who(e.actor)} 用药：${d.antidote ? '解药' : '不用解药'}${d.poison ? '；毒 ' + who(d.poison) : ''}`); break;
      case 'deaths': {
        const ds = d.deaths || [];
        line(ds.length ? `- 🌅 天亮，昨夜死亡：${ds.map((x) => `${who(x.seat)}（${CAUSE[x.cause] || x.cause}）`).join('、')}` : '- 🌅 天亮，平安夜');
        break;
      }
      case 'role_reveal': line(`- 📢 ${who(d.seat)} 翻牌：**${(ROLES[d.role] || {}).name}**`); break;
      case 'speech': {
        const tag = { wolf: '🐺狼聊', lastwords: '🕯遗言', sheriff: '🎩警上', pk: '⚔️PK', day: '💬发言' }[d.context] || '';
        line(`- ${priv ? '🔒' : ''} **${who(e.actor)}**〔${tag}〕：${d.text}`);
        break;
      }
      case 'sheriff_run': if (d.run) line(`- 🎩 ${who(e.actor)} 上警`); break;
      case 'withdraw': line(`- 🎩 ${who(e.actor)} 退水`); break;
      case 'sheriff_elected': line(`- 👑 ${who(d.seat)} 当选警长`); break;
      case 'sheriff_none': line(`- 👑 本局没有警长`); break;
      case 'direction': line(`- 🧭 警长决定从 ${d.startSeat}号 开始${d.direction === 'cw' ? '顺' : '逆'}时针发言`); break;
      case 'vote_cast': line(`- 🗳️${priv} ${who(e.actor)} 投给 ${d.target ? who(d.target) : '弃票'}`); break;
      case 'vote_reveal': {
        const detail = (d.votes || []).map((v) => `${v.seat}→${v.target || '弃'}${v.weight !== 1 ? '×' + v.weight : ''}`).join('，');
        const tally = Object.entries(d.tally || {}).map(([k, n]) => `${k === '0' ? '弃' : k + '号'}:${n}票`).join('，');
        line(`- 🗳️ **亮票**：${detail}`);
        line(`  - 票型：${tally}`);
        break;
      }
      case 'shot': line(`- 🔫 ${who(e.actor)} 开枪带走 ${d.target ? who(d.target) : '无（放弃）'}`); break;
      case 'explode': line(`- 💥 ${who(e.actor)} 自爆${d.target ? ` 带走 ${who(d.target)}` : ''}`); break;
      case 'duel': line(`- ⚔️ ${who(e.actor)}（骑士）翻牌决斗 ${who(d.target)}`); break;
      case 'idiot_save': line(`- 🃏 ${who(d.seat)} 白痴翻牌免疫放逐`); break;
      case 'llm_error': break;
      case 'game_over': line(`- 🏁 **${d.winner === 'none' ? (d.reason || '对局终止') : d.winner === 'good' ? '好人阵营获胜 — ' + (d.reason || '') : '狼人阵营获胜 — ' + (d.reason || '')}**`); break;
      default: break; // ai_thinking 等调试事件跳过
    }
  }

  return L.join('\n');
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const ids = arg === 'latest' ? ['latest'] : [arg];
  if (arg === 'all') {
    const files = fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const id = f.replace('.json', '');
      try { exportOne(id, outDir); } catch (e) { console.error(id, '失败:', e.message); }
    }
  } else {
    for (const id of ids) exportOne(id, outDir);
  }
  console.log('完成 →', outDir);
}
function exportOne(id, outDir) {
  const { id: gid, json } = loadSave(id);
  const md = render(json);
  const winner = json.game.winner === 'good' ? '好人胜' : json.game.winner === 'wolf' ? '狼人胜' : '终止';
  const file = path.join(outDir, `${gid}-${winner}.md`);
  fs.writeFileSync(file, md);
  console.log('已导出:', file, `（${md.length} 字符）`);
}
main();
