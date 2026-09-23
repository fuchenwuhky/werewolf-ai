/**
 * m3-setup-steps.test.js —— M3「三步开局」桌面端**接线**契约（计划书 §8.2 `:255`-`:268`）
 *
 * 纯逻辑层由 `test/m3-wizard.test.js` 覆盖（前两步零建局 / 后退保留 / 冻结 / 单次锁 / 丢响应先查后建）；
 * 本文件管的是**页面接线**：三步骨架真的在、每张卡归属到哪一步、建局只剩向导这一条路、
 * 缺 Key 与板子非法各有修复入口。真页面走查由 `scripts/ui-check.js` 的 M3 段负责。
 *
 * 判据一律走 id / data-* 归属，不锁 DOM 顺序、不锁按钮下标（施工任务书 §4 收尾要求）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');

/** 取含某 id 的标签整段 */
function tag(id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at > 0, `web/index.html 里缺少 #${id}`);
  const start = html.lastIndexOf('<', at);
  return html.slice(start, html.indexOf('>', at) + 1);
}

test('三步骨架：步进条 + 上一步/下一步 + 第三步确认区 + 修复入口', () => {
  assert.ok(html.includes('id="setup-steps"'), '要有步进条容器 #setup-steps');
  const btns = [...html.matchAll(/data-setup-step-btn="(\d)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(btns, ['1', '2', '3'], '步进条要有且只有三步（板子与规则 → 参与与座位 → 确认开局）');
  for (const id of ['setup-prev', 'setup-next', 'setup-confirm', 'setup-confirm-rows', 'setup-fix-settings']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.ok(/板子与规则/.test(html) && /参与与座位/.test(html) && /确认开局/.test(html),
    '三步的标题文案要与计划书一致（板子与规则 / 参与与座位 / 确认开局）');
});

test('卡片归步：板子与规则属第 1 步、玩家与模式属第 2 步、模型与密钥属第 3 步', () => {
  assert.match(tag('card-board'), /data-setup-step="1"/, '板子卡要在第 1 步');
  assert.match(tag('card-rules'), /data-setup-step="1"/, '规则卡要在第 1 步');
  assert.match(tag('card-players'), /data-setup-step="2"/, '玩家卡（含参与/座位/模式）要在第 2 步');
  assert.match(tag('card-api'), /data-setup-step="3"/, '模型与密钥要在第 3 步（确认这步才看配置状态）');
  assert.ok(/\[data-setup-step\]/.test(fs.readFileSync(path.join(ROOT, 'web/style.css'), 'utf8')),
    'web/style.css 要按 data-setup-step 与当前步控制显隐（否则三步会同时摊在屏幕上）');
});

test('开始游戏不再直接建局：主按钮开向导，建局只经向导的提交', () => {
  const bind = app.slice(app.indexOf("$('#btn-start')"), app.indexOf("$('#btn-start')") + 600);
  assert.match(bind, /openSetupWizard/, '#btn-start 必须打开三步向导（原来是一步弹层确认）');
  assert.ok(app.includes('WWSetupWizard.createWizard('), 'app.js 要真的建向导实例（不是只加载模块）');
  assert.match(app, /wizard\.commit\(|\.commit\(\{/, '最终提交必须走向导的 commit（闸门/冻结/单次锁都在里面）');
  assert.match(app, /create:\s*async\s*\(payload\)/, '建局请求要作为 create 回调交给 commit（载荷用冻结快照）');
  const posts = [...app.matchAll(/api\('POST', '\/api\/games'/g)].length;
  assert.ok(posts >= 1, '建局调用点要在（作为 create 回调）');
});

test('第三步确认区读共享汇总（档案/板子/人数/座位策略/模式/模型状态），不自己再拼一份', () => {
  assert.match(app, /WWSetupWizard\.summarize\(/, '确认区要复用共享的 summarize()，避免两端各拼一套文案');
  assert.match(app, /setup-confirm-rows/, '汇总要落到 #setup-confirm-rows');
  assert.match(app, /setup-fix-settings/, '缺 Key/绑定失效要给修复入口锚点');
});

test('缺 Key 与板子非法：给具体原因与修复入口，且不静默降级为试玩', () => {
  // 客户端不再自己写死"无 Key 就拦"，而是把判据交给 submitGate，由它给出 fix 指向
  assert.match(app, /hasApiKey:/, 'Key 状态要作为闸门输入（不是散落的 if）');
  assert.match(app, /boardValid:/, '板子合法性要作为闸门输入');
  assert.match(app, /boardReason:/, '板子非法要带具体原因（哪一项超限）');
  assert.match(app, /fix === 'settings'|fix === "settings"/, '闸门给 settings 修复指向时要真的跳到配置区');
});
