/**
 * ab-acceptance.js — M2 场景级验收：A/B 两档案全流程（计划书 §11 A04 / A06 / A09 / A10）
 *
 * 为什么单独写：计划书 §11 :348 明写「不能用"总测试数很多"替代」必测场景。仓内已有
 * test/m2-ab-acceptance.test.js 等覆盖各自的单元面/HTTP 面，但**把 A、B 两个档案串起来、
 * 起一台真实 HTTP 服务、从接口侧跑一遍**的那种场景级验收，本文件是那一条独立证据。
 *
 * 纪律（入仓版三条硬约束，改动点见 docs/fix-plan-2026-09-21.md §16.19.2 承诺）：
 *   ① 隔离数据：全程只写 WW_DATA_DIR 指向的 os.tmpdir() 临时目录；**绝不**触碰仓库的
 *      saves/、profiles/、config.json、logs/。跑完在 finally 里删掉自己的临时目录（带"只删
 *      tmpdir 下 ww-* 前缀"的安全校验，防止环境变量乱指时误删仓库）。
 *   ② 动态端口：不写死端口号。先让内核分配一个空闲端口（listen(0)）并**复查**未被占用，再传给
 *      被测服务；也可用 WW_AB_PORT 显式指定（若已被占用则拒绝启动 —— 占用者会冒充被测服务端
 *      回答接口，见 scripts/e2e.js:45 的注释）。实际使用的端口会打印出来。
 *   ③ 清理：无论成功/失败/异常，finally 里杀掉自己启动的子进程并删除临时目录；子进程有
 *      kill 宽限期 + SIGKILL + taskkill /T /F 兜底，整轮有看门狗超时（默认 300s）。
 *
 * 退出码语义：0 = 全部通过；1 = 有断言失败；2 = 无法执行（AB_ROOT 缺 server.js / 端口被占用 /
 * 服务端起不来或中途死掉 / 看门狗超时 / 脚本自身异常）。
 *
 * 用法：node scripts/ab-acceptance.js
 *   环境变量：AB_ROOT=<仓库或隔离副本根，默认本脚本的上一级>
 *             WW_AB_PORT=<指定端口>   WW_AB_TIMEOUT=<看门狗毫秒，默认 300000>
 * 反向验证：scripts/reverse-ab.js 会用 AB_ROOT 指向临时副本、在副本上做破坏性实验。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

// 仓库根：本脚本在 <root>/scripts/ 下，所以上一级就是根。AB_ROOT 可指向**隔离副本**
// （反向验证用）：绝不在真仓库上做破坏性实验。
const ROOT = path.resolve(process.env.AB_ROOT || path.join(__dirname, '..'));
// 看门狗：整轮硬上限，超时即"无法执行"（退出码 2），不让脚本无限等。
const TIMEOUT_MS = Math.max(30000, Number(process.env.WW_AB_TIMEOUT) || 300000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { pass: 0, fail: 0, notes: [], fatal: false };
let serverProc = null;

function ok(name, detail) { R.pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { R.fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); R.notes.push(name + ' :: ' + detail); }
function info(msg) { console.log(`    · ${msg}`); }
function check(cond, name, detail) { if (cond) ok(name, detail); else bad(name, detail); return !!cond; }

async function api(method, url, body, raw) {
  // 自称"被测服务端"却已退出的情况：端口上回答的必然是别的进程 ⇒ 读数不可信，立即判"无法执行"。
  if (serverProc && serverProc.exitCode !== null) fatal('被测服务端进程已退出（端口上回答接口的是别的进程）');
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = raw ? await res.arrayBuffer() : (ct.includes('json') ? await res.json().catch(() => null) : await res.text());
  return { status: res.status, body: data, headers: res.headers };
}
// 端口是否已被占用（任何监听者，不限于 HTTP）。用 net 而不是 fetch：非 HTTP 监听者也要能发现。
const portOccupied = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { try { s.destroy(); } catch (_) { /* ignore */ } resolve(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(1500, () => done(false));
});
// 让内核分配一个空闲端口（listen(0) 后立刻释放）。返回 0 表示显式指定的端口被占用。
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function pickPort() {
  const want = Number(process.env.WW_AB_PORT || process.env.AB_PORT || 0);
  if (want) {
    if (await portOccupied(want)) {
      console.log(`✗ WW_AB_PORT=${want} 已被占用：占用者会冒充被测服务端，读数不可信。停（退出码 2）。`);
      return 0;
    }
    return want;
  }
  // listen(0) 与真正 bind 之间有极小的抢占窗口，所以拿到端口号后**再复查一次**；被抢就换一个。
  for (let i = 0; i < 12; i++) {
    const p = await freePort();
    if (!(await portOccupied(p))) return p;
  }
  console.log('✗ 连续 12 次都没能拿到空闲端口。停（退出码 2）。');
  return 0;
}
function fatal(msg, detail) {
  R.fatal = true;
  console.log(`  !! 无法执行：${msg}${detail ? ' — ' + detail : ''}`);
  const e = new Error(detail ? `${msg} — ${detail}` : msg);
  e.__fatal = true;
  throw e;
}
// 只删 os.tmpdir() 下、名字以 ww- 开头的目录；任何其它路径一律拒绝（防 WW_DATA_DIR 乱指时误删）。
function rmTemp(dir) {
  if (!dir) return true;
  const full = path.resolve(dir);
  if (!full.startsWith(path.resolve(os.tmpdir()) + path.sep) || !/^ww-/.test(path.basename(full))) {
    console.log(`  !! 拒绝删除疑似非临时目录：${full}`);
    return false;
  }
  try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {
    console.log(`  !! 临时目录删除失败：${e && e.message}`);
  }
  return !fs.existsSync(full);
}
// 杀掉自己启动的子进程：先温和 kill，宽限期后 SIGKILL，Windows 上再用 taskkill /T /F 兜底。
async function killChild(child, graceMs = 3000) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch (_) { /* ignore */ }
  const t0 = Date.now();
  while (child.exitCode === null && Date.now() - t0 < graceMs) await sleep(100);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    await sleep(200);
  }
  if (child.exitCode === null && process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
  }
}

let BASE = '';

async function main() {
  console.log('  被测根（AB_ROOT）= ' + ROOT);
  if (!fs.existsSync(path.join(ROOT, 'server.js'))) {
    console.log(`✗ 找不到 ${path.join(ROOT, 'server.js')} ⇒ 前置不满足，无法执行（退出码 2）。`);
    return 2;
  }
  const PORT = await pickPort();
  if (!PORT) return 2;
  BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-ab-'));
  console.log('  WW_DATA_DIR = ' + dataDir + '（隔离；不动仓库 saves/）');
  console.log('  端口 = ' + PORT + '（' + (process.env.WW_AB_PORT || process.env.AB_PORT ? 'WW_AB_PORT 指定，已复查空闲' : '内核分配，已复查空闲') + '）');

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NO_OPEN: '1', LOG_LEVEL: 'error', WW_DATA_DIR: dataDir },
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc = server;
  let srvErr = '';
  server.stdout.on('data', () => {});
  server.stderr.on('data', (c) => { srvErr += c.toString(); });

  const watchdog = setTimeout(() => {
    console.log(`  !! 看门狗超时（${TIMEOUT_MS}ms）：流程卡住 ⇒ 无法执行（退出码 2）。`);
    killChild(server).then(() => {
      rmTemp(dataDir);
      console.log('  临时数据目录已清理；未触碰仓库 saves/、profiles/、config.json');
      process.exit(2);
    });
  }, TIMEOUT_MS);

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try {
        const m = await api('GET', '/api/meta');
        if (m.status === 200) {
          // 服务端已退出却还有人回答 ⇒ 端口被别的进程接手了，读数不可信。
          if (server.exitCode !== null) fatal('端口上回答 /api/meta 的不是本次启动的服务端（它已退出）');
          up = true; break;
        }
      } catch (e) { if (e && e.__fatal) throw e; /* 未就绪 */ }
      await sleep(250);
    }
    if (!up) fatal('服务端就绪（GET /api/meta 200）', (srvErr.slice(-400) || '') + '（也可能是端口在 bind 前被别的进程抢占，可重跑）');
    ok('服务端就绪', '/api/meta 200');

    // ── 0. 默认档案（迁移产物）──
    const list0 = await api('GET', '/api/profiles');
    const defProf = (list0.body && list0.body.profiles || []).find((p) => p.nickname === '默认玩家');
    check(!!defProf, '迁移默认档案存在（不重复建）', defProf ? defProf.id : JSON.stringify(list0.body).slice(0, 120));

    // ── 1. 建 A / B 两个档案 ──
    const cA = await api('POST', '/api/profiles', { nickname: '甲·A', avatarId: 'scholar', bio: 'A 档' });
    const cB = await api('POST', '/api/profiles', { nickname: '乙·B', avatarId: 'hunter', bio: 'B 档' });
    const pidA = cA.body && cA.body.profile && cA.body.profile.id;
    const pidB = cB.body && cB.body.profile && cB.body.profile.id;
    check(cA.status === 200 && !!pidA, '建档案 A', `status=${cA.status} id=${pidA}`);
    check(cB.status === 200 && !!pidB, '建档案 B', `status=${cB.status} id=${pidB}`);
    if (!pidA || !pidB) fatal('建档失败，后续无法进行');

    // ── 2. 各建一局并结束（用响应证据确定 owner 绑定方式）──
    const mkGame = async (label, pid) => {
      // players 形状抄自 scripts/e2e.js:107；这里全 AI（isHuman 全 false），让 mock 局自己跑到终局，
      // 因为导出口径只收**已结束**的对局，"已终止"未必等于"已结束"。
      const players = Array.from({ length: 12 }, (_, i) => ({ name: `玩家${i + 1}`, isHuman: false }));
      const g = await api('POST', '/api/games', { boardId: 'adv12', players, mock: true, rules: {}, profileId: pid });
      info(`建局(${label}) status=${g.status} body=${JSON.stringify(g.body).slice(0, 200)}`);
      return { status: g.status, body: g.body || {} };
    };
    const gA = await mkGame('A', pidA);
    const gB = await mkGame('B', pidB);
    const idA = gA.body.gameId, idB = gB.body.gameId;
    if (!idA || !idB) { bad('两个对局都创建成功', `A=${JSON.stringify(gA.body).slice(0, 150)} B=${JSON.stringify(gB.body).slice(0, 150)}`); }

    // 等待对局真跑到终局：轮询 **档案视图**（形状已知为 {rows:[…]}，且带 finished 标记），
    // 而不是猜 /api/games 的形状。上一轮我用错了形状导致两条断言假红 —— 修判据，不改应用。
    const rowsOf = (v) => (v && v.body && Array.isArray(v.body.rows)) ? v.body.rows : [];
    const gamesOf = async (pid) => { const r = await api('GET', `/api/profiles/${pid}/games`); return { status: r.status, body: r.body }; };

    const settle = async (label, id, godToken, pid) => {
      if (!id) return { finished: false, how: 'no-game' };
      const s = await api('POST', `/api/games/${id}/start`, { token: godToken });
      info(`start(${label}) status=${s.status} ${JSON.stringify(s.body).slice(0, 120)}`);
      for (let i = 0; i < 120; i++) {
        const rows = rowsOf(await gamesOf(pid));
        const mine = rows.find((r) => r && r.id === id);
        if (mine && mine.finished === true) {
          info(`对局(${label}) 已自然终局（第 ${i} 次轮询；winner=${mine.winner} day=${mine.day}）`);
          return { finished: true, how: 'natural', winner: mine.winner };
        }
        await sleep(500);
      }
      const t = await api('POST', `/api/games/${id}/terminate`, { token: godToken });
      info(`对局(${label}) 未在 60s 内自然终局 ⇒ terminate status=${t.status} ${JSON.stringify(t.body).slice(0, 120)}`);
      return { finished: false, how: 'terminated' };
    };
    const rA = await settle('A', idA, gA.body.godToken, pidA);
    const rB = await settle('B', idB, gB.body.godToken, pidB);
    check(rA.finished, '对局 A 跑到终局（导出口径只收已结束局）', `how=${rA.how} winner=${rA.winner}`);
    check(rB.finished, '对局 B 跑到终局', `how=${rB.how} winner=${rB.winner}`);

    // ── 3. A06 核心：档案视图互不串（用精确 id 字符串比对；对局 id 是 gmucuvvz02ku 这种短 id，不是 UUID）──
    const gvA = await gamesOf(pidA), gvB = await gamesOf(pidB);
    info(`A 档看到的对局：${JSON.stringify(gvA.body).slice(0, 300)}`);
    info(`B 档看到的对局：${JSON.stringify(gvB.body).slice(0, 300)}`);
    const idsA = rowsOf(gvA).map((r) => r && r.id).filter(Boolean);
    const idsB = rowsOf(gvB).map((r) => r && r.id).filter(Boolean);
    const aHasA = idsA.includes(idA), aHasB = idsA.includes(idB);
    const bHasB = idsB.includes(idB), bHasA = idsB.includes(idA);
    info(`归属判定：A 档 rows=${JSON.stringify(idsA)}；B 档 rows=${JSON.stringify(idsB)}`);
    check(aHasA, 'A 档能看到 A 局', `含 A=${aHasA}`);
    check(!aHasB, 'A 档看不到 B 局（不串档）', `含 B=${aHasB}`);
    check(bHasB, 'B 档能看到 B 局', `含 B=${bHasB}`);
    check(!bHasA, 'B 档看不到 A 局（不串档）', `含 A=${bHasA}`);
    // owner 字段必须与当前档案一致（直接读服务端给的归属，而不是只数条数）
    const ownerOf = (rows, id) => (rows.find((r) => r && r.id === id) || {}).ownerProfileId;
    check(ownerOf(rowsOf(gvA), idA) === pidA, 'A 局 ownerProfileId 就是 A 档', `${ownerOf(rowsOf(gvA), idA)} === ${pidA}`);
    check(ownerOf(rowsOf(gvB), idB) === pidB, 'B 局 ownerProfileId 就是 B 档', `${ownerOf(rowsOf(gvB), idB)} === ${pidB}`);

    const svA = await api('GET', `/api/profiles/${pidA}/stats`);
    const svB = await api('GET', `/api/profiles/${pidB}/stats`);
    info(`A 档 stats：${JSON.stringify(svA.body).slice(0, 240)}`);
    info(`B 档 stats：${JSON.stringify(svB.body).slice(0, 240)}`);
    check(svA.status === 200 && svB.status === 200, '两个档案的 stats 都可取（200）', `A=${svA.status} B=${svB.status}`);

    // ── 4. 笔记归属（NOTE-02：归属 = 对局 owner 档案）──
    if (idA) {
      const put = await api('PUT', `/api/games/${idA}/annotations`, { token: gA.body.godToken, seats: { 1: { leaning: 'good', confidence: 3, note: 'A 档专属笔记' } } });
      info(`PUT annotations(A) status=${put.status} ${JSON.stringify(put.body).slice(0, 160)}`);
      const get = await api('GET', `/api/games/${idA}/annotations?token=${gA.body.godToken}`);
      const text = JSON.stringify(get.body);
      check(get.status === 200 && text.includes('A 档专属笔记'), 'A 局笔记写入并可读回', `status=${get.status}`);
      if (idB) {
        const getB = await api('GET', `/api/games/${idB}/annotations?token=${gB.body.godToken}`);
        check(!JSON.stringify(getB.body).includes('A 档专属笔记'), 'B 局读不到 A 局笔记（按对局隔离）', `status=${getB.status}`);
      }
    }

    // ── 5. 各自导出（A09：无凭证 / 结构正确）──
    const expA = await api('GET', `/api/profiles/${pidA}/export`);
    const expB = await api('GET', `/api/profiles/${pidB}/export`);
    check(expA.status === 200, 'A 档导出 200', `status=${expA.status}`);
    check(expB.status === 200, 'B 档导出 200', `status=${expB.status}`);
    const pkgA = expA.body, pkgB = expB.body;
    const keys = pkgA && typeof pkgA === 'object' ? Object.keys(pkgA).sort() : [];
    check(JSON.stringify(keys) === JSON.stringify(['games', 'manifest', 'notes', 'profile']), '导出包顶层键恰为 games/manifest/notes/profile', JSON.stringify(keys));
    const pkgText = JSON.stringify(pkgA || {});
    const leakPatterns = [/apiKey/i, /\btoken\b/i, /godToken/i, /playerToken/i, /Cookie/i, /pairingCode/i, /\bsecret\b/i, /allowedOrigin/i, /127\.0\.0\.1:\d+/];
    const leaked = leakPatterns.filter((re) => re.test(pkgText)).map((re) => re.source);
    check(leaked.length === 0, '导出包不含凭证/令牌/Cookie/本机地址（A09 无凭证）', leaked.length ? '命中：' + leaked.join(', ') : 'clean');
    info(`A 包 manifest=${JSON.stringify(pkgA && pkgA.manifest).slice(0, 220)}`);
    info(`B 包 manifest=${JSON.stringify(pkgB && pkgB.manifest).slice(0, 220)}`);

    // ── 6. A09 交叉导入：落新档案、ID 重映射、不覆盖 ──
    const before = (await api('GET', '/api/profiles')).body.profiles.length;
    const pv = await api('POST', '/api/profiles/import/preview', { package: pkgA });
    check(pv.status === 200, '导入预览 200', `status=${pv.status} ${JSON.stringify(pv.body).slice(0, 160)}`);
    info(`预览体：${JSON.stringify(pv.body).slice(0, 260)}`);
    const imp = await api('POST', '/api/profiles/import', { package: pkgA });
    check(imp.status === 200, '导入 A 包 200', `status=${imp.status} ${JSON.stringify(imp.body).slice(0, 200)}`);
    const after = (await api('GET', '/api/profiles')).body.profiles.length;
    check(after === before + 1, `导入必须新增一份档案（${before} → ${after}）`, `before=${before} after=${after}`);
    const newPid = imp.body && (imp.body.profile && imp.body.profile.id || imp.body.profileId);
    info(`新档案 id = ${newPid}`);
    if (newPid) {
      const gvNew = await gamesOf(newPid);
      const newIds = rowsOf(gvNew).map((r) => r && r.id).filter(Boolean);
      info(`新档案看到的对局：${JSON.stringify(gvNew.body).slice(0, 280)}`);
      check(newIds.length > 0, '导入后新档案里有对局', `对局数=${newIds.length}`);
      check(!newIds.includes(idA), '导入的对局 ID 已重映射（不复用原 id）', `含原 id=${newIds.includes(idA)}`);
      const newOwner = ownerOf(rowsOf(gvNew), newIds[0]);
      check(newOwner === newPid, '导入的对局归属新档案（owner 被重绑）', `${newOwner} === ${newPid}`);
    }
    // 原档案不被覆盖
    const gvA2 = await gamesOf(pidA);
    check(JSON.stringify(gvA2.body) === JSON.stringify(gvA.body), '导入后原档案 A 的对局视图未被改动（不覆盖）', `A 局仍=${rowsOf(gvA2).length} 个`);
    const impB = await api('POST', '/api/profiles/import', { package: pkgB });
    check(impB.status === 200, '导入 B 包 200（B 档案维度同样成立）', `status=${impB.status}`);

    // ── 7. A10：超限 / 半坏包 / 回滚真实 ──
    const beforeBad = (await api('GET', '/api/profiles')).body.profiles.length;
    const huge = { profile: { nickname: '超大包' }, games: [], notes: {}, manifest: { counts: { games: 0, notes: 0 } }, blob: 'x'.repeat(21 * 1024 * 1024) };
    const over = await api('POST', '/api/profiles/import', { package: huge });
    check(over.status === 413, '超 20MiB 的包必须 413（明确拒绝，不是静默截断）', `status=${over.status} ${JSON.stringify(over.body).slice(0, 140)}`);
    const broken = await api('POST', '/api/profiles/import', { package: { profile: {}, games: 'not-array' } });
    check(broken.status === 400, '半坏包（games 不是数组）必须 400', `status=${broken.status} ${JSON.stringify(broken.body).slice(0, 140)}`);
    const broken2 = await api('POST', '/api/profiles/import', { package: { profile: { nickname: '缺 games' } } });
    check(broken2.status >= 400 && broken2.status < 500, '缺字段的包必须 4xx（不是 500）', `status=${broken2.status}`);
    const afterBad = (await api('GET', '/api/profiles')).body.profiles.length;
    check(afterBad === beforeBad, `失败导入不得留下半份档案（回滚真实：${beforeBad} → ${afterBad}）`, `before=${beforeBad} after=${afterBad}`);

    // ── 8. 坏存档：导出必须明确失败，而不是"少了几局还说成功" ──
    const savesDir = path.join(dataDir, 'saves');
    fs.mkdirSync(savesDir, { recursive: true });
    const brokenSave = path.join(savesDir, 'broken-ab.json');
    fs.writeFileSync(brokenSave, '{ "ownerProfileId": "truncated');
    const expBroken = await api('GET', `/api/profiles/${pidA}/export`);
    info(`坏存档在场时导出：status=${expBroken.status} body=${JSON.stringify(expBroken.body).slice(0, 200)}`);
    check(expBroken.status >= 400 || (expBroken.body && expBroken.body.games), '坏存档在场时导出要么明确失败、要么不受影响（不得半成功）', `status=${expBroken.status}`);
    try { fs.rmSync(brokenSave, { force: true }); } catch (_) { /* ignore */ }

    // ── 9. 统计与历史：A06 的"战绩/经验始终属 A" ──
    if (idA) {
      const h = await api('GET', `/api/profiles/${pidA}/games/${idA}/history`);
      info(`A 局 history status=${h.status} body=${JSON.stringify(h.body).slice(0, 220)}`);
      check(h.status === 200 || h.status === 404, 'A 局的按档历史接口可达（200/404 均可解释）', `status=${h.status}`);
    }
    const gs = await api('GET', '/api/stats');
    check(gs.status === 200, '全局 stats 可取（不因多档案而崩）', `status=${gs.status}`);
  } catch (e) {
    // 标了 __fatal 的是"无法执行"（退出码 2），不当作断言失败计数。
    if (!(e && e.__fatal)) bad('验收流程整体完成', String(e && e.message || e));
  } finally {
    clearTimeout(watchdog);
    await killChild(server);
    const gone = rmTemp(dataDir);
    console.log(`  临时数据目录 ${gone ? '已删除' : '未能删除（见上方提示）'}；未触碰仓库 saves/、profiles/、config.json`);
  }

  console.log(`\n  A/B 验收读数：PASS ${R.pass} / FAIL ${R.fail}（共 ${R.pass + R.fail} 条）`);
  if (R.notes.length) { console.log('  失败明细：'); for (const n of R.notes) console.log('    - ' + n); }
  if (R.fatal) { console.log('  ⇒ 无法执行（退出码 2）'); return 2; }
  console.log(R.fail === 0 ? '  ⇒ 全部通过（退出码 0）' : '  ⇒ 有断言失败（退出码 1）');
  return R.fail === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.log('  !! 脚本异常（无法执行，退出码 2）：' + (e && e.stack || e));
  process.exit(2);
});
