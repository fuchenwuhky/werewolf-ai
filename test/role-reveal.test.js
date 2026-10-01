'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/shared/presentation.js'), 'utf8');
function fixture() {
  const document = { documentElement: { dataset: {} }, activeElement: null };
  const timers = new Map(); let nextTimer = 0;
  const window = {
    matchMedia: () => ({matches:false,addEventListener(){}}), getComputedStyle: () => ({transitionDuration:'0.8s',transitionDelay:'0s'}),
    setTimeout(fn, ms) { timers.set(++nextTimer, {fn, ms}); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(source, {window,document});
  const element = () => {
    const classes = new Set(); const attrs = new Map();
    return { hidden:false, disabled:false, textContent:'STALE SECRET', tabIndex:0,
      classList: {add: x => classes.add(x),remove: x => classes.delete(x),contains: x => classes.has(x)},
      setAttribute: (k,v) => attrs.set(k,v), removeAttribute: k => attrs.delete(k), getAttribute: k => attrs.get(k),
      replaceChildren() { this.textContent = ''; }, focus() { document.activeElement = this; },
      getBoundingClientRect() { return {}; }, querySelector() { return this; },
    };
  };
  const nodes = Object.fromEntries(['overlay','card','front','caption','hint','tools','done','inspect'].map(k => [k,element()]));
  const calls = {front:0,caption:0,reveal:0,done:0,inspect:0};
  const options = {...nodes,
    renderFront(front) { calls.front++; front.textContent = '狼人'; },
    renderCaption(caption) { calls.caption++; caption.textContent = '夜袭；狼队：1、4、8号'; },
    onReveal() { calls.reveal++; }, onDone() { calls.done++; }, onInspect() { calls.inspect++; },
  };
  return {...nodes,calls,options,document,window,timers,api:window.WWPresentation,
    flush() { for (const {fn} of [...timers.values()]) fn(); timers.clear(); }};
}
test('未翻牌不生成秘密 DOM，清除上局内容，确认/检视不能绕过', () => {
  const f = fixture(); f.api.roleReveal(f.options);
  assert.equal(f.front.textContent,''); assert.equal(f.caption.textContent,'');
  assert.equal(f.front.hidden,true); assert.equal(f.caption.hidden,true); assert.equal(f.tools.hidden,true);
  assert.equal(f.hint.hidden,false); assert.equal(f.document.activeElement,f.card);
  f.done.onclick(); f.inspect.onclick();
  assert.deepEqual(f.calls,{front:0,caption:0,reveal:0,done:0,inspect:0});
});
test('点击只开始翻牌，动画完成才生成说明和解锁；重复点击不会重复执行', () => {
  const f = fixture(); f.api.roleReveal(f.options);
  f.card.onclick(); f.card.onclick();
  assert.equal(f.calls.front,1); assert.equal(f.calls.caption,0); assert.equal(f.done.disabled,true);
  assert.equal(f.tools.hidden,true); assert.equal(f.front.getAttribute('aria-hidden'),'true');
  assert.equal([...f.timers.values()][0].ms,820);
  f.flush(); assert.equal(f.calls.caption,1); assert.equal(f.hint.hidden,true);
  assert.equal(f.front.getAttribute('aria-hidden'),undefined); assert.equal(f.overlay.classList.contains('revealed'),true);
  assert.equal(f.document.activeElement,f.done); assert.equal(f.card.tabIndex,-1);
  f.done.onclick(); f.inspect.onclick(); assert.equal(f.calls.done,1); assert.equal(f.calls.inspect,1);
});
test('键盘揭示与焦点循环不会进入背景，输入法组合键不误翻牌', () => {
  const f = fixture(); f.api.roleReveal(f.options);
  let prevented = 0;
  f.overlay.onkeydown({key:'Tab',preventDefault(){prevented++;}});
  assert.equal(f.document.activeElement,f.card);
  f.card.onkeydown({key:'Enter',isComposing:true,preventDefault(){}}); assert.equal(f.calls.front,0);
  f.card.onkeydown({key:' ',preventDefault(){prevented++;}}); f.flush();
  f.overlay.onkeydown({key:'Tab',preventDefault(){prevented++;}}); assert.equal(f.document.activeElement,f.inspect);
  f.overlay.onkeydown({key:'Tab',preventDefault(){prevented++;}}); assert.equal(f.document.activeElement,f.done);
  f.overlay.onkeydown({key:'Tab',shiftKey:true,preventDefault(){prevented++;}}); assert.equal(f.document.activeElement,f.inspect);
  assert.equal(prevented,5);
});
test('换局/关闭取消旧延时，不会把新牌提前揭示或重新显示工具', () => {
  const f = fixture(); const old = f.api.roleReveal(f.options); f.card.onclick();
  const stale = [...f.timers.values()][0].fn;
  f.api.roleReveal(f.options); stale(); assert.equal(f.calls.caption,0); assert.equal(f.tools.hidden,true);
  old.cancel(); f.card.onclick(); const current = [...f.timers.values()][0].fn;
  const controller = f.api.roleReveal(f.options); controller.cancel(); current();
  assert.equal(f.calls.caption,0); assert.equal(f.tools.hidden,true); assert.equal(f.timers.size,0);
});
test('减少动态效果立即揭示，已经揭示的牌重开不重复等待', () => {
  const f = fixture(); f.document.documentElement.dataset.prefMotion='0'; f.api.roleReveal(f.options);
  f.card.onclick(); assert.equal(f.timers.size,0); assert.equal(f.calls.reveal,1); assert.equal(f.tools.hidden,false);
  delete f.document.documentElement.dataset.prefMotion;
  f.api.roleReveal({...f.options,initiallyRevealed:true});
  assert.equal(f.timers.size,0); assert.equal(f.calls.reveal,2); assert.equal(f.overlay.classList.contains('revealed'),true);
});
