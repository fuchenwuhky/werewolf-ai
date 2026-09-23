/**
 * m3-home.test.js —— M3「首页」契约（计划书 §8.2 `:245`-`:254`；施工任务书 §1 屏1）
 *
 * 这一批要把首页收敛成四件事：**品牌 / 当前档案 / 继续上局 / 开始新局**，
 * 其余（图鉴、规则书、历史、资料、设置）压成**一组弱化的次级入口**，
 * 并且把"试玩"说清楚 —— 它是**流程脚本**，不是真实 AI 推理（原话"Mock 试玩不调用 API"
 * 没说清"不调用模型"，容易被当成"AI 只是便宜一点"）。
 *
 * 判据都用**结构/文案断言**，不锁 DOM 顺序、不锁按钮下标（施工任务书 §4 收尾要求）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const countOf = (hay, needle) => hay.split(needle).length - 1;

/** 取 `id="xxx"` 所在标签的整段（简单括号内切片，够用且不引入依赖） */
function tagWithId(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('>', at);
  return html.slice(start, end + 1);
}

test('屏1：第一屏恰好四件事 —— 品牌 / 当前档案 / 继续上局 / 开始新局', () => {
  const html = read('web/index.html');
  const at = html.indexOf('id="home-hero"');
  assert.ok(at > 0, '首页第一屏容器必须存在');
  const first = html.slice(at, Math.min(html.length, at + 4200));
  assert.ok(first.includes('id="home-profile"'), '要有"当前档案"卡');
  assert.ok(/id="resume-box"|id="resume-empty"/.test(first), '要有"继续上局"（含空态）');
  assert.ok(first.includes('id="btn-start"'), '要有"开始新局"主按钮');
  assert.strictEqual(countOf(html, 'id="btn-start"'), 1, '主按钮只许有一个');
  assert.ok(first.includes('class="home-cta"'), '主行动区要有独立容器');
});

test('屏1 去重：第一屏不再重复渲染同一份"这一局是什么"', () => {
  const html = read('web/index.html');
  assert.ok(html.includes('id="hero-facts"'), '保留事实条');
  assert.strictEqual(html.includes('id="setup-summary"'), false,
    '第二处同内容摘要（#setup-summary）必须去掉：同一份板子/人数/模式渲染两遍正是要修的重复');
  assert.strictEqual(read('web/app.js').includes("$('#setup-summary')"), false,
    '配套的渲染代码也要撤掉，不能留一个写不进去的死分支');
});

test('屏1 次级入口：一组弱化入口，图鉴/规则书/历史/设置各恰好一个，且同功能不重复', () => {
  const html = read('web/index.html');
  const nav = html.slice(html.indexOf('class="home-side"'), html.indexOf('</nav>', html.indexOf('class="home-side"')));
  assert.ok(nav.length > 0, '次级入口容器必须存在');
  // 图鉴：保留 ui-check 已经在点的 #btn-codex，但**只许有一个**入口（原来 hero + 侧栏各一个）
  assert.strictEqual(countOf(html, 'id="btn-codex"'), 1, '角色图鉴入口只许出现一次');
  assert.strictEqual(html.includes('id="entry-codex"'), false, '重复的第二个图鉴入口要去掉');
  assert.ok(nav.includes('id="btn-codex"'), '图鉴入口要落在次级入口组里（不再占第一屏主体）');
  assert.ok(nav.includes('id="entry-rulebook"'), '规则书入口');
  assert.ok(nav.includes('id="entry-history"'), '历史入口（M3 要求次级入口里含"历史"）');
  assert.ok(nav.includes('id="entry-settings"'), '设置入口');
});

test('屏1 文案：试玩要说成"流程脚本、不调用模型"，并说明真实对局才计费', () => {
  const html = read('web/index.html');
  const hint = tagWithId(html, 'setup-warn');
  const cta = html.slice(html.indexOf('class="home-cta"'), html.indexOf('</div>', html.indexOf('class="home-cta"')));
  assert.match(cta, /流程脚本/, '费用说明要写清试玩走的是本地流程脚本');
  assert.match(cta, /不调用模型/, '要明说"不调用模型"（只写"不调用 API"会让人以为仍是真 AI）');
  assert.match(cta, /计费/, '真实对局的计费说明要保留');
  assert.ok(hint.length > 0, '缺 Key 警示元素要保留（真实模式才提示）');
});

test('屏1 空态：无可恢复对局时给出"开始新局 + 三步"的下一步', () => {
  const html = read('web/index.html');
  const empty = html.slice(html.indexOf('id="resume-empty"'), html.indexOf('</div>', html.indexOf('id="resume-empty"')));
  assert.ok(empty.length > 0, '空态容器必须存在');
  assert.match(empty, /三步|第 1 步|板子与规则/, '空态要指向三步开局的走法');
});

test('共享模块注册：三步向导脚本要在两端都被加载，且早于各自的入口脚本', () => {
  for (const [page, entry] of [['web/index.html', 'app.js'], ['web/m/index.html', 'm.js']]) {
    const html = read(page);
    const wizard = html.indexOf('shared/setup-wizard.js');
    assert.ok(wizard > 0, `${page} 必须加载 shared/setup-wizard.js`);
    const draft = html.indexOf('shared/draft-store.js');
    assert.ok(draft > 0 && draft < wizard, `${page} 里 setup-wizard 要排在 draft-store 之后（它依赖 WWDraftStore）`);
    const entryAt = html.lastIndexOf(entry);
    assert.ok(entryAt > wizard, `${page} 里入口脚本必须排在向导模块之后`);
  }
});

test('共享模块一个都不能漏：web/shared/*.js 每个都要被两端加载、并进 SW 预缓存', () => {
  // 这条是把"新加共享模块忘了登记"变成红：漏加载 ⇒ 该端 ReferenceError；
  // 漏进 SW 预缓存 ⇒ 离线时那个模块 404、对应功能整片失效（比报错更难查）。
  const files = fs.readdirSync(path.join(ROOT, 'web/shared'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
  assert.ok(files.length >= 16, `web/shared 下应有 16 个及以上模块，实际 ${files.length}`);
  const desktop = read('web/index.html');
  const mobile = read('web/m/index.html');
  const sw = read('web/sw.js');
  const missing = [];
  for (const name of files) {
    if (!desktop.includes(`<script src="shared/${name}.js"></script>`)) missing.push(`web/index.html 未加载 ${name}.js`);
    if (!mobile.includes(`<script src="../shared/${name}.js"></script>`)) missing.push(`web/m/index.html 未加载 ${name}.js`);
    if (!sw.includes(`'/shared/${name}.js',`)) missing.push(`web/sw.js 预缓存清单缺 /shared/${name}.js`);
  }
  assert.deepStrictEqual(missing, [], `共享模块登记不全：\n  ${missing.join('\n  ')}`);
  // 预缓存清单换代：新模块进清单必须同时升 VERSION，否则老 Worker 缓存里没有它
  assert.match(sw, /const VERSION = 'ww-v\d+-m3'/,
    '加入 M3 的共享模块后，SW 版本号要换代到 ww-vNN-m3（否则旧缓存的 Worker 找不到新文件）');
});
