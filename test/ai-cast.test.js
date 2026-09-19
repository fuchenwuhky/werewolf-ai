'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cast = require('../web/ai-cast');
const { ALL } = require('../src/names');
const { PERSONALITIES, applyPersonalities, resolvePersona } = require('../src/ai/personalities');

test('AI cast: 24 unique portraits, 96 names, matching personas and small square PNG assets', () => {
  assert.equal(cast.PORTRAITS.length, 24);
  assert.equal(new Set(cast.PORTRAITS.map((p) => p.id)).size, 24);
  assert.equal(cast.NAMES.length, 96);
  assert.equal(new Set(cast.NAMES).size, 96);
  assert.equal(PERSONALITIES.length, 24);
  for (const p of cast.PORTRAITS) {
    assert.ok(PERSONALITIES.some((x) => x.id === p.persona));
    assert.match(p.src, /^\/assets\/avatars\/[a-z]+\.png$/);
    for (const name of [p.name, ...p.aliases]) {
      assert.equal(cast.profileForName(' ' + name + ' '), p);
      assert.ok(ALL.includes(name));
      assert.ok(name.length <= 12);
    }
    const png = fs.readFileSync(path.join(__dirname, '../web', p.src));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 384);
    assert.equal(png.readUInt32BE(20), 384);
    assert.ok(png.length < 512 * 1024, p.id + ' should stay lightweight');
  }
});

test('AI cast: allocation uses only public name, seat and human flag', () => {
  const players = Array.from({ length: 24 }, (_, i) => ({ seat: i + 1, name: '旧昵称' + i, isHuman: false }));
  const original = cast.assignPortraits(players);
  assert.equal(new Set([...original.values()].map((p) => p.id)).size, 24);
  const changed = players.map((p) => ({ ...p, role: 'wolf', team: 'wolf', alive: false, revealed: true })).reverse();
  assert.deepEqual(cast.assignPortraits(changed), original);
  assert.deepEqual(cast.assignPortraits(JSON.parse(JSON.stringify(players))), original);
  assert.equal(cast.assignPortraits([...players, { seat: 25, isHuman: true }]).has(25), false);
  assert.equal(cast.assignPortraits(null).size, 0);
  assert.equal(cast.profileForName('<img src=x onerror=alert(1)>'), null);
});

test('AI cast: named portraits are reserved before fallback and collisions do not duplicate', () => {
  const players = [
    { seat: 1, name: '普通自定义昵称' },
    { seat: 2, name: '赤绒' },
    { seat: 3, name: '烬羽' },
    { seat: 4, name: '霜句' },
    { seat: 5, name: '砚冬', isHuman: true },
  ];
  const result = cast.assignPortraits(players);
  assert.equal(result.get(2).id, 'hawk');
  assert.equal(result.get(4).id, 'minimalist');
  assert.equal(result.size, 4);
  assert.equal(new Set([...result.values()].map((p) => p.id)).size, 4);
  assert.equal(cast.assignPortraits(Array.from({ length: 30 }, (_, i) => ({ seat: i + 1 }))).size, 30);
});

test('AI cast: explicit persona beats named default; named aliases select the same default', () => {
  const players = [
    { name: '赤绒', personality: 'listener' },
    { name: '烬羽' },
    { name: '霜句', personality: '我的自定义风格' },
    { name: '绢页' },
    { name: '余音笔记' },
    { name: '终章', isHuman: true, personality: 'closer' },
  ];
  assert.equal(applyPersonalities(players, () => 0.5), players);
  assert.equal(players[0].personaName, resolvePersona('listener').name);
  assert.equal(players[1].personaName, resolvePersona('hawk').name);
  assert.equal(players[2].personality, '我的自定义风格');
  assert.equal(players[3].personaName, resolvePersona('archivist').name);
  assert.equal(players[4].personaName, resolvePersona('listener').name);
  assert.equal(players[5].personality, '');
  assert.equal(players[5].personaName, '');
});

test('AI cast: random personas avoid all reserved choices, including later seats', () => {
  const players = Array.from({ length: 22 }, (_, i) => ({ name: '普通昵称' + i }));
  players.push({ name: '终章' }, { name: '普通指定', personality: 'hawk' });
  applyPersonalities(players, () => 0.5);
  assert.equal(new Set(players.map((p) => p.personaName)).size, 24);
  for (const p of PERSONALITIES) assert.ok(p.prompt.length > 20 && p.prompt.length <= 200);
});

test('AI cast: browser and Node share exactly the same catalog and mapping', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/ai-cast.js'), 'utf8'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.AICast.PORTRAITS)), cast.PORTRAITS);
  const players = [{ seat: 1, name: '赤绒' }, { seat: 2, name: '老昵称' }];
  assert.deepEqual([...context.AICast.assignPortraits(players)].map(([s, p]) => [s, p.id]), [...cast.assignPortraits(players)].map(([s, p]) => [s, p.id]));
});

test('AI cast: image load/error preserves seat numbers and graceful fallback', () => {
  const handlers = {};
  const attributes = {};
  const classes = new Set();
  const image = { setAttribute: (k, v) => { attributes[k] = v; }, addEventListener: (k, fn) => { handlers[k] = fn; }, remove: () => { image.removed = true; } };
  const element = { ownerDocument: { createElement: () => image }, classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s) }, dataset: {}, prepend: (img) => { element.image = img; }, textContent: '12' };
  cast.decorate(null, cast.PORTRAITS[0]);
  cast.decorate(element, null);
  cast.decorate(element, cast.PORTRAITS[0]);
  assert.equal(image.src, '/assets/avatars/hawk.png');
  assert.equal(attributes['aria-hidden'], 'true');
  assert.equal(image.alt, '');
  assert.equal(element.textContent, '12');
  handlers.load();
  assert.ok(classes.has('portrait-ready'));
  handlers.error();
  assert.equal(classes.has('portrait-ready'), false);
  assert.equal(image.removed, true);
  assert.equal(element.textContent, '12');
});
