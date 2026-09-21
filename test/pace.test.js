/**
 * pace.test.js — 节奏档位（P2-6）
 *
 * 这个功能的全部价值在于"用户按一下就知道自己选了什么"，所以测试盯的是三件事：
 *  ① 档位表不能悄悄漂移：standard 必须恒等于出厂默认（否则"标准局"会变成另一种默认）
 *  ② 档位必须真的按"省钱程度"有序（快 < 标准 < 深），否则档位名就是骗人的
 *  ③ 展开档位时不得覆盖用户显式指定的单项（这正是 keepAlive 那次"值被静默改回"的同类坑）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_CONFIG, PACES, PACE_KEYS, applyPace, detectPace, migrateConfig, createConfig } = require('../src/config');
const { cleanupAfter } = require('./helpers-tmpdir');

const tmpFile = (t) => path.join(cleanupAfter(t, fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pace-'))), 'config.json');

test('节奏档位：standard 必须恒等于出厂默认（否则"标准局"不再是"什么都不改"）', () => {
  const diff = PACE_KEYS.filter((k) => PACES.standard.values[k] !== DEFAULT_CONFIG[k]);
  assert.deepStrictEqual(diff, [], `标准档与默认值不一致的键：${diff.join(', ')}`);
  assert.strictEqual(detectPace(DEFAULT_CONFIG), 'standard');
});

test('节奏档位：快 < 标准 < 深，必须真的按省钱程度有序（否则档位名骗人）', () => {
  const cost = (id) => ({
    // 越大越省
    minEvents: PACES[id].values.digestMinEvents,
    // 越小越省
    keep: PACES[id].values.digestKeep,
    budget: PACES[id].values.contextBudget,
  });
  const f = cost('fast'); const s = cost('standard'); const d = cost('deep');
  assert.ok(f.minEvents >= s.minEvents && s.minEvents >= d.minEvents, '反思阈值：快档应更容易跳过反思');
  assert.ok(f.keep <= s.keep && s.keep <= d.keep, '纪要保留：快档应保留更少');
  assert.ok(f.budget <= s.budget && s.budget <= d.budget, '上下文预算：快档应更小');
  assert.ok(f.budget < d.budget, '快档与深档必须真的不同，否则档位没有意义');
});

test('节奏档位：展开档位不得覆盖显式指定的单项（防止"手工微调被静默改回"）', () => {
  const data = { ...DEFAULT_CONFIG };
  applyPace(data, 'fast', new Set(['contextBudget']));
  assert.strictEqual(data.contextBudget, DEFAULT_CONFIG.contextBudget, '显式指定的 contextBudget 必须保留');
  assert.strictEqual(data.digestKeep, PACES.fast.values.digestKeep, '未指定的项应按档位展开');
  assert.strictEqual(detectPace(data), 'custom', '混合状态必须如实报告为"自定义"');
});

test('节奏档位：非法档位名一律不生效（绝不写坏配置）', () => {
  const data = { ...DEFAULT_CONFIG };
  assert.strictEqual(applyPace(data, 'fastest'), false);
  assert.strictEqual(applyPace(data, 'custom'), false, "前端的 'custom' 不是档位，必须原样不生效");
  assert.strictEqual(applyPace(data, ''), false);
  assert.deepStrictEqual(data, DEFAULT_CONFIG, '配置不得被改动');
});

test('节奏档位：detectPace 只在完全一致时报档位名，否则一律 custom', () => {
  for (const id of Object.keys(PACES)) {
    assert.strictEqual(detectPace({ ...DEFAULT_CONFIG, ...PACES[id].values }), id);
  }
  const almost = { ...DEFAULT_CONFIG, ...PACES.fast.values, contextBudget: PACES.fast.values.contextBudget + 1000 };
  assert.strictEqual(detectPace(almost), 'custom', '只差一项也必须报 custom');
});

test('节奏档位：save({pace}) 展开档位并落盘；只改其他字段不得动档位参数', (t) => {
  const file = tmpFile(t);
  const cfg = createConfig(file);
  cfg.load();
  // ① 带 pace：整档展开
  cfg.save({ pace: 'fast' });
  assert.strictEqual(cfg.get().reasoningEffort, PACES.fast.values.reasoningEffort);
  assert.strictEqual(cfg.get().digestMinEvents, PACES.fast.values.digestMinEvents);
  assert.strictEqual(detectPace(cfg.get()), 'fast');
  // 档位本身不落盘（它是派生的，落盘会留下会过期的意图标签）
  assert.strictEqual(cfg.get().pace, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pace, undefined);

  // ② 用户手工微调一项 → 变自定义
  cfg.save({ contextBudget: 9999 });
  assert.strictEqual(detectPace(cfg.get()), 'custom');

  // ③ 不带 pace 的普通保存（例如只改模型名）绝不允许覆盖已微调的参数
  cfg.save({ model: 'other-model' });
  assert.strictEqual(cfg.get().contextBudget, 9999, '只改模型名不得把 contextBudget 改回档位值');
  assert.strictEqual(cfg.get().digestKeep, PACES.fast.values.digestKeep, '未被显式指定的项保持原值');

  // ④ 再选一次档位 → 回到该档完整参数
  cfg.save({ pace: 'fast' });
  assert.strictEqual(detectPace(cfg.get()), 'fast');
  assert.strictEqual(cfg.get().contextBudget, PACES.fast.values.contextBudget);
});

test('节奏档位：旧配置文件（无 pace 字段）迁移后按现有参数如实反查', () => {
  const legacy = { ...DEFAULT_CONFIG };
  delete legacy.pace;
  assert.strictEqual(detectPace(migrateConfig(legacy)), 'standard');
  // 老配置里手工调过参数 → custom，而不是硬贴成 standard
  const tuned = migrateConfig({ ...DEFAULT_CONFIG, contextBudget: 7777 });
  assert.strictEqual(detectPace(tuned), 'custom');
  // 万一旧文件里真留了 pace 字段，也必须被清掉（派生字段不落盘）
  assert.strictEqual(migrateConfig({ ...DEFAULT_CONFIG, pace: 'deep' }).pace, undefined);
});
