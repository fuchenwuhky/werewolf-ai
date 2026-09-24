/** Electron 档案导出桥：按钮在桌面壳走原生保存，在浏览器走同源下载。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const status = require('../web/shared/export-status');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const start = source.indexOf('function exportProfile(url, statusEl)');
const end = source.indexOf('function openProfileImport()', start);
assert.ok(start > 0 && end > start, '找不到桌面端导出接线区段');
const snippet = source.slice(start, end);

function harness(bridge) {
  const alerts = [];
  const downloads = [];
  const win = { WWTransferStatus: status, wwExport: bridge };
  const doc = {
    body: { appendChild() {} },
    createElement() { return { click() { downloads.push(this.href); }, remove() {} }; },
  };
  const run = vm.runInNewContext(`${snippet}\nexportProfile`, {
    window: win, document: doc, alert: (message) => alerts.push(message),
  });
  return { run, alerts, downloads };
}

const statusLine = () => ({ textContent: '', dataset: {} });

test('Electron：只把 profileId 交给原生桥；有真实路径才显示 saved', async () => {
  const ids = [];
  const h = harness({ async exportProfile(id) { ids.push(id); return { status: 'saved', path: 'D:\\档案.json' }; } });
  const line = statusLine();
  const result = await h.run('/api/profiles/p-123/export', line);
  assert.deepEqual(ids, ['p-123']);
  assert.equal(h.downloads.length, 0, 'Electron 不应再触发浏览器下载');
  assert.equal(result.status, 'saved');
  assert.equal(line.dataset.exportStatus, 'saved');
  assert.match(line.textContent, /已保存到/);
  assert.equal(h.alerts.length, 0);
});

test('Electron：取消、伪成功和异常分别诚实归一', async () => {
  for (const [raw, expected] of [[{ status: 'cancelled' }, 'cancelled'], [{ status: 'saved' }, 'failed']]) {
    const h = harness({ async exportProfile() { return raw; } });
    const line = statusLine();
    const result = await h.run('/api/profiles/p1/export', line);
    assert.equal(result.status, expected);
    assert.equal(line.dataset.exportStatus, expected);
  }
  const failed = harness({ async exportProfile() { throw new Error('磁盘不可写'); } });
  const line = statusLine();
  assert.equal((await failed.run('/api/profiles/p1/export', line)).status, 'failed');
  assert.match(line.textContent, /磁盘不可写/);
  assert.equal(failed.alerts.length, 1);
});

test('普通桌面浏览器：没有 Electron 桥则仍只提示已发起下载', () => {
  const h = harness(undefined);
  const line = statusLine();
  const result = h.run('/api/profiles/p1/export', line);
  assert.equal(result.status, 'started');
  assert.deepEqual(h.downloads, ['/api/profiles/p1/export']);
  assert.match(line.textContent, /浏览器无法确认/);
  assert.equal(h.run('https://example.invalid/api/profiles/p1/export', line).status, 'failed');
});
