/** Android 档案导出桥：只把 ID 交给原生；终态必须由 SAF 回调确认。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const status = require('../web/shared/export-status');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'm', 'm.js'), 'utf8');
const start = source.indexOf('function exportProfile(url)');
const end = source.indexOf('function openProfileImport()', start);
assert.ok(start > 0 && end > start, '找不到手机端导出接线区段');
const snippet = source.slice(start, end);

function harness(bridge) {
  const messages = [];
  const downloads = [];
  const win = { WWTransferStatus: status, WWExport: bridge };
  const doc = {
    body: { appendChild() {} },
    createElement() {
      return { click() { downloads.push(this.href); }, remove() {} };
    },
  };
  const run = vm.runInNewContext(`${snippet}\nexportProfile`, {
    window: win, document: doc, flash: (message, kind) => messages.push({ message, kind }),
  });
  return { run, win, messages, downloads };
}

test('Android：pending 不是保存成功；回调带 SAF URI 才报告 saved', async () => {
  const ids = [];
  const h = harness({ exportProfile(id) { ids.push(id); return '{"pending":true}'; } });
  const result = h.run('/api/profiles/profile-123/export');
  assert.deepEqual(ids, ['profile-123']);
  assert.equal(h.downloads.length, 0, '原生壳绝不能再触发浏览器下载');
  assert.match(h.messages.at(-1).message, /系统保存界面/);
  assert.ok(!h.messages.some((m) => /已保存到/.test(m.message)), 'pending 不能宣称已保存');
  h.win.__wwExportResult('{"status":"saved","path":"content://documents/42","bytes":512}');
  const final = await result;
  assert.equal(final.status, 'saved');
  assert.equal(final.path, 'content://documents/42');
  assert.match(h.messages.at(-1).message, /已保存到：content:\/\/documents\/42/);
  assert.equal(h.win.__wwExportResult, undefined, '结束后不留上一轮回调');
});

test('Android：取消、失败与缺路径伪成功分别按真实终态显示', async () => {
  const h = harness({ exportProfile() { return '{"pending":true}'; } });
  const cancelled = h.run('/api/profiles/p1/export');
  h.win.__wwExportResult('{"status":"cancelled"}');
  assert.equal((await cancelled).status, 'cancelled');
  assert.match(h.messages.at(-1).message, /已取消导出/);

  const failed = h.run('/api/profiles/p1/export');
  h.win.__wwExportResult('{"status":"failed","error":"磁盘已满"}');
  assert.equal((await failed).status, 'failed');
  assert.match(h.messages.at(-1).message, /磁盘已满/);

  const noPath = h.run('/api/profiles/p1/export');
  h.win.__wwExportResult('{"status":"saved"}');
  assert.equal((await noPath).status, 'failed', '没有落盘路径不能报成功');
});

test('Android：受理同步失败、重复点击、非法路径都不误报成功', async () => {
  const h = harness({ exportProfile() { return '{"pending":true}'; } });
  const first = h.run('/api/profiles/p1/export');
  const busy = await h.run('/api/profiles/p2/export');
  assert.equal(busy.status, 'failed');
  assert.match(busy.error, /正在进行/);
  h.win.__wwExportResult('{"status":"cancelled"}');
  await first;

  const invalid = h.run('https://example.invalid/api/profiles/p1/export');
  assert.equal(invalid.status, 'failed');
  const immediate = harness({ exportProfile() { return '{"status":"failed","error":"服务未就绪"}'; } });
  assert.equal((await immediate.run('/api/profiles/p1/export')).status, 'failed');
  assert.equal(immediate.win.__wwExportResult, undefined);
});

test('普通手机浏览器：没有原生桥时仍只提示下载已发起', () => {
  const h = harness(undefined);
  const out = h.run('/api/profiles/p1/export');
  assert.equal(out.status, 'started');
  assert.deepEqual(h.downloads, ['/api/profiles/p1/export']);
  assert.match(h.messages.at(-1).message, /浏览器无法确认/);
});
