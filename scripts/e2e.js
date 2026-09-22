/**
 * e2e.js — 端到端验证：启动真实 HTTP 服务，以人类玩家身份通过 REST 打完整局 mock 游戏
 * 验证：静态页、meta/config 接口、创建/开局、人类 pending 流程、结算、上帝接口、存档。
 * 用法：node scripts/e2e.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 数据目录隔离（必须）：不隔离就会把存档/档案/日志/配置写进仓库的 saves/、profiles/、logs/
// 和 config.json —— 其中 saves/ 是用户的真实存档（禁动）。server.js 支持 WW_DATA_DIR
// （见 server.js:14/:20/:28），它会同时搬走 config.json、logs/、saves/、profiles/，
// 所以这里连"跑前备份 config.json、跑完再还原"都不需要了（那段旧代码已随之删除）。
// 见 main()：端口预检通过后才真正创建（预检提前 return 时不会漏下空目录）
let DATA_DIR = null;

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// 端口是否已被占用（任何监听者，不限于 HTTP）。用 net 而不是 fetch：非 HTTP 监听者也要能发现。
const portOccupied = () => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: PORT });
  const done = (v) => { try { s.destroy(); } catch (_) { /* ignore */ } resolve(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(1500, () => done(false));
});

async function main() {
  // 端口预检（必须）：若 3997 已被占用，下面 spawn 的服务端起不来，而**占用者会替它回答**
  // GET / 和所有接口 —— 实测"真·残留 server.js"占着该端口时本脚本 21/21 全过（假绿），
  // 门禁因此彻底失效（旧版留下的孤儿服务端就是这么让本脚本时绿时红的，它用仓库根做数据
  // 目录，还会把对局写进真实 saves/）。所以端口不空就绝不继续，直接失败退出。
  if (await portOccupied()) {
    console.error(`✗ 端口 ${PORT} 已被占用，无法保证被测的是本次启动的服务端（占用者会冒充它回答接口）。`);
    console.error('  请先结束占用该端口的进程（常见来源：上一次异常退出的 e2e 留下的孤儿 node server.js）后重试。');
    process.exitCode = 1;
    return;
  }
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-e2e-'));
  let failures = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✔' : '✗'} ${name}`);
    if (!cond) failures++;
  };

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NO_OPEN: '1', LOG_LEVEL: 'debug', WW_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    // 等服务就绪
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await sleep(300);
      try { await fetch(BASE + '/'); up = true; } catch (_) { /* retry */ }
    }
    check('服务启动', up);

    const html = await fetch(BASE + '/').then((r) => r.text());
    check('静态页面包含游戏标题', html.includes('AI 狼人杀'));

    const mHtml = await fetch(BASE + '/m/').then((r) => r.text());
    // 判据同时钉"容器 + 步骤标题"：删掉板子选择界面会红，改文案也会红（逼着同步改断言）。
    // 原先查的是 '选择你的战场' —— 那个串自 78c1c17（手机半边那批）起就不在 web/m/index.html 里了，
    // 这条断言因此长期假红（改了页面文案却没同步改断言）。真值见 web/m/index.html 的
    // `<div id="m-board-grid" …>` 与 `<h3 …>… 选择板子</h3>`。
    check('APP 端页面可用（板子选择）',
      mHtml.includes('id="m-board-grid"') && mHtml.includes('选择板子'),
      `board-grid=${mHtml.includes('id="m-board-grid"')} label=${mHtml.includes('选择板子')}`);
    const uaRes = await fetch(BASE + '/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Mobile' },
      redirect: 'manual',
    });
    check('移动 UA 自动跳转 APP 端', uaRes.status === 302 && (uaRes.headers.get('location') || '').includes('/m'));

    const meta = await api('GET', '/api/meta');
    check('meta：角色≥9', Object.keys(meta.roles).length >= 9);
    check('meta：规则开关≥16', meta.ruleMeta.length >= 16);
    check('meta：名字库下发', Array.isArray(meta.names) && meta.names.length >= 120);
    check('meta：角色卡图占位已就绪', meta.roleArt && Object.keys(meta.roleArt).length >= 9);

    // 配置（e2e 用 mock，不需要真实 key）
    await api('PUT', '/api/config', { model: 'mock-model', baseUrl: 'https://example.invalid/v1' });
    const cfg = await api('GET', '/api/config');
    check('config 保存/掩码', cfg.model === 'mock-model' && typeof cfg.hasKey === 'boolean');

    // 创建 12 人局：座位 5 是人类
    const players = Array.from({ length: 12 }, (_, i) => ({ name: `玩家${i + 1}`, isHuman: i === 4 }));
    const g = await api('POST', '/api/games', { boardId: 'adv12', players, mock: true, rules: {} });
    check('创建对局', !!g.gameId && !!g.playerToken && !!g.godToken);

    await api('POST', `/api/games/${g.gameId}/start`, { token: g.godToken });

    // 人类玩家驱动对局到结束
    let after = 0;
    let view = null;
    let sawPending = false;
    let badSubmitRejected = false;
    let badSubmitMsg = '';
    let badSubmitKeptPending = false;
    const t0 = Date.now();
    for (;;) {
      await sleep(150);
      view = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken}&after=${after}`);
      after = Math.max(after, ...view.events.map((e) => e.seq));
      if (view.pending) {
        sawPending = true;
        const p = view.pending;
        // 对发言任务先试一次非法提交（空白文本），验证服务端校验拒绝且不消耗回合。
        // ⚠ 必须带上**正确的** pendingId：否则会先被 409 PENDING_ID_REQUIRED 挡下，
        //   这条探针就变成在测"缺 id"而不是在测"载荷校验"，覆盖被悄悄换掉但仍会绿。
        if (!badSubmitRejected && p.task === 'speech') {
          try {
            await api('POST', `/api/games/${g.gameId}/action`, { token: g.playerToken, pendingId: p.pendingId, payload: { text: '   ' } });
          } catch (e) {
            badSubmitMsg = String((e && e.message) || e).slice(0, 200);
            // 只认"载荷不合法"（400）为这条探针的成功；409（缺/错 id）说明它没测到该测的东西
            badSubmitRejected = /→ 400:/.test(badSubmitMsg);
          }
          // 不消耗回合：同一个 pendingId 必须还在等待（服务端拒绝必须零副作用）
          const vAfterBad = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken}&after=0`);
          badSubmitKeptPending = !!(vAfterBad.pending && vAfterBad.pending.pendingId === p.pendingId);
        }
        let payload = null;
        switch (p.task) {
          case 'speech': case 'pk_speech': case 'sheriff_speech': case 'lastwords': case 'wolf_propose':
            payload = { text: '大家好，我是好人。' };
            break;
          case 'night_guard': payload = { target: p.candidates[0] }; break;
          case 'wolf_kill': payload = { target: p.allowNone ? 0 : p.candidates[0] }; break;
          case 'seer_check': payload = { target: p.candidates[0] }; break;
          case 'witch': payload = { antidote: !!(p.extra && p.extra.canAntidote), poison: 0 }; break;
          case 'sheriff_run': payload = { run: true }; break;
          case 'sheriff_vote': payload = { target: p.candidates[0] }; break;
          case 'badge_pass': payload = { target: 0 }; break;
          case 'direction': payload = { direction: 'cw' }; break;
          case 'vote': case 'pk_vote': payload = { target: p.candidates[0] }; break;
          case 'shoot': payload = { target: 0 }; break;
          default: payload = {};
        }
        // 计划书 §6：新客户端必须提交 pendingId。若中途过期（例如同座位产生了新任务），
        // 刷新视图一次、保留同一份草稿、按新 id 重发一次；仍失败才算真失败。
        try {
          await api('POST', `/api/games/${g.gameId}/action`, { token: g.playerToken, pendingId: p.pendingId, payload });
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (!/→ 409:/.test(msg) || !/PENDING_ID_/.test(msg)) throw e;
          const vFresh = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken}&after=0`);
          if (!vFresh.pending || !vFresh.pending.pendingId) throw e;
          await api('POST', `/api/games/${g.gameId}/action`, { token: g.playerToken, pendingId: vFresh.pending.pendingId, payload });
        }
      }
      if (view.finished) break;
      if (Date.now() - t0 > 120000) throw new Error('e2e 超时：对局未在 120s 内结束');
    }
    check('人类 pending 流程走通（含非法提交被拒）', sawPending && badSubmitRejected);
    // 把探针的真实读数打出来：若它是被 409 挡下的，上面那条会红，这里给出原因
    check('非法提交是被"载荷校验"拒绝（400），而不是被"缺/错 pendingId"拒绝（409）',
      badSubmitRejected && /→ 400:/.test(badSubmitMsg), badSubmitMsg || '(探针未触发)');
    check('非法提交被拒后不消耗回合（同一个 pendingId 仍在等待）', badSubmitKeptPending);
    check('对局结束且有胜负', view.finished && ['good', 'wolf', 'draw'].includes(view.winner));
    check('人类能看到自己身份', view.me && !!view.me.role);

    // 人类视角泄漏检查（人类自己是狼时，狼聊事件对其可见属正常）
    const humanIsWolf = view.me && view.me.role && ['wolf', 'wolfking', 'whitewolfking'].includes(view.me.role);
    const leaks = view.events.filter((e) => {
      if (e.type === 'vote_cast') return !(Array.isArray(e.visibleTo) && e.visibleTo.length === 1 && e.visibleTo[0] === e.actor);
      if (['seer_check', 'witch_info', 'witch_action', 'night_guard'].includes(e.type)) {
        if (view.me.role === { seer_check: 'seer', witch_info: 'witch', witch_action: 'witch', night_guard: 'guard' }[e.type]) return false;
        return !(Array.isArray(e.visibleTo) && e.visibleTo.length === 1);
      }
      if (['wolf_propose', 'wolf_kill', 'wolf_kill_vote', 'teammates'].includes(e.type)) {
        if (humanIsWolf) return false; // 狼队成员可见
        return true; // 人类非狼却出现狼聊 = 泄漏
      }
      return false;
    });
    check('人类视角无私密事件泄漏', leaks.length === 0);

    // 上帝视角：全量事件 + 统计 + 智能体调试
    const godView = await api('GET', `/api/games/${g.gameId}/view?token=${g.godToken}&after=0`);
    check('上帝视角事件多于玩家视角', godView.events.length > view.events.length);
    check('上帝视角有 LLM/遥测统计', !!godView.llmStats);
    const aiSeat = godView.players.find((p) => !p.isHuman).seat;
    const agent = await api('GET', `/api/games/${g.gameId}/agent?token=${g.godToken}&seat=${aiSeat}`);
    check('上帝可查看 AI 上下文调试', agent.turns > 0 || agent.note);
    const logs = await api('GET', `/api/games/${g.gameId}/logs?token=${g.godToken}&after=0&level=info`);
    check('上帝可查询日志', Array.isArray(logs.rows) && logs.rows.length > 0);

    // 存档
    const saves = await api('GET', '/api/games');
    check('对局已存档', saves.rows.some((r) => r.id === g.gameId && r.finished));

    console.log(failures ? `\n✗ ${failures} 项未通过` : '\n全部端到端检查通过 ✓');
  } finally {
    // 必须**等子进程真的退出**再返回：server.js 收到 SIGTERM 后还要落盘活动对局
    // （server.js:80-83 的总闸是 4s），只 sleep(300) 就 process.exit 会留下一个仍在
    // 监听 3997 的孤儿服务端 —— 下一次 e2e 起不来，表现为最前面三条一起红
    //（服务启动 / 静态页面 / APP 端页面）。这正是本脚本此前"时绿时红"的根因。
    await new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode) return resolve();
      server.once('exit', resolve);
      server.kill();
      const t = setTimeout(resolve, 8000); // 兜底：绝不让脚本挂死（真挂死也要能失败退出）
      if (t.unref) t.unref(); // 子进程已退出时别让这个定时器把进程多留 8 秒
    });
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 清不掉不致命，且 tmp:residue 会看得见 */ }
  }
  console.log(failures ? `✗ ${failures} 项未通过` : '（检查已在上方逐项列出）');
  // 刻意不用 process.exit()：Node 24 在 Windows 上若在子进程 stdio 句柄尚未关闭时强退，
  // libuv 会断言失败（实测崩溃码 0xC0000409，现场 src\win\async.c line 76）。设 exitCode
  // 让进程在所有句柄释放后自然退出，失败信号一样清晰（退出码仍是 1）。
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error('e2e 异常：', e); process.exitCode = 1; });
