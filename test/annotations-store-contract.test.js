/**
 * annotations-store-contract.test.js — 标注存储「写入入口」契约（FIX-14 回归）
 *
 * 背景：AnnotationStore 上曾有 putSync()——它在「每文件串行队列」之外同步完成
 * 读-校验-写（`_read` → revision 校验 → 合并 → writeFileSync+renameSync），
 * 而入队的 put()/clearSeat() 才是唯一能保证「读-校验-写原子」的路径。
 * 两者并发时双方都能通过 revision 校验、后写整份覆盖先写（审核 P2-6 同型竞态）。
 * 生产代码已无调用者（PUT 路由在 FIN-07 收口时改为 `await put()`），但入口留在原型上
 * 就是一个"下一个顺手复用的人"的回归陷阱 —— 所以这里把「入口不存在」钉成契约。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { AnnotationStore } = require('../src/annotations/store');

const ROOT = path.join(__dirname, '..');

/** 递归列出 src/ 下的所有 .js（用于"整层不得再有定义/调用"的复核） */
function listSrcFiles(dir = path.join(ROOT, 'src')) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSrcFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

test('FIX-14：AnnotationStore 不再暴露 putSync（绕开串行队列的同步写入口）', (t) => {
  // NEW-17：原来把 profilesRoot 钉成 os.tmpdir()/ww-fix14-unused —— 那是**全机共享固定路径**，
  // 并行全量下的同形态写点会互相抢写。改成用例独占 dataDir（本用例只查原型，不落盘，属预防性隔离）。
  const { cleanupAfter, makeDataDir } = require('./helpers-tmpdir');
  const dataDir = cleanupAfter(t, makeDataDir('fix14-unused'));
  const store = new AnnotationStore({ profilesRoot: path.join(dataDir, 'profiles') });
  assert.strictEqual(typeof store.putSync, 'undefined', 'putSync 必须已删除：它在队列外同步写，复用即带回 P2-6 竞态');
  assert.strictEqual('putSync' in store, false, 'putSync 不得以任何形式留在原型链上（含继承/别名）');
  // 正向对照：入队的异步入口必须在（否则就是"删过头"，两种写语义都没了）
  assert.strictEqual(typeof store.put, 'function');
  assert.strictEqual(typeof store.clearSeat, 'function');
});

test('FIX-14：src/ 全层不得再定义或调用 putSync（换名/加回来都会被这条挡住）', () => {
  const offenders = [];
  for (const file of listSrcFiles()) {
    const code = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    // 定义：行首（可缩进）的 putSync(...) 方法；调用：xxx.putSync(...)
    if (/^\s*putSync\s*\(/m.test(code)) offenders.push(`${rel}：定义了 putSync`);
    if (/\.putSync\s*\(/.test(code)) offenders.push(`${rel}：调用了 putSync`);
  }
  assert.deepStrictEqual(offenders, [], '写路径有且只有入队的 put()/clearSeat()');
});
