'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Api } = require('../src/api');
const { Game } = require('../src/engine/game');
const Session = require('../web/shared/session-model');
const logger = { info() {}, warn() {}, error() {}, debug() {}, openGameLog() {}, closeGameLog() {} };

test('真实 HTTP：进程重启后的磁盘摘要/令牌/跨档案取消/确认恢复/归属与笔记', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-resume-http-'));
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger, saveDir: path.join(dir, 'saves') });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    api.handle(req, res, u.pathname, u.searchParams);
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = async (method, route, body) => {
      const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const out = await res.json();
      if (!res.ok) throw Object.assign(new Error(out.error), { status: res.status });
      return out;
    };
    const p = (await request('POST', '/api/profiles', { nickname: '原归属 A' })).profile;
    const g = new Game({ id: 'resume-fixture', board: { wolf: 1, seer: 1, villager: 3 }, players: Array.from({ length: 5 }, (_, i) => ({ name: 'P' + i, isHuman: i === 0 })), logger });
    g.deal(); g.started = true; g.day = 1; g.phase = 'night';
    const anchor = { ...g.toJSON(), nextPhase: 'night' };
    // 模拟重启：只有存档，内存表为空。所有凭证都是隔离测试数据。
    fs.writeFileSync(path.join(api.saveDir, `${g.id}.json`), JSON.stringify({ game: g.toJSON(), anchor, ownerProfileId: p.id, ownerNicknameSnapshot: p.nickname, mock: true, tokens: { player: 'fixture-player', god: 'fixture-god' } }));
    await api.annotations.put({ profileId: p.id, gameId: g.id, expectedRevision: 0, seats: { 2: { note: '重启前私人笔记' } } });
    const rows = (await request('GET', '/api/games')).rows;
    assert.equal(Session.findOwned(rows, p.id).id, g.id);
    const own = (await request('GET', `/api/profiles/${p.id}/games`)).rows[0];
    assert.equal(own.inMemory, false);
    assert.equal(own.resumable, true);
    assert.equal(own.ownerProfileId, p.id);
    let drives = 0;
    api._drive = () => { drives++; }; // 不运行 AI，只验证真实恢复路由及重建。
    const handle = { gameId: g.id };
    const canceled = await Session.prepare(request, handle, 'different-profile', async () => false);
    assert.equal(canceled, null);
    assert.equal(drives, 0);
    assert.equal(api.games.size, 0);
    const management = api.auth.isManagement;
    api.auth.isManagement = () => false; // 路由权限边界：非管理客户端只能带有效单局令牌读摘要。
    try {
      await assert.rejects(request('GET', `/api/games/${g.id}/tokens`), { status: 401 });
      await assert.rejects(request('GET', `/api/games/${g.id}/session?token=invalid`), { status: 403 });
      const limited = await request('GET', `/api/games/${g.id}/session?token=fixture-player`);
      assert.equal(limited.ownerProfileId, p.id);
      assert.equal(limited.tokens, undefined);
      assert.equal(limited.me.role, undefined);
    } finally { api.auth.isManagement = management; }
    const next = await Session.prepare(request, handle, 'different-profile', async () => true);
    assert.equal(drives, 1);
    assert.equal(next.ownerProfileId, p.id);
    assert.equal(next.ownerNickname, p.nickname);
    assert.equal(next.mock, true);
    assert.notEqual(next.playerToken, 'fixture-player');
    const view = await request('GET', `/api/games/${g.id}/view?token=${next.playerToken}`);
    assert.equal(view.ownerProfileId, p.id);
    assert.equal(view.inMemory, true);
    const notes = await request('GET', `/api/games/${g.id}/annotations?token=${next.playerToken}`);
    assert.equal(notes.annotations.seats[2].note, '重启前私人笔记');
    await assert.rejects(request('GET', '/api/games/missing/session'), { status: 404 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
