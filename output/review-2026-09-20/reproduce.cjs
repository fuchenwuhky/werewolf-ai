// Read-only-to-production acceptance probes. All fixtures live in an isolated temp root.
// Run: node output/review-2026-09-20/reproduce.cjs
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Api } = require('../../src/api');
const { Game } = require('../../src/engine/game');
const logger = { debug() {}, info() {}, warn() {}, error() {}, openGameLog() {}, closeGameLog() {}, query() { return []; } };

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-review-20260920-'));
  const saveDir = path.join(root, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  const api = new Api({ config: { get: () => ({ apiKey: '', journal: false }), save() {} }, logger, saveDir });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    api.handle(req, res, u.pathname, u.searchParams);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (method, route, data) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  const realWrite = fs.promises.writeFile;
  let releaseWrite;
  try {
    const profile = (await request('POST', '/api/profiles', { nickname: '独立验收样本' })).body.profile;
    const game = new Game({ id: 'review-race', board: { wolf: 1, villager: 4 }, players: Array.from({ length: 5 }, (_, i) => ({ name: 'Test' + i, isHuman: i === 0 })), stepPauseMs: 1, logger });
    game.deal(); game.started = true;
    api.games.set(game.id, { game, running: false, error: null, mock: true, tokens: { player: 'review-player', god: 'review-god' }, ownerProfileId: profile.id, createdAt: Date.now(), lastAccess: Date.now(), review: null });
    const route = '/api/games/' + game.id + '/annotations';
    await request('PUT', route, { expectedRevision: 0, seats: { 2: { note: 'existing note' } } });
    let enteredWrite;
    const blocked = new Promise(r => { enteredWrite = r; });
    const release = new Promise(r => { releaseWrite = r; });
    const annotationFile = api.annotations.file(profile.id, game.id);
    fs.promises.writeFile = async function(file, ...rest) {
      if (String(file).startsWith(annotationFile + '.tmp-')) {
        enteredWrite();
        await release;
      }
      return realWrite.call(fs.promises, file, ...rest);
    };
    const deletion = request('DELETE', route + '?seat=2&expectedRevision=1');
    await Promise.race([blocked, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('DELETE did not reach write')), 5000); t.unref(); })]);
    const put = await request('PUT', route, { expectedRevision: 1, seats: { 3: { note: 'concurrent save must survive' } } });
    releaseWrite();
    const del = await deletion;
    fs.promises.writeFile = realWrite;
    const final = await request('GET', route);
    console.log(JSON.stringify({ probe: 'HTTP DELETE vs PUT, same revision', deleteStatus: del.status, putStatus: put.status, deleteRevision: del.body.revision, putRevision: put.body.revision, finalRevision: final.body.revision, finalSeats: final.body.annotations.seats, lostSuccessfulWrite: put.status === 200 && !final.body.annotations.seats['3'] }, null, 2));

    const recovery = path.join(saveDir, '.import-recovery-broken-review.json');
    fs.writeFileSync(recovery, '{broken fixture');
    const pkg = { manifest: { exportVersion: 1, packageId: 'review-recovery', createdAt: '2026-09-20T00:00:00.000Z', source: 'isolated-review', counts: { games: 0, notes: 0 } }, profile: { nickname: '恢复记录样本', avatarId: 'scholar', bio: '' }, games: [] };
    const direct = await api.importApplyRes(pkg);
    const viaHttp = await request('POST', '/api/profiles/import', { package: { ...pkg, manifest: { ...pkg.manifest, packageId: 'review-recovery-http' } } });
    console.log(JSON.stringify({ probe: 'pendingRecoveries HTTP propagation', directPending: direct.body.pendingRecoveries, httpStatus: viaHttp.status, httpBody: viaHttp.body, recoveryStillExists: fs.existsSync(recovery) }, null, 2));
    console.log('Isolated fixtures retained at:', root);
  } finally {
    if (releaseWrite) releaseWrite();
    fs.promises.writeFile = realWrite;
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
