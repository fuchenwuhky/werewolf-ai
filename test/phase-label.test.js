/**
 * phase-label.test.js — 「阶段名表只有一份」的结构守卫（A3b）
 *
 * 背景：`web/app.js` 与 `web/m/m.js` 原来各写一张**逐字相同**的阶段表
 * （`const PHASE_LABEL = { setup: '开局', night: '夜晚', … }`，8 键 8 文案）。两张表没有任何门禁
 * 对拍 ⇒ 单边改一个字（"天亮" → "黎明"）不会有任何测试发现，同一个阶段在电脑与手机上叫两个名字；
 * 删一个键则那一端会退化成直接显示阶段值（`PHASE_LABEL[phase] || phase` 的兜底让错误静默）。
 * 现在两端都只保留 `const PHASE_LABEL = window.WWPhaseLabel.PHASE_LABEL;` 这一行引用。
 *
 * 本文件钉四件事（每一件都能独立判红）：
 *   ① 两端引用的是**同一个文件**，谁都不许再自己写一张表；
 *   ② 这个文件确实被两个 HTML 引进页面、也被 Service Worker 预缓存（否则浏览器里
 *      `window.WWPhaseLabel` 是 undefined —— 静态地"引用了共享模块"却跑不起来）；
 *   ③ 键集合与文案**逐字**等于下面的冻结台账（改一个字 / 删一个键 / 加一个键都判红）；
 *   ④ 把两端**真实源码里那一行引用**在同一次装载里求值，得到的是**同一个对象**（不是两份拷贝）。
 *
 * ⚠ 不许为了让本用例变绿而修改 FROZEN：它就是"两端文案一致"的证据本身。真要改文案，
 *   请连 FROZEN 一起改 —— 那是一次有意识的决定，而不是单边漂移。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SHARED_REL = 'web/shared/phase-label.js';
/** 两端各自的引用行（键名保留 `PHASE_LABEL`，使用点一处不动） */
const REF_LINE = 'const PHASE_LABEL = window.WWPhaseLabel.PHASE_LABEL;';
const ENDPOINTS = [
  ['web/app.js', '桌面端'],
  ['web/m/m.js', '手机端'],
];

/** 冻结台账：键顺序 + 文案逐字。这是"逐字一致"的判据本体。 */
const FROZEN = {
  setup: '开局', night: '夜晚', dawn: '天亮', sheriff: '警长竞选',
  speech: '白天发言', vote: '放逐投票', pk: 'PK 环节', over: '结算',
};

/** 把共享模块装进一个**浏览器形状**的沙箱（`window` 存在 ⇒ 走 global 分支，不碰 module.exports） */
function browserEnv() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(SHARED_REL), sandbox, { filename: SHARED_REL });
  return sandbox;
}

/** 取某个端**真实源码里**那一行引用（而不是照抄常量），供下面求值用 */
function refLineOf(rel) {
  const m = read(rel).match(/const PHASE_LABEL = [^\n]*;/);
  return m ? m[0] : null;
}

test('阶段表：两端引用的是同一个共享文件，谁都不许再自己写一张', () => {
  const bad = [];
  for (const [rel, who] of ENDPOINTS) {
    const src = read(rel);
    if (!src.includes(REF_LINE)) {
      bad.push(`  ✖ ${rel}（${who}）没有按共享模块引用阶段表（应含「${REF_LINE}」）`);
    }
    if (/const PHASE_LABEL\s*=\s*\{/.test(src)) {
      bad.push(`  ✖ ${rel}（${who}）又出现了一张自己写的阶段表（const PHASE_LABEL = { … }）`);
    }
  }
  assert.deepStrictEqual(bad, [], `阶段表应只有一份定义（${SHARED_REL}）：\n${bad.join('\n')}`);
});

test('阶段表：两个 HTML 都引了它、Service Worker 也预缓存了（离线打开不能缺）', () => {
  const refs = {
    'web/index.html': 'shared/phase-label.js',
    'web/m/index.html': '../shared/phase-label.js',
  };
  const bad = [];
  for (const [html, needle] of Object.entries(refs)) {
    if (!read(html).includes(`<script src="${needle}"></script>`)) bad.push(`  ✖ ${html} 没有引入 ${needle}`);
  }
  if (!read('web/sw.js').includes("'/shared/phase-label.js'")) {
    bad.push("  ✖ web/sw.js 的 SHELL 清单没有登记 '/shared/phase-label.js'（离线打开时 window.WWPhaseLabel 会是 undefined）");
  }
  assert.deepStrictEqual(bad, [], `共享阶段表没有被真正引进页面/预缓存清单：\n${bad.join('\n')}`);
});

test('阶段表：键集合与文案逐字等于冻结台账（单边改一个字 / 删一个键都判红）', () => {
  const api = browserEnv().WWPhaseLabel;
  assert.ok(api && api.PHASE_LABEL, `${SHARED_REL} 没有导出 WWPhaseLabel.PHASE_LABEL`);
  assert.deepStrictEqual(Object.keys(api.PHASE_LABEL), Object.keys(FROZEN),
    `阶段键集合变了：实测 ${JSON.stringify(Object.keys(api.PHASE_LABEL))}，台账 ${JSON.stringify(Object.keys(FROZEN))}`);
  assert.deepStrictEqual({ ...api.PHASE_LABEL }, FROZEN, '阶段文案与冻结台账不一致（单边改了文案？）');
});

test('阶段表：两端取到的是同一个对象（同一引用，不是各自一份拷贝）', () => {
  const win = browserEnv();
  const fromEndpoint = (rel) => {
    const line = refLineOf(rel);
    assert.ok(line, `${rel} 里找不到阶段表的引用行（形如「${REF_LINE}」）`);
    // 用**该文件里真实的那一行**求值：若有人把它换成自己的一张表，这里拿到的就不是共享对象
    return vm.runInContext(`(() => { ${line} return PHASE_LABEL; })()`, win, { filename: rel });
  };
  const appRef = fromEndpoint('web/app.js');
  const mRef = fromEndpoint('web/m/m.js');
  assert.strictEqual(appRef, win.WWPhaseLabel.PHASE_LABEL, '桌面端取到的不是共享模块导出的那个对象');
  assert.strictEqual(mRef, win.WWPhaseLabel.PHASE_LABEL, '手机端取到的不是共享模块导出的那个对象');
  assert.strictEqual(appRef, mRef, '两端拿到的不是同一个对象（说明某一端复制了一份）');
  assert.deepStrictEqual({ ...appRef }, FROZEN, '共享的那一份本身与冻结台账不一致');
});

/**
 * 服务端那一份：`src/engine/render.js` 的 `PHASE_LABEL`（AI 上下文与前端兜底渲染共用）。
 *
 * 为什么还要钉这一对：上面三条只关掉了"桌面 ↔ 手机"的单边漂移；浏览器↔服务端这一对
 * 仍然是敞开的 —— 服务端加一个阶段（或改一个名字）时，客户端会静默退化成
 * `PHASE_LABEL[phase] || phase`（直接显示阶段值），没有任何测试会红。所以这里也钉住。
 *
 * 取表的方式是 `require` 真实导出（不靠正则去猜它写成什么形状）：render.js 的
 * `module.exports` 里就有 `PHASE_LABEL`，改导出名会让这条用例拿到 undefined 并明确报错。
 * **文案也逐字对拍**：该表的取值就是中文阶段名（读源码确认：`setup: '开局', night: '夜晚' …`），
 * 与浏览器那份展示文案同源，所以没有"只钉键不钉文案"的理由。
 */
test('阶段表：服务端表（src/engine/render.js）与共享表的键集合、文案完全一致', () => {
  const server = require('../src/engine/render.js').PHASE_LABEL;
  const client = browserEnv().WWPhaseLabel.PHASE_LABEL;
  assert.ok(server && typeof server === 'object',
    'src/engine/render.js 没有导出 PHASE_LABEL（导出被改名/删掉了？）');
  assert.deepStrictEqual(Object.keys(server), Object.keys(client),
    `服务端与浏览器端的阶段键集合不一致：服务端 ${JSON.stringify(Object.keys(server))}，共享表 ${JSON.stringify(Object.keys(client))}`);
  assert.deepStrictEqual({ ...server }, { ...client },
    '服务端与浏览器端的阶段文案不一致（一边改了名字？）');
  assert.deepStrictEqual({ ...server }, FROZEN, '服务端那一份与冻结台账不一致');
});
