'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../web/shared/session-model');

test('无句柄只找当前档案可恢复局，不采纳其他档案或未开始/已结束局', () => {
  const rows = [
    { id: 'foreign', ownerProfileId: 'b', started: true, inMemory: true },
    { id: 'over', ownerProfileId: 'a', started: true, finished: true, inMemory: true },
    { id: 'setup', ownerProfileId: 'a', inMemory: true },
    { id: 'disk', ownerProfileId: 'a', started: true, resumable: true },
  ];
  assert.equal(M.findOwned(rows, 'a').id, 'disk');
  assert.equal(M.findOwned(rows, null), null);
  assert.equal(M.findOwned(rows, 'missing'), null);
  assert.equal(M.canResume(null), false);
});

for (const inMemory of [true, false]) {
  for (const accept of [true, false]) {
    test(`旧句柄跨档：inMemory=${inMemory}，确认=${accept}，服务端归属优先且取消零启动`, async () => {
      const calls = [];
      const view = { ownerProfileId: 'a', ownerNickname: '玩家 A', mock: true, me: { seat: 3 }, inMemory, started: true };
      const api = async (method, url, body) => {
        calls.push({ method, url, body });
        return method === 'GET' ? view : { gameId: 'g', playerToken: 'new-player', godToken: 'new-god' };
      };
      let confirmed = 0;
      const next = await M.prepare(api, { gameId: 'g', playerToken: 'old', ownerProfileId: 'b', mock: false }, 'b', async (h) => {
        confirmed++;
        assert.equal(h.ownerProfileId, 'a');
        return accept;
      });
      assert.equal(confirmed, 1);
      assert.equal(calls.filter((c) => c.method === 'POST').length, accept && !inMemory ? 1 : 0);
      if (!accept) assert.equal(next, null);
      else {
        assert.equal(next.ownerNickname, '玩家 A');
        assert.equal(next.mySeat, 3);
        assert.equal(next.mock, true);
        assert.equal(next.playerToken, inMemory ? 'old' : 'new-player');
      }
    });
  }
}

test('同档案磁盘恢复先取令牌，携带令牌续跑，拒绝 ended/session 网络故障', async () => {
  const calls = [];
  const api = async (method, url, body) => {
    calls.push(url);
    if (url.endsWith('/tokens')) return { player: 'p', god: 'g' };
    if (url.includes('/session')) return { started: true, ownerProfileId: 'a' };
    assert.equal(body.token, 'p');
    return { gameId: 'disk', playerToken: 'newp', godToken: 'newg' };
  };
  assert.equal((await M.prepare(api, { gameId: 'disk' }, 'a', () => assert.fail('同档案不需要确认'))).playerToken, 'newp');
  assert.equal(calls.length, 3);
  await assert.rejects(M.prepare(async () => ({ finished: true }), { gameId: 'g', playerToken: 'p' }, 'a'), /结束/);
  await assert.rejects(M.prepare(async () => { throw new Error('offline'); }, { gameId: 'g', playerToken: 'p' }, 'a'), /offline/);
});

test('另一窗口先恢复后，旧令牌只能经管理接口换取，不用旧凭证进入局内', async () => {
  const api = async (method, url) => url.endsWith('/tokens') ? { player: 'current', god: 'god' }
    : { started: true, inMemory: true, ownerProfileId: 'a', tokenValid: false };
  const next = await M.prepare(api, { gameId: 'g', playerToken: 'stale' }, 'a');
  assert.equal(next.playerToken, 'current');
});
