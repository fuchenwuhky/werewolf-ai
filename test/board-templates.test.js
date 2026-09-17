/**
 * 板子模板的自洽性：名字里写的人数必须等于 roles 的实际人数。
 *
 * 为什么要有这条（P3，用户实测发现）：`quick10` 名叫「10人速推局」，实际配的是
 * 3狼+预女猎+3民 = **9 人** —— 标签与人数不符，玩家按名字选板子时会被误导。
 * 这类错误不会报错，只会让"10 人局"变成 9 人局，所以用一条通用规则钉住：
 * 名字以数字开头的模板，其 roles 求和必须等于该数字（文档 docs/roles.md、docs/rules.md 同步）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BOARDS } = require('../src/engine/roles');

test('板子模板：名字里的人数与 roles 实际人数一致', () => {
  const checked = [];
  for (const [id, b] of Object.entries(BOARDS)) {
    const m = /^(\d+)\s*人/.exec(b.name || '');
    if (!m) continue; // 名字没写人数的模板不在本规则范围内
    const declared = Number(m[1]);
    const actual = Object.values(b.roles).reduce((a, n) => a + n, 0);
    checked.push(`${id}(${declared}=${actual})`);
    assert.strictEqual(actual, declared,
      `板子 ${id}「${b.name}」名字写 ${declared} 人，实际配了 ${actual} 人（roles=${JSON.stringify(b.roles)}）`);
  }
  assert.ok(checked.length >= 5, `应至少校验 5 个模板，实际 ${checked.length}：${checked.join(' ')}`);
});

test('板子模板：文档里的人数与代码一致（docs/roles.md、docs/rules.md）', () => {
  const rolesDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'roles.md'), 'utf8');
  const rulesDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'rules.md'), 'utf8');
  const b = BOARDS.quick10;
  const actual = Object.values(b.roles).reduce((a, n) => a + n, 0);
  assert.strictEqual(actual, 10, 'quick10 必须是 10 人');
  // docs/roles.md：狼人×3 + 预言家×1 + 女巫×1 + 猎人×1 + 平民×N
  const m = /10人速推局 \| 狼人×3 \+ 预言家×1 \+ 女巫×1 \+ 猎人×1 \+ 平民×(\d+)/.exec(rolesDoc);
  assert.ok(m, 'docs/roles.md 应有 10人速推局 一行');
  assert.strictEqual(Number(m[1]), b.roles.villager, 'docs/roles.md 的平民数必须与代码一致');
  const r = /10 人速推局 \| 狼×3 \+ 预女猎 \+ 民×(\d+)/.exec(rulesDoc);
  assert.ok(r, 'docs/rules.md 应有 10 人速推局 一行');
  assert.strictEqual(Number(r[1]), b.roles.villager, 'docs/rules.md 的民数必须与代码一致');
});
