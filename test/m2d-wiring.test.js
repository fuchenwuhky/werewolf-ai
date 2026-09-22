/**
 * m2d-wiring.test.js — 接线的**静态守卫**（不跑浏览器也能判红的那一半）
 *
 * 五个共享模块本身的行为由各自的 m2d-*.test.js 逐条钉住；本文件只管一件最容易悄悄坏掉的事：
 * **它们真的被两端加载、并且真的被用上**。漏一个 script 标签、漏一条 SHELL、或"模块加载了但没人调"，
 * 单测全绿而用户在浏览器里拿到的仍是旧行为 —— 这正是本批最需要防的退化。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SOURCES = ['prefs-queue', 'request-guard', 'switch-guard', 'draft-store', 'stats-bucket'];

test('两端 index.html 都按 ../shared|shared/ 前缀加载了五个新模块（漏一个 ⇒ 该端 ReferenceError）', () => {
  const desktop = read('web/index.html');
  const mobile = read('web/m/index.html');
  for (const s of SOURCES) {
    assert.ok(desktop.includes(`<script src="shared/${s}.js"></script>`), `桌面端没有加载 shared/${s}.js`);
    assert.ok(mobile.includes(`<script src="../shared/${s}.js"></script>`), `手机端没有加载 ../shared/${s}.js`);
  }
});

test('五个新模块都在 Service Worker 预缓存清单里（离线时缺一个，对应功能整片失效）', () => {
  const sw = read('web/sw.js');
  for (const s of SOURCES) {
    assert.ok(sw.includes(`'/shared/${s}.js',`), `web/sw.js 的 SHELL 里没有 /shared/${s}.js`);
  }
});

test('模块加载之后才轮到各端的业务脚本（顺序反了会在顶层就 window.WWXxx undefined）', () => {
  const html = read('web/index.html');
  const last = html.lastIndexOf('<script src="shared/stats-bucket.js"></script>');
  const app = html.indexOf('<script src="app.js"></script>');
  assert.ok(last > 0 && app > last, '桌面端 app.js 必须在共享模块之后加载');
  const mhtml = read('web/m/index.html');
  const mlast = mhtml.lastIndexOf('<script src="../shared/stats-bucket.js"></script>');
  const mjs = mhtml.indexOf('<script src="m.js"></script>');
  assert.ok(mlast > 0 && mjs > mlast, '手机端 m.js 必须在共享模块之后加载');
});

test('两端都**真的调用**了五个模块（不是"加载了就完事"）', () => {
  const app = read('web/app.js');
  const mjs = read('web/m/m.js');
  const uses = [
    ['WWPrefsQueue.createPrefsQueue', 'WWPrefsQueue'],
    ['WWRequestGuard.createRequestGuard', 'WWRequestGuard'],
    ['WWSwitchGuard.decideSwitch', 'WWSwitchGuard'],
    ['WWDraftStore.readNoteDraft', 'WWDraftStore（笔记草稿读取）'],
    ['WWStatsBucket.formatAggregate', 'WWStatsBucket'],
  ];
  for (const [needle, label] of uses) {
    assert.ok(app.includes(needle), `桌面端没有调用 ${label}（${needle}）`);
    assert.ok(mjs.includes(needle), `手机端没有调用 ${label}（${needle}）`);
  }
  // 开局草稿（按档案隔离）目前只接在桌面端设置屏；手机端板子页的同类草稿是**本批未做项**，
  // 写进报告的"未做/建议"里，不用"两端都有"来假装覆盖（见报告 §未做）。
  assert.ok(app.includes('WWDraftStore.readSetupDraft'), '桌面端没有读按档案隔离的开局草稿');
  assert.ok(app.includes('WWDraftStore.writeSetupDraft'), '桌面端没有写按档案隔离的开局草稿');
  // 归档阻止：两端都必须走共享判定（原因与顺序只有一份真值）
  assert.ok(app.includes('WWSwitchGuard.archiveBlockReason'), '桌面端归档没有走 archiveBlockReason');
  assert.ok(mjs.includes('WWSwitchGuard.archiveBlockReason'), '手机端归档没有走 archiveBlockReason');
  // 两个"未保存"信号：切档确认读的就是它们，一端漏登记就等于该端的草稿不再被保护
  assert.ok(/state\.noteDirty\s*=\s*dirty/.test(app), '桌面端笔记弹层没有登记 dirty()');
  assert.ok(/state\.noteDirty\s*=\s*dirty/.test(mjs), '手机端笔记弹层没有登记 dirty()');
  assert.ok(/state\.profileFormDirty\s*=\s*\(\)/.test(app), '桌面端资料表单没有登记 dirty()');
  assert.ok(/state\.profileFormDirty\s*=\s*\(\)/.test(mjs), '手机端资料表单没有登记 dirty()');
});

test('切档路径真的先过守卫（有草稿要 confirm，取消则原地返回），并推进请求代次', () => {
  for (const f of ['web/app.js', 'web/m/m.js']) {
    const src = read(f);
    // 本窗口自己的切档：必须问（storage 那条是另一分支：其他窗口 ⇒ defer，不弹框）
    assert.ok(/decideSwitch\(\{ dirty: hasUnsavedDraft\(\), source: window\.WWSwitchGuard\.SELF \}\)/.test(src),
      `${f} 的本窗口切档没有过 decideSwitch({ dirty: hasUnsavedDraft(), source: SELF })`);
    assert.ok(/if \(decision\.action === 'confirm' && !confirm\(/.test(src),
      `${f} 的 confirm 分支不完整（会把草稿直接丢掉）`);
    const at = src.indexOf('function onSelectProfile(pid) {');
    const seg = src.slice(at, at + 900);
    assert.ok(/getRequestGuard\(\)\.setCurrent\(pid\)/.test(seg), `${f} 切档时没有推进请求代次（迟到响应会画到新档案上）`);
    // 其他窗口的切档：只提示、不弹框、不销毁本窗口草稿
    assert.ok(/decideSwitch\(\{ dirty: hasUnsavedDraft\(\), source: window\.WWSwitchGuard\.OTHER_WINDOW \}\)/.test(src),
      `${f} 的 storage 分支没有走 OTHER_WINDOW（别的窗口切档会误弹确认框）`);
    assert.ok(/OTHER_WINDOW[\s\S]{0,240}?action === 'defer'/.test(src), `${f} 的 OTHER_WINDOW 分支没有 defer 处理`);
  }
});

test('笔记弹层里的草稿钩子只经 state 走（vm 沙箱里没有 window，见 annotation-editor.test.js）', () => {
  for (const f of ['web/app.js', 'web/m/m.js']) {
    const src = read(f);
    const start = src.indexOf('function openTagModal(seat) {');
    const end = src.indexOf('旧格式兜底', start) > 0 ? src.indexOf('旧格式兜底', start) : src.length;
    const body = src.slice(start, end);
    assert.ok(body.includes('state.noteDraftHook'), `${f}: openTagModal 没有读 state.noteDraftHook`);
    assert.ok(!/window\.WWDraftStore/.test(body), `${f}: openTagModal 里出现了 window.*（会被抽出来单跑的用例判红）`);
  }
});

/**
 * 回归：**新建档案成功后必须立刻摘掉"未保存"标记**。
 * 这不是洁癖 —— ui:check --full --strict 实测抓到过：新建成功 → 代码紧接着"新建即选用"
 * （onSelectProfile）→ 表单还开着且昵称已填 ⇒ dirty 仍为 true ⇒ 切档守卫弹原生 confirm
 * ⇒ 整个页面被对话框挡住（CDP Runtime.evaluate 直接超时，后续 18 项检查全部"未执行"）。
 * 所以这里钉住两端都必须有 markSaved()，且必须排在 onSelectProfile 之前。
 */
test('新建/保存成功后摘掉 dirty，且排在"新建即选用"之前（否则原生 confirm 会挡住整页）', () => {
  for (const f of ['web/app.js', 'web/m/m.js']) {
    const src = read(f);
    assert.ok(/const markSaved = \(\) => \{ state\.profileFormDirty = null; \}/.test(src),
      `${f} 没有 markSaved()（保存成功后 dirty 不会失效）`);
    const createPath = /markSaved\(\);[\s\S]{0,160}?onSelectProfile\(prof\.id\)/.test(src);
    assert.ok(createPath, `${f} 的"新建即选用"之前没有 markSaved()（会弹原生 confirm 把页面挡住）`);
  }
});
