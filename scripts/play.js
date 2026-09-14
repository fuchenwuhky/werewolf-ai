#!/usr/bin/env node
/**
 * play.js — 代玩调试助手（开发工具）
 * 用法：
 *   node scripts/play.js new              创建并开局（白狼王骑士场，1号位人类）
 *   node scripts/play.js st [after]       拉取增量事件（写入 .play-log.md）并显示当前状态
 *   node scripts/play.js act '<json>'     提交人类操作，如 act '{"task":"speech","text":"..."}'（实际只需业务字段）
 *   node scripts/play.js duel <seat>      骑士决斗
 *   node scripts/play.js explode [seat]   自爆（白狼王带 seat）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, '..', '.play-state.json');
const LOG = path.join(__dirname, '..', '.play-log.md');
const BASE = 'http://127.0.0.1:3210';

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
  return d;
}
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
function appendLog(lines) {
  if (lines.length) fs.appendFileSync(LOG, lines.join('\n') + '\n');
}

const cmd = process.argv[2];
(async () => {
  if (cmd === 'new') {
    const meta = await api('GET', '/api/meta');
    const names = [...(meta.names || [])].sort(() => Math.random() - 0.5);
    const players = [{ name: '我', isHuman: true }];
    for (let i = 0; i < 11; i++) players.push({ name: names[i], isHuman: false });
    const created = await api('POST', '/api/games', { boardId: 'wwknight12', rules: meta.defaultRules, players, mock: false });
    await api('POST', `/api/games/${created.gameId}/start`, { token: created.godToken });
    save({ ...created, after: 0 });
    fs.writeFileSync(LOG, `# 代玩记录 · ${created.gameId}（白狼王骑士场，我是1号）\n`);
    console.log('✓ 已开局', created.gameId);
    return;
  }
  const s = load();
  if (cmd === 'st') {
    const v = await api('GET', `/api/games/${s.gameId}/view?token=${s.playerToken}&after=${s.after || 0}`);
    const lines = [];
    for (const e of v.events) {
      lines.push(`- d${e.day}/${e.phase} ${e.type}: ${(e.text || JSON.stringify(e.data || {})).slice(0, 160)}`);
    }
    appendLog(lines);
    s.after = Math.max(s.after || 0, ...v.events.map((e) => e.seq), 0);
    save(s);
    const alive = v.players.filter((p) => p.alive).map((p) => p.seat);
    const me = v.me || {};
    console.log(`== 第${v.day}天 ${v.phase} | 我:${me.role || '?'} ${me.alive ? '存活' : '出局'} | 存活:${alive.join(',')} | finished:${v.finished}`);
    if (v.pending) {
      console.log(`>> 待操作 task=${v.pending.task} candidates=${JSON.stringify(v.pending.candidates || [])} extra=${JSON.stringify(v.pending.extra || {})} allowNone=${!!v.pending.allowNone} canExplode=${!!v.pending.canExplode}`);
    } else console.log('>> 无待操作（等待AI）');
    const recent = lines.slice(-8);
    console.log(recent.join('\n'));
    return;
  }
  if (cmd === 'act') {
    const payload = JSON.parse(process.argv[3]);
    const r = await api('POST', `/api/games/${s.gameId}/action`, { token: s.playerToken, payload });
    console.log('✓', JSON.stringify(r));
    appendLog([`- 🙋 我提交操作: ${JSON.stringify(payload)}`]);
    return;
  }
  if (cmd === 'duel' || cmd === 'explode') {
    const target = Number(process.argv[3] || 0);
    const body = { token: s.playerToken, target };
    const r = await api('POST', `/api/games/${s.gameId}/${cmd === 'duel' ? 'duel' : 'explode'}`, body);
    console.log('✓', JSON.stringify(r));
    appendLog([`- 🙋 我发起 ${cmd}${target ? ' → ' + target + '号' : ''}`]);
    return;
  }
  console.log('未知命令');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
