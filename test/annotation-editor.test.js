'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const model = require('../web/shared/annotations-model');

// 执行真实编辑函数，只替换 DOM 容器；用于捕获“正文未进入 dirty 判断”一类闭包错误。
// 这不是浏览器 E2E；布局、遮罩命中和焦点另行用真实浏览器复验。
function editor(mobile) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', mobile ? 'm/m.js' : 'app.js'), 'utf8');
  const start = source.indexOf('function openTagModal(seat) {');
  const end = source.indexOf(mobile ? '/** 旧格式兜底' : '// ---------------- 笔记列表', start);
  assert.ok(start >= 0 && end > start);
  const nodes = [];
  const result = { closed: 0, confirms: 0, options: null };
  function el(tag, cls, html) {
    const n = { tag, cls, html, style: {}, children: [], handlers: {},
      addEventListener(event, fn) { this.handlers[event] = fn; },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      click() { return this.handlers.click(); },
    };
    nodes.push(n);
    return n;
  }
  const close = () => { result.closed++; };
  const context = vm.createContext({
    state: { view: { board: { wolf: 1, seer: 1 }, players: [{ seat: 2, name: '测试座位' }], day: 1, phase: 'night' }, anno: { seats: {}, available: true },
      meta: { roles: { wolf: { name: '狼人' }, seer: { name: '预言家' }, witch: { name: '女巫' } } } },
    A: () => model, AM: () => model, possibleRolesFor: () => ['wolf'], roleInfo: () => ({ name: '狼人' }),
    el, escapeHtml: (s) => s, confirm: () => { result.confirms++; return false; },
    closeModal: close, closeSheet: close,
    openModal: (_, options) => { result.options = options; },
    openSheet: (_, body, foot, options) => { result.options = options; },
    saveAnnotations: async () => false,
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('openTagModal(2)', context);
  return { nodes, result };
}

for (const mobile of [false, true]) {
  for (const field of ['textarea', 'input']) {
    test(`${mobile ? '手机' : '桌面'}笔记：只编辑${field === 'textarea' ? '正文' : '依据序号'}，取消/遮罩守卫必须保留草稿`, () => {
      const { nodes, result } = editor(mobile);
      const input = nodes.find((n) => n.tag === field);
      input.value = field === 'textarea' ? '未保存的纯正文' : '12';
      assert.equal(typeof input.handlers.input, 'function');
      input.handlers.input();
      nodes.find((n) => n.tag === 'button' && n.html === (mobile ? '取消' : '✕')).click();
      assert.equal(result.confirms, 1);
      assert.equal(result.closed, 0);
      if (mobile) assert.equal(result.options.vetoClose(), true);
      else result.options.onDismiss();
      assert.equal(result.confirms, 2);
      assert.equal(result.closed, 0);
      // 自称角色池含本人唯一身份 seer，但不列不在板子里的 witch。
      assert.deepEqual(nodes.filter((n) => n.tag === 'option').map((n) => n.value), ['', 'wolf', 'seer']);
    });
  }
  test(`${mobile ? '手机' : '桌面'}笔记：保存失败保持编辑器打开`, async () => {
    const { nodes, result } = editor(mobile);
    const save = nodes.find((n) => n.tag === 'button' && n.html === '保存笔记');
    await save.click();
    assert.equal(result.closed, 0);
    assert.equal(save.disabled, false);
  });
}
