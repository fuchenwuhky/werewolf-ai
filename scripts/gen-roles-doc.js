/**
 * gen-roles-doc.js — 从 src/engine/roles.js 生成 docs/roles.md（单一数据源，避免两处手写不一致）
 * 用法：node scripts/gen-roles-doc.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROLES, BOARDS } = require('../src/engine/roles');

const lines = [];
lines.push('# 角色图鉴（由 roles.js 自动生成，请勿手改）');
lines.push('');
lines.push('> 生成命令：`npm run gen-docs`。角色技能描述与 `src/engine/roles.js` 完全一致，');
lines.push('> 同时也是 AI 提示词与游戏内角色图鉴的数据源。');
lines.push('');
lines.push('| 角色 | 阵营 | 类别 | 技能（官方口径） |');
lines.push('|---|---|---|---|');
for (const r of Object.values(ROLES)) {
  const team = r.team === 'wolf' ? '狼人阵营' : '好人阵营';
  const cat = { wolf: '狼', god: '神职', villager: '平民' }[r.category];
  lines.push(`| ${r.emoji} ${r.name} | ${team} | ${cat} | ${r.short} |`);
}
lines.push('');
lines.push('## 完整描述');
lines.push('');
for (const r of Object.values(ROLES)) {
  lines.push(`### ${r.emoji} ${r.name}（${{ wolf: '狼人阵营', god: '神职', villager: '平民' }[r.category]}）`);
  lines.push('');
  lines.push(r.description);
  lines.push('');
}
lines.push('## 内置板子模板');
lines.push('');
lines.push('| 模板 | 牌型 |');
lines.push('|---|---|');
for (const b of Object.values(BOARDS)) {
  const roles = Object.entries(b.roles).map(([r, n]) => `${ROLES[r].name}×${n}`).join(' + ');
  lines.push(`| ${b.name} | ${roles} |`);
}
lines.push('');

const out = path.join(__dirname, '..', 'docs', 'roles.md');
fs.writeFileSync(out, lines.join('\n'));
console.log(`已生成 ${out}`);
