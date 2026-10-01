'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/shared/presentation.js'), 'utf8');
function fixture() {
  let changed, preferenceChanged;
  const preference = { matches: false, addEventListener: (_, fn) => { preferenceChanged = fn; } };
  const document = { documentElement: { dataset: {} } };
  const window = { matchMedia: () => preference, MutationObserver: class { constructor(fn) { changed = fn; } observe() {} } };
  vm.runInNewContext(source, { window, document });
  const animations = [];
  const element = { getClientRects: () => [{}], animate: (frames, options) => {
    const a = { frames, options, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
    animations.push(a); return a;
  } };
  return { api: window.WWPresentation, element, animations, document, preference, changeProfile: () => changed(), changeSystem: () => preferenceChanged() };
}
test('page entrance is short and does not scale text or set persistent fill styles', () => {
  const f = fixture(); f.api.enter(f.element);
  assert.equal(f.animations[0].options.duration, 200);
  assert.equal(f.animations[0].options.fill, undefined);
  assert.ok(f.animations[0].frames.every(frame => frame.transform === undefined));
});
test('repeated navigation cancels its previous animation rather than stacking', () => {
  const f = fixture(); f.api.enter(f.element); f.api.enter(f.element, true);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations[1].frames[0].transform, 'translateY(6px)');
});
test('system reduced motion skips new animations and cancels active ones', () => {
  const f = fixture(); f.api.enter(f.element); f.preference.matches = true; f.changeSystem(); f.api.enter(f.element);
  assert.equal(f.animations.length, 1); assert.equal(f.animations[0].cancelled, true);
});
test('profile reduced motion is honored immediately without a reload', () => {
  const f = fixture(); f.api.enter(f.element); f.document.documentElement.dataset.prefMotion = '0'; f.changeProfile(); f.api.enter(f.element);
  assert.equal(f.animations.length, 1); assert.equal(f.animations[0].cancelled, true);
});
test('completed animations are released and hidden nodes are not animated', () => {
  const f = fixture(); f.api.enter(f.element); f.animations[0].onfinish();
  f.element.getClientRects = () => []; f.api.enter(f.element);
  f.preference.matches = true; f.changeSystem();
  assert.equal(f.animations.length, 1); assert.equal(f.animations[0].cancelled, false);
});
test('unavailable animation API is a no-op, not a navigation failure', () => {
  const f = fixture(); delete f.element.animate;
  assert.doesNotThrow(() => { f.api.enter(null); f.api.enter(f.element); });
});
