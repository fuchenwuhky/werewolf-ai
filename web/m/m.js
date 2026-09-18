/**
 * m.js — AI 狼人杀 APP 端（手机专属页面）
 * 完整对局玩法；无上帝模式/日志/上下文调试/观战等调试功能。
 * 通过相对路径调用同一套 REST API，可直接被 WebView/Capacitor 打包为安卓应用。
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };

const state = {
  meta: null, view: null,
  boardId: 'adv12', boardCounts: null,
  rules: null, mode: 'play',
  game: null, playerAfter: 0, pollTimer: null,
  // SSE 推送（P2-2）：连接 + 看门狗时间戳（断流即回退轮询）
  stream: null, streamWatchdog: null, lastStreamAt: 0,
  roleShown: false, seatNames: {}, tags: {}, lastNightStep: null,
  speakingSeat: 0,
};
const PHASE_LABEL = { setup: '开局', night: '夜晚', dawn: '天亮', sheriff: '警长竞选', speech: '白天发言', vote: '放逐投票', pk: 'PK 环节', over: '结算' };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const roleInfo = (rid) => state.meta.roles[rid];
// 安全（整改 SEC-02）：昵称是用户可控输入，seatLabel 的返回值只用于 innerHTML 模板，源头转义
const seatLabel = (seat) => { const raw = state.seatNames[seat] || ''; const n = escapeHtml(raw); return `${seat}号${n && n !== `${seat}号` ? ' ' + n : ''}`; };
const isMine = (e) => state.view && state.view.me && e.actor === state.view.me.seat;

// ---------------- 屏1：板子选择 ----------------
async function init() {
  state.meta = await api('GET', '/api/meta');
  state.rules = JSON.parse(JSON.stringify(state.meta.defaultRules));
  applyBoard('adv12');
  renderBoardGrid();
  wireSettings();
  $('#m-next').addEventListener('click', gotoRules);
  $('#m-back').addEventListener('click', () => showScreen('m-boards'));
  $('#m-start').addEventListener('click', startGame);
  // P2-b：试玩开关必须一眼可见。它原来只藏在「⚙ 设置」弹窗最底下，
  // 实测出现过"以为在试玩、其实在花额度"（设置弹窗里的勾选状态看不见）。
  if ($('#m-mock-btn')) {
    $('#m-mock-btn').addEventListener('click', () => {
      state.mock = !state.mock;
      syncMockBtn();
      flash(state.mock
        ? '🧪 已切换为 Mock 试玩：不调用 API、不消耗额度'
        : '💳 已切换为真实对局：会调用 API 并消耗额度');
    });
    syncMockBtn();
  }
  $('#m-gear').addEventListener('click', openGear);
  $('#m-codex-btn').addEventListener('click', openCodex);
  $('#m-codex-back').addEventListener('click', closeCodex);
  $('#m-rulebook-btn').addEventListener('click', openRulebook);
  $('#m-mycard').addEventListener('click', showMyCard);
  $('#m-to-bottom').addEventListener('click', () => { scrollFlow(true); });
  $('#m-flow').addEventListener('scroll', onFlowScroll);
  $('#m-my-seat').addEventListener('change', () => {
    try { localStorage.setItem('ww_seat', $('#m-my-seat').value); } catch (_) { /* 隐私模式忽略 */ }
    renderSeatSelect();
  });
  $('#m-inspect-btn').addEventListener('click', () => state.view && state.view.me && openInspect(state.view.me.role));
  $('#m-flip-card').addEventListener('click', () => $('#m-flip-card').classList.add('flipped'));
  $('#m-flip-done').addEventListener('click', () => $('#m-flip').classList.add('hidden'));
  tryResume();
  window.__wwReady = true; // 放开 index.html 顶部那段"加载中"守卫
}

// ---------------- 齿轮菜单（设置 / 规则书 / 结束本局 / 退出） ----------------
/** 菜单项：对局中才有的项（结束本局）按状态显示 */
function openGear() {
  const v = state.view;
  // ⚠ 判定"是否在对局中"必须用 state.game（本地保存的对局句柄）：玩家视图 v 里
  // 没有 game 字段，用 v.game 会让"查看我的身份牌/结束本局"永远不出现（踩过一次）。
  const inGame = !!(state.game && state.game.gameId);
  const over = !!(v && v.finished);
  const rows = [];
  if (inGame && v && v.me && v.me.role) {
    rows.push(['🎴 查看我的身份牌', () => openInspect(v.me.role)]);
  }
  // 规则书已挪到顶栏右上角的专用按钮，齿轮里不再重复列一项
  rows.push(['⚙ 设置', () => openSettingsModal()]);
  rows.push([I18N.t('codex.entry'), () => openCodex()]);
  rows.push([`🌐 切换语言（当前${I18N.getLang() === 'en' ? ' English' : ' 中文'}）`, () => toggleLang()]);
  if (inGame && !over) {
    rows.push(['⏹ 结束本局', () => askTerminate()]);
  } else {
    rows.push(['🏠 返回首页', () => { localStorage.removeItem('mww_current'); location.reload(); }]);
  }
  // 必须传**无类名的普通容器**：openModal 会把它 unwrap，只保留自己那一层 .modal。
  // 传 el('div','modal') 会多套一层 position:fixed 的内层 .modal（脱离文档流），
  // 外层 .modal 于是没有在流内容 → 塌成两条边框（2px）——真机上就是"点开只有一条线"。
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', '⚙ 设置'));
  const box = el('div', 'gear-list');
  rows.forEach(([label, fn]) => {
    const b = el('button', 'gear-item' + (/结束本局/.test(label) ? ' danger' : ''), label);
    b.addEventListener('click', () => { $('#m-modal').innerHTML = ''; fn(); });
    box.appendChild(b);
  });
  wrap.appendChild(box);
  wrap.appendChild(el('p', 'hint', inGame
    ? `对局 ${state.game.gameId}${v && v.day ? ` · 第 ${v.day} 天` : ''}${over ? ' · 已结算' : ''}`
    : ''));
  const close = el('button', 'btn ghost', '关闭');
  close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  wrap.appendChild(close);
  openModal(wrap);
}

function askTerminate() {
  // 必须传**无类名的普通容器**：openModal 会把它 unwrap，只保留自己那一层 .modal。
  // 传 el('div','modal') 会多套一层 position:fixed 的内层 .modal（脱离文档流），
  // 外层 .modal 于是没有在流内容 → 塌成两条边框（2px）——真机上就是"点开只有一条线"。
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', '⏹ 结束本局'));
  wrap.appendChild(el('p', null, '结束后本局不可恢复，将直接结算并公开所有身份。确定要结束吗？'));
  const row = el('div', 'btnrow');
  const yes = el('button', 'btn danger', '确定结束');
  yes.addEventListener('click', () => { $('#m-modal').innerHTML = ''; terminateGame(); });
  const no = el('button', 'btn', '取消');
  no.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  row.append(yes, no);
  wrap.appendChild(row);
  openModal(wrap);
}

/**
 * 对局内设置弹窗。
 *
 * 旧版这里只有一句"配置在首页改" + 两个按钮，正文极空 —— 用户反馈"点开设置只有一条线"；
 * 而齿轮里的入口却写着「接口 / 模型 / 节奏」，名不副实。
 * 现在：① 列出本局信息；② 给真正能立刻用的快捷入口；③ 接口/模型/节奏说明清楚
 * **为什么**对局中改不了（开局时参数已发给各 AI），并给一条真路（回首页改，本局会保存）。
 */
function openSettingsModal() {
  const v = state.view;
  const inGame = !!(state.game && state.game.gameId);
  // 必须传**无类名的普通容器**：openModal 会把它 unwrap，只保留自己那一层 .modal。
  // 传 el('div','modal') 会多套一层 position:fixed 的内层 .modal（脱离文档流），
  // 外层 .modal 于是没有在流内容 → 塌成两条边框（2px）——真机上就是"点开只有一条线"。
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', '⚙ 设置'));
  const body = el('div', 'mbody');

  if (inGame && v) {
    const alive = (v.players || []).filter((p) => p.alive).length;
    const me = v.me || {};
    const r = me.role ? roleInfo(me.role) : null;
    body.appendChild(el('div', 'setinfo', [
      `<div class="set-row"><span>对局</span><b>${escapeHtml(String(state.game.gameId))}</b></div>`,
      `<div class="set-row"><span>进度</span><b>第 ${v.day || 0} 天${v.finished ? ' · 已结算' : ''}</b></div>`,
      `<div class="set-row"><span>存活</span><b>${alive} 人</b></div>`,
      r ? `<div class="set-row"><span>我的身份</span><b>${escapeHtml(`${me.seat}号 ${r.name}`)}</b></div>` : '',
    ].join('')));
  } else {
    body.appendChild(el('p', 'hint', '当前不在对局中。'));
  }

  const list = el('div', 'gear-list');
  const add = (label, fn, danger) => {
    const b = el('button', 'gear-item' + (danger ? ' danger' : ''), label);
    b.addEventListener('click', () => { $('#m-modal').innerHTML = ''; fn(); });
    list.appendChild(b);
  };
  add(I18N.t('codex.entry'), () => openCodex());
  if (inGame && v && v.me && v.me.role) add('🎴 查看我的身份牌', () => openInspect(v.me.role));
  add(`🌐 切换语言（当前${I18N.getLang() === 'en' ? ' English' : ' 中文'}）`, () => toggleLang());
  // 这条是"真路"而不是假开关：回首页 = 重载页面，本局存在浏览器里（mww_current），
  // 首页会出现"继续对局"卡片，所以可以放心去改设置再回来。
  add('⚙ 去首页改接口 / 模型 / 节奏（本局会保存）', () => { location.reload(); });
  body.appendChild(list);

  body.appendChild(el('p', 'hint', '接口 / 模型 / 节奏是服务端配置：各 AI 的参数在开局时就已经发给它，所以对局中改动不会影响正在进行的这一局（这就是它"看起来失效"的原因）。要调整请回首页设置 —— 本局会保存，随时能继续。'));
  wrap.appendChild(body);

  const row = el('div', 'btnrow');
  if (inGame && !(v && v.finished)) {
    const end = el('button', 'btn danger', '⏹ 结束本局');
    end.addEventListener('click', () => { $('#m-modal').innerHTML = ''; askTerminate(); });
    row.appendChild(end);
  }
  const home = el('button', 'btn danger', '🏠 退出到首页（放弃本局）');
  home.addEventListener('click', () => { $('#m-modal').innerHTML = ''; localStorage.removeItem('mww_current'); location.reload(); });
  row.appendChild(home);
  wrap.appendChild(row);
  openModal(wrap);
}

/** 切换界面语言：不刷新页面（局中刷新会打断对局），I18N.setLang 会立刻重刷所有 data-i18n 节点 */
function toggleLang() {
  const next = I18N.getLang() === 'en' ? 'zh-CN' : 'en';
  I18N.setLang(next);
  // 图鉴内容是 JS 拼的（分区标题、徽记、AI 打法），不跟着 data-i18n 自动重刷
  if (!$('#m-codex').classList.contains('hidden')) window.Codex.render();
  flash(next === 'en' ? 'Language: English' : '界面语言：中文');
}

/**
 * 本局总结（手机端）。
 *
 * 为什么要有：桌面端一直有复盘面板（评分/MVP/终局真相），手机端结算后只有一句
 * "本局已结算"——用户反馈"手机端好像缺功能，至少结束后总结没有"。
 *
 * 数据全部来自服务端视图，不猜：v.score 是 computeScores(game) 的结果（api.js 在对局
 * 结束后才放进视图），终局身份在 finished 之后对所有座位可见。
 * 「AI 越玩越强」也首次在这里露出来：经验池取自 /api/stats 的 experiences，
 * 它由对局结束后的逐座位反思写入（api.js 的 experience.add），
 * 下一局开局时按角色注入 system 提示词（src/ai/experience.js）。
 */
async function openSummarySheet() {
  const v = state.view;
  if (!v) return;
  const me = v.me || {};
  const score = v.score || null;
  const mine = score && me.seat ? score.rows.find((r) => r.seat === me.seat) : null;
  // 必须传**无类名的普通容器**：openModal 会把它 unwrap，只保留自己那一层 .modal。
  // 传 el('div','modal') 会多套一层 position:fixed 的内层 .modal（脱离文档流），
  // 外层 .modal 于是没有在流内容 → 塌成两条边框（2px）——真机上就是"点开只有一条线"。
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', '📊 本局总结'));
  const body = el('div', 'mbody');

  const result = v.winner === 'good' ? '🎉 好人阵营获胜'
    : v.winner === 'wolf' ? '🐺 狼人阵营获胜'
      : v.winner === 'draw' ? '🤝 平局（未分胜负）' : '⏹ 对局终止';
  const rname = (rid) => (roleInfo(rid) || {}).name || rid;
  body.appendChild(el('div', 'setinfo', [
    `<div class="set-row"><span>结果</span><b>${escapeHtml(result)}</b></div>`,
    `<div class="set-row"><span>天数</span><b>第 ${v.day || 0} 天</b></div>`,
    mine ? `<div class="set-row"><span>我的身份</span><b>${escapeHtml(`${me.seat}号 ${rname(mine.role)}`)}${mine.alive ? '（存活）' : '（已出局）'}</b></div>` : '',
    mine ? `<div class="set-row"><span>我的评分</span><b>${mine.score} 分</b></div>` : '',
  ].join('')));
  if (v.winReason) body.appendChild(el('p', 'hint', escapeHtml(v.winReason)));

  // 得分构成：让分数看得懂（否则只是一个孤零零的数字）
  if (mine && (mine.details || []).length) {
    body.appendChild(el('h4', null, '我的得分构成'));
    const list = el('div', 'gear-list');
    for (const d of mine.details) {
      const pts = d.points != null ? d.points : d.score;
      list.appendChild(el('div', 'set-row', `<span>${escapeHtml(d.label || d.reason || '')}</span><b>${pts != null ? `${pts} 分` : ''}</b></div>`));
    }
    body.appendChild(list);
  }

  // 全员评分（含 MVP）：与桌面复盘面板同源，按分数降序
  if (score && (score.rows || []).length) {
    if (score.title) body.appendChild(el('p', 'hint', escapeHtml(score.title)));
    body.appendChild(el('h4', null, '评分排行'));
    const rank = el('div', 'gear-list');
    for (const r of score.rows) {
      const flag = me.seat === r.seat ? '（我）' : '';
      rank.appendChild(el('div', 'set-row', `<span>${r.seat}号 ${escapeHtml(rname(r.role))}${flag}</span><b>${r.score} 分</b></div>`));
    }
    body.appendChild(rank);
  }

  // 终局真相：对局结束后所有身份都可见，逐座位列出（复盘的基本盘）
  const truth = (v.players || []).map((p) => `${p.seat}号 ${p.role ? rname(p.role) : '未知'}`).join(' · ');
  if (truth) {
    body.appendChild(el('h4', null, '终局真相'));
    body.appendChild(el('p', 'hint', escapeHtml(truth)));
  }

  // AI 复盘文本（桌面端若已生成过就直接显示；否则按需生成 —— 会花一次模型调用，所以不自动跑）
  const rev = el('p', 'hint', (v.review && v.review.text) || '');
  rev.id = 'm-review-box';
  body.appendChild(rev);
  wrap.appendChild(body);
  const row = el('div', 'btnrow');
  const coach = el('button', 'btn', '🧠 生成 AI 复盘');
  coach.addEventListener('click', () => requestReview());
  row.appendChild(coach);
  const close = el('button', 'btn', '关闭');
  close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  row.appendChild(close);
  wrap.appendChild(row);
  openModal(wrap);
  body.appendChild(el('p', 'hint', '正在读取跨局经验池…'));
  const tail = body.lastChild;

  // 「AI 越玩越强」：经验池不是画饼——它在服务端真实存在且每局注入（见文件头注释）
  try {
    const st = await api('GET', '/api/stats');
    const exp = (st && st.experiences) || {};
    const entries = Object.entries(exp).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    tail.innerHTML = total
      ? `🧠 AI 越玩越强：跨局经验池已有 <b>${total}</b> 条教训（${entries.slice(0, 6).map(([rid, n]) => `${escapeHtml(rname(rid))} ${n}`).join(' · ')}）——下一局开局时会按角色注入对应 AI 的提示词。`
      : '🧠 AI 越玩越强：跨局经验池还是空的。完成几局（非 Mock）之后，各 AI 会把复盘教训沉淀进来，下一局开局时注入。';
  } catch (_) {
    tail.textContent = '';
  }
}

/**
 * 请求/查看 AI 复盘（手机端）：与桌面端同一个接口（POST /api/games/:id/review）。
 * 会花一次模型调用，所以做成显式按钮而不是自动触发。
 */
let reviewBusy = false;
async function requestReview() {
  const v = state.view;
  if (!v || !state.game) return;
  if (reviewBusy) return; // 整改 UX-01：防连点造成并发任务（服务端虽会去重，前端也不该刷）
  reviewBusy = true;
  const box = document.getElementById('m-review-box');
  if (box) box.textContent = '⏳ 正在生成复盘…';
  // 整改 UX-01：复盘链路整体修复 ——
  //   ① GET 必须携带玩家令牌（旧行为无令牌 GET → 稳定 403，永远停在"正在生成"）；
  //   ② POST 返回的是 202 式的"已受理"，生成是异步的 → 轮询到 done/error 才收尾；
  //   ③ 轮询带退避与总超时（约 90s），超时给出可重试提示而不是无限转圈。
  try {
    const token = state.game.playerToken;
    const first = await api('POST', `/api/games/${state.game.gameId}/review`, { token, seat: v.me ? v.me.seat : 0 });
    let review = null;
    if (first && first.status === 'done') {
      review = (await api('GET', `/api/games/${state.game.gameId}/review?token=${encodeURIComponent(token)}`) || {}).review;
    } else {
      const deadline = Date.now() + 90 * 1000;
      let delay = 2000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 1000, 5000); // 退避：2s 起步、封顶 5s
        const r = await api('GET', `/api/games/${state.game.gameId}/review?token=${encodeURIComponent(token)}`);
        review = r && r.review;
        if (review && (review.status === 'done' || review.status === 'error' || review.text)) break;
      }
    }
    const text = (review && review.text) || '';
    if (box) box.textContent = text || (review && review.status === 'running' ? '生成超时了（模型还没回话）。稍后再点一次按钮即可查看/重试。' : '复盘生成失败：模型没有返回内容。');
  } catch (e) {
    if (box) box.textContent = `复盘生成失败：${e.message}`;
  } finally {
    reviewBusy = false;
  }
}

/** 点身份牌：已经发过牌就直接亮正面，否则走翻牌浮层 */
function showMyCard() {
  if (!state.view || !state.view.me || !state.view.me.role) return;
  $('#m-flip').classList.remove('hidden');
  $('#m-flip-card').classList.add('flipped'); // 直接亮正面
}

/** 底部坞左侧的身份牌（常驻；旧版要点顶部 🎴 才看得到） */
function renderMyCard(v) {
  const box = $('#m-mycard');
  const me = v && v.me;
  if (!me || !me.role) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const sig = `${me.role}|${me.seat}|${me.alive}|${me.isSheriff}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const r = roleInfo(me.role);
  box.innerHTML = roleArtHtml(me.role);
  box.title = `我的身份牌：${me.seat}号 ${r.name}（点击查看）`;
}

function applyBoard(id) {
  state.boardId = id;
  const tpl = state.meta.boards[id];
  state.boardCounts = tpl ? { ...tpl.roles } : { ...state.boardCounts };
}

function renderBoardGrid() {
  const grid = $('#m-board-grid');
  grid.innerHTML = '';
  for (const b of Object.values(state.meta.boards)) {
    const total = Object.values(b.roles).reduce((a, c) => a + c, 0);
    const card = el('div', 'm-board-card' + (state.boardId === b.id ? ' sel' : ''));
    card.innerHTML = `<span class="m-seats">${total}</span><h3>${b.name}</h3><p>${b.desc}</p>`;
    card.addEventListener('click', () => {
      state.boardId = b.id;
      state.boardCounts = { ...b.roles };
      // 板子内置板规（如狼美人局女巫不可自救）预填进规则页，仍可手动调整
      if (b.rules) Object.assign(state.rules, JSON.parse(JSON.stringify(b.rules)));
      grid.querySelectorAll('.m-board-card').forEach((x) => x.classList.remove('sel'));
      card.classList.add('sel');
      $('#m-next').disabled = false;
    });
    grid.appendChild(card);
  }
  const custom = el('div', 'm-board-card' + (state.boardId === 'custom' ? ' sel' : ''));
  custom.innerHTML = `<span class="m-seats">✦</span><h3>自定义</h3><p>自由调配每种身份的数量，打造你自己的板子</p>`;
  custom.addEventListener('click', () => {
    state.boardId = 'custom';
    grid.querySelectorAll('.m-board-card').forEach((x) => x.classList.remove('sel'));
    custom.classList.add('sel');
    $('#m-next').disabled = false;
  });
  grid.appendChild(custom);
  $('#m-next').disabled = false;
}

/**
 * 并发提示：报的是调度器**实时**允许的容量，而不是 Key 数。
 * 每把 Key 实际允许几并发只有服务商知道，调度器会按实测反馈自己加减；
 * 拿 Key 数反推会在"自适应已涨上去"或"撞限流被砍半"时谎报。
 */
function poolHint(cfg) {
  const pool = cfg && cfg.pool;
  const live = (pool && pool.channels) || (cfg && cfg.channels) || 1;
  const limits = pool && pool.slots ? pool.slots.map((s) => s.limit) : null;
  const detail = pool && pool.adaptive === false
    ? '自适应已关'
    : pool && pool.ramps > 0 ? `已按实测自动加档 ${pool.ramps} 次` : '会按实测自动加减';
  return `当前并发容量 ${live} 条${limits && limits.length > 1 ? `（每把 ${limits.join('/')} 条）` : ''}；${detail}。上限约 -23%，不是减半。`;
}

function wireSettings() {
  $('#m-settings-btn').addEventListener('click', async () => {
    const cfg = await api('GET', '/api/config').catch(() => ({}));
    const wrap = el('div');
    const head = el('div', 'mhead', '<h2>⚙ AI 设置</h2>');
    const close = el('button', 'btn ghost small', '✕');
    close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
    head.appendChild(close);
    const body = el('div', 'mbody');
    const paces = (state.meta && state.meta.paces) || [];
    const paceOpts = paces.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('')
      + '<option value="custom">自定义（参数与任何档位都不一致）</option>';
    const curPace = paces.some((p) => p.id === cfg.pace) ? cfg.pace : 'custom';
    body.innerHTML = `
      <label>接口地址 base_url<input id="ms-baseurl" value="${escapeHtml(cfg.baseUrl || '')}"></label>
      <label>模型 model<input id="ms-model" value="${escapeHtml(cfg.model || '')}"></label>
      <label>快速任务模型（留空 = 与主模型相同）<input id="ms-modelfast" value="${escapeHtml(cfg.modelFast || '')}" placeholder="留空则与上面一致"></label>
      <label>API Key<input id="ms-key" type="password" placeholder="${cfg.hasKey ? '已保存（' + cfg.apiKeyMasked + '），留空不改' : 'sk-...'}"></label>
      <label>更多 API Key（可选，一行一个；多一把多一条并发通道）
        <textarea id="ms-keys" rows="2" placeholder="${cfg.extraKeys > 0 ? '已保存 ' + cfg.extraKeys + ' 把，留空不改' : '留空则只用上面那一把'}"></textarea></label>
      <div class="hint">${poolHint(cfg)}</div>
      <button class="btn ghost small" id="ms-probe" type="button">探测并发额度</button>
      <label>节奏档位（一次设定思考强度/反思频率/上下文）
        <select id="ms-pace">${paceOpts}</select></label>
      <div class="hint" id="ms-pace-hint"></div>
      <div class="row2">
        <label>最大回复 tokens（建议 16000）<input id="ms-maxtokens" type="number" value="${cfg.maxTokens || 16000}"></label>
      <div class="row2">
        <label>发言思考强度<select id="ms-effort">
          <option value="low"${(cfg.reasoningEffort || 'medium') === 'low' ? ' selected' : ''}>最低 low（最快）</option>
          <option value="medium"${(cfg.reasoningEffort || 'medium') === 'medium' ? ' selected' : ''}>中档 medium（默认）</option>
          <option value="high"${cfg.reasoningEffort === 'high' ? ' selected' : ''}>最高 high（最慢）</option>
        </select></label>
        <label>快速任务强度<select id="ms-fasteffort">
          <option value="low"${(cfg.fastEffort || 'low') === 'low' ? ' selected' : ''}>最低 low（默认）</option>
          <option value="medium"${cfg.fastEffort === 'medium' ? ' selected' : ''}>中档 medium</option>
          <option value="high"${cfg.fastEffort === 'high' ? ' selected' : ''}>最高 high</option>
        </select></label>
      </div>
      <div class="row2">
        <label>温度 temperature<input id="ms-temp" type="number" step="0.1" value="${cfg.temperature ?? 0.8}"></label>
        <label>上下文预算 tokens<input id="ms-budget" type="number" step="1000" min="3000" value="${cfg.contextBudget || 12000}"></label>
      </div>
      </div>
      <label class="checkline"><input id="ms-mock" type="checkbox" ${state.mock ? 'checked' : ''}> Mock 试玩（不调用 API）</label>
      <div class="btnrow">
        <button class="btn primary" id="ms-save">保存</button>
        <button class="btn" id="ms-test">测试连接</button>
        <span class="hint" id="ms-result"></span>
      </div>`;
    wrap.append(head, body);
    openModal(wrap);
    // 节奏档位：与桌面端同源（都来自 /api/meta 的 paces），选中后填充可见输入框并如实说明改了什么
    const paceHint = (id) => {
      const p = paces.find((x) => x.id === id);
      const box = $('#ms-pace-hint');
      if (!box) return;
      box.textContent = p
        ? `${p.desc}（反思阈值 ${p.values.digestMinEvents} 条、纪要保留 ${p.values.digestKeep} 条）`
        : '当前参数与任何档位都不完全一致；再选一档并保存即可回到该档的完整参数。';
    };
    $('#ms-pace').value = curPace;
    paceHint(curPace);
    $('#ms-pace').addEventListener('change', (e) => {
      const p = paces.find((x) => x.id === e.target.value);
      if (p) {
        if (p.values.reasoningEffort) $('#ms-effort').value = p.values.reasoningEffort;
        if (p.values.fastEffort) $('#ms-fasteffort').value = p.values.fastEffort;
        if (p.values.contextBudget) $('#ms-budget').value = p.values.contextBudget;
      }
      paceHint(e.target.value);
    });
    $('#ms-mock').addEventListener('change', (e) => { state.mock = e.target.checked; syncMockBtn(); });
    $('#ms-save').addEventListener('click', async () => {
      const b = { baseUrl: $('#ms-baseurl').value.trim(), model: $('#ms-model').value.trim(), modelFast: $('#ms-modelfast').value.trim(), maxTokens: Number($('#ms-maxtokens').value), temperature: Number($('#ms-temp').value), reasoningEffort: $('#ms-effort').value || 'medium', fastEffort: $('#ms-fasteffort').value || 'low', contextBudget: Number($('#ms-budget').value) || 12000 };
      const pace = $('#ms-pace').value;
      if (pace && pace !== 'custom') b.pace = pace; // custom = 保留用户自己调出来的参数
      const key = $('#ms-key').value.trim();
      if (key) b.apiKey = key;
      // 额外 Key：留空 = 不修改（与 apiKey 同一约定）；要清空请用下面的按钮
      const extraKeys = ($('#ms-keys').value || '').split(/[\s,;、]+/).map((s) => s.trim()).filter(Boolean);
      if (extraKeys.length) b.apiKeys = extraKeys;
      try {
        const r = await api('PUT', '/api/config', b);
        $('#ms-key').value = '';
        $('#ms-keys').value = '';
        $('#ms-key').placeholder = `已保存（${r.apiKeyMasked}）`;
        $('#ms-result').textContent = `✓ 已保存（${r.pool ? r.pool.channels : r.channels || 1} 条并发通道）`;
        const after = await api('GET', '/api/config').catch(() => null); // 按服务端反查结果回显，避免界面与磁盘不一致
        if (after) {
          const id = paces.some((p) => p.id === after.pace) ? after.pace : 'custom';
          $('#ms-pace').value = id;
          paceHint(id);
        }
      } catch (e) { $('#ms-result').textContent = `✗ ${e.message}`; }
    });
    // 主动探测每把 Key 的实际并发额度（会花几次极短请求，必须由用户点出来）
    $('#ms-probe').addEventListener('click', async () => {
      const btn = $('#ms-probe');
      btn.disabled = true; btn.textContent = '探测中…';
      $('#ms-result').textContent = '正在逐档试并发（每档几个极短请求）…';
      try {
        const r = await api('POST', '/api/config/probe', { max: 4 });
        const lines = (r.results || []).map((x) => `Key${x.index + 1}→${x.limit} 并发`).join('，');
        $('#ms-result').textContent = `✓ 探测完成：${lines}；当前容量 ${r.pool ? r.pool.channels : '?'} 条`;
      } catch (e) { $('#ms-result').textContent = `✗ 探测失败：${e.message}`; }
      finally { btn.disabled = false; btn.textContent = '探测并发额度'; }
    });
    $('#ms-test').addEventListener('click', async () => {      $('#ms-result').textContent = '测试中…';
      await $('#ms-save').click();
      try {
        const r = await api('POST', '/api/config/test');
        $('#ms-result').textContent = r.ok ? `✓ 连接成功（${r.latencyMs}ms）` : `✗ ${(r.error || '').slice(0, 120)}`;
      } catch (e) { $('#ms-result').textContent = `✗ ${e.message}`; }
    });
  });
}

// ---------------- 屏2：角色图鉴 ----------------
/** 挂载共享图鉴（web/codex.js）。手机端用 sheet 模式：点牌不挤右侧栏，而是弹层看细节。 */
function openCodex() {
  state.codexFrom = ['m-boards', 'm-rules', 'm-game'].find((id) => !$('#' + id).classList.contains('hidden')) || 'm-boards';
  showScreen('m-codex');
  window.Codex.mount({
    meta: state.meta,
    mode: 'pages', // 手机端按阵营分页：每页一屏、满页续下一页，点牌弹层看细节
    artBase: '../assets/roles/', // 手机端在 /m/ 下，立绘要上一层（写死相对路径会 404 成一排碎图）
    // 本局在场：选中的板子里有几张（开局前也能看到，进对局后 view.board 更准）
    counts: () => (state.view && state.view.board && state.view.board.roles) || state.boardCounts || {},
    onPick: showCodexDetail,
    onInspect: (rid) => { if (rid) openInspect(rid); },
    onRulebook: openRulebook,
  });
}

function closeCodex() { showScreen(state.codexFrom || 'm-boards'); }

/** 细节弹层：内容与桌面版右侧栏同源（Codex.detailHtml），只是换个容器。
 *  两个坑：① openModal 只把**无类名容器**的孩子提升到 .modal 下，给它一个 .modal 类会变成
 *  ".modal 套 .modal"，内层是 position:fixed，外层高度塌成 0（实测只剩一条 4px 的线）；
 *  ② 正文必须包一层 .mbody，否则 82vh 的 flex 约束传不进去，长内容滚不动。 */
function showCodexDetail(rid) {
  const src = el('div'); // 无类名 —— 交给 openModal 提升
  src.innerHTML = window.Codex.detailHtml(rid);
  const body = el('div', 'mbody');
  while (src.firstChild) body.appendChild(src.firstChild);
  const wrap = el('div'); // 同样无类名
  wrap.appendChild(body);
  const close = el('button', 'btn ghost', '关闭');
  close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  wrap.appendChild(close);
  // 监听挂在**具体按钮**上：wrap 本身不会被挂进 DOM，挂它上面的委托永远不会触发
  const ins = body.querySelector('.cdx-act-inspect');
  if (ins) ins.addEventListener('click', () => openInspect(rid));
  const rb = body.querySelector('.cdx-act-rule');
  if (rb) rb.addEventListener('click', openRulebook);
  openModal(wrap);
}

// ---------------- 屏3：规则确认 ----------------
function showScreen(id) {
  ['m-boards', 'm-codex', 'm-rules', 'm-game'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
}

function gotoRules() {
  showScreen('m-rules');
  const tpl = state.meta.boards[state.boardId];
  $('#m-rules-title').textContent = tpl ? tpl.name : '自定义板子';
  // 摘要
  const counts = state.boardCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const comp = Object.entries(counts).filter(([, n]) => n > 0).map(([r, n]) => `${roleInfo(r).emoji}${roleInfo(r).name}×${n}`).join(' ');
  $('#m-board-summary').innerHTML = `<b>板子构成</b>（${total}人）：${comp}<br><b>本局模式</b>：你是 1 名玩家，其余全是 AI`;
  // 自定义编辑器
  const ce = $('#m-custom-editor');
  if (state.boardId === 'custom') {
    ce.classList.remove('hidden');
    ce.innerHTML = '';
    for (const [rid, meta] of Object.entries(state.meta.roles)) {
      const row = el('div', 'm-custom-row');
      row.innerHTML = `<span>${meta.emoji} ${meta.name}</span>`;
      const cnt = el('span', 'cnt');
      const num = el('b', null, String(state.boardCounts[rid] || 0));
      const minus = el('button', null, '−'); const plus = el('button', null, '+');
      const redraw = () => { num.textContent = state.boardCounts[rid]; renderSeatSelect(); };
      minus.addEventListener('click', () => { state.boardCounts[rid] = Math.max(0, state.boardCounts[rid] - 1); redraw(); });
      plus.addEventListener('click', () => { state.boardCounts[rid] = state.boardCounts[rid] + 1; redraw(); });
      cnt.append(minus, num, plus);
      row.appendChild(cnt);
      ce.appendChild(row);
    }
  } else { ce.classList.add('hidden'); }
  renderRulesList();
  renderSeatSelect();
}

function renderRulesList() {
  const box = $('#m-rules-list');
  box.innerHTML = '';
  for (const m of state.meta.ruleMeta) {
    const item = el('div', 'rule-item');
    item.innerHTML = `<span class="rlabel"><b>${m.label}</b><br><span class="hint">${m.desc || ''}</span></span>`;
    if (m.type === 'bool') {
      const cb = el('input'); cb.type = 'checkbox';
      cb.checked = getPath(state.rules, m.path || m.key);
      cb.addEventListener('change', () => setPath(state.rules, m.path || m.key, cb.checked));
      item.appendChild(cb);
    } else if (m.type === 'enum') {
      const sel = el('select');
      for (const o of m.options) sel.appendChild(el('option', null, o.label)).value = o.value;
      sel.value = String(getPath(state.rules, m.key));
      sel.addEventListener('change', () => setPath(state.rules, m.key, m.parse ? m.parse(sel.value) : sel.value));
      item.appendChild(sel);
    } else if (m.type === 'nightOrder') {
      const labels = { admirer: '暗恋者', guard: '守卫', dreamer: '摄梦人', wolf: '狼人', wolfbeauty: '狼美人', seer: '预言家', witch: '女巫', crow: '乌鸦' };
      item.innerHTML = `<span class="rlabel">${state.rules.nightOrder.map((s) => labels[s] || s).join(' → ')}</span>`;
    }
    box.appendChild(item);
  }
}

/** 我的座位：默认"🎲 随机"（老坐 1 号很难受），也可指定某一号；选择记在 localStorage 里 */
function renderSeatSelect() {
  const sel = $('#m-my-seat');
  const total = Object.values(state.boardCounts).reduce((a, b) => a + b, 0);
  const cur = String(sel.value || savedSeatChoice());
  sel.innerHTML = '';
  sel.appendChild(el('option', null, '🎲 随机（推荐）')).value = 'random';
  for (let i = 1; i <= total; i++) sel.appendChild(el('option', null, `${i} 号`)).value = i;
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'random';
}

function savedSeatChoice() {
  try { return localStorage.getItem('ww_seat') || 'random'; } catch (_) { return 'random'; } // 与桌面版共用同一个键
}

async function startGame() {
  $('#m-err').textContent = '';
  try {
    const counts = state.boardCounts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const wolves = Object.entries(counts).filter(([r]) => state.meta.roles[r].team === 'wolf').reduce((a, [, n]) => a + n, 0);
    if (total < 4 || wolves < 1 || wolves >= total - wolves) { $('#m-err').textContent = '⚠ 板子配置不合法'; return; }
    const useMock = !!state.mock;
    // 开局明确播报本局是否花钱（P2-b）：这句是玩家最后一次确认的机会
    flash(useMock ? '🧪 Mock 试玩：本局不调用 API、不消耗额度' : '💳 真实对局：本局会调用 API 并消耗额度');
    const cfg = await api('GET', '/api/config');    if (!useMock && !cfg.hasKey) { $('#m-err').textContent = '⚠ 请先在 ⚙ 设置 里填写 API Key（或勾选 Mock 试玩）'; return; }
    const seatChoice = String($('#m-my-seat').value || 'random');
    const randomSeat = seatChoice === 'random';
    const mySeat = randomSeat ? 0 : Number(seatChoice);
    const humanName = $('#m-my-name').value.trim() || '我';
    const pool = shuffle(state.meta.names || []);
    const players = [];
    let ni = 0;
    for (let i = 1; i <= total; i++) {
      players.push(i === mySeat
        ? { name: humanName, isHuman: true }
        : { name: pool[ni++ % pool.length], isHuman: false });
    }
    const body = {
      boardId: state.boardId !== 'custom' ? state.boardId : null,
      board: state.boardId === 'custom' ? { ...counts } : undefined,
      rules: state.rules, players, mock: useMock,
    };
    if (randomSeat) { body.mySeat = 'random'; body.myName = humanName; } // 座位由服务端抽签
    try { localStorage.setItem('ww_seat', seatChoice); } catch (_) { /* 隐私模式忽略 */ }
    const created = await api('POST', '/api/games', body);
    state.game = { gameId: created.gameId, playerToken: created.playerToken, godToken: created.godToken, mySeat: created.mySeat };
    await api('POST', `/api/games/${created.gameId}/start`, { token: created.godToken });
    enterGame();
  } catch (e) { $('#m-err').textContent = `✗ ${e.message}`; }
}

async function tryResume() {
  const saved = localStorage.getItem('mww_current');
  if (!saved) return;
  try {
    const g = JSON.parse(saved);
    const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=0`);
    // inMemory = 对局还在服务端内存里（v.live 是流式缓冲，空闲时为 null，不能用来判断能否继续）
    if (v && !v.finished && v.started && v.inMemory) { state.game = g; enterGame(); }
    else localStorage.removeItem('mww_current'); // 已结束或从未开局 → 不恢复
  } catch (_) { localStorage.removeItem('mww_current'); }
}

// ---------------- 屏3：对局 ----------------
function enterGame() {
  localStorage.setItem('mww_current', JSON.stringify(state.game));
  showScreen('m-game');
  state.playerAfter = 0; state.roleShown = false; state.lastNightStep = null;
  state.speakingSeat = 0;
  try { state.tags = JSON.parse(localStorage.getItem(`mww_tags_${state.game.gameId}`)) || {}; } catch (_) { state.tags = {}; }
  $('#m-flow').innerHTML = '';
  startPolling();
}

function startPolling() {
  stopPolling();
  if (startStream()) return; // 优先 SSE 推送
  startPollFallback();
}
function startPollFallback() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(poll, 1200);
  poll();
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  stopStream();
}

/**
 * SSE 推送：只在服务端有变化时推帧。推送是优化不是依赖——
 * 不支持/被反代缓冲/断流一律回退轮询，手机端照常可玩。
 * 看门狗：8s 内既无帧也无心跳即判定连接已死。
 */
function startStream() {
  if (typeof window === 'undefined' || !window.EventSource) return false;
  const g = state.game;
  if (!g || !g.gameId) return false;
  try {
    const es = new EventSource(`/api/games/${g.gameId}/stream?token=${g.playerToken || g.godToken}&after=${state.playerAfter || 0}`);
    state.stream = { es };
    state.lastStreamAt = Date.now();
    es.addEventListener('view', (ev) => {
      state.lastStreamAt = Date.now();
      let v;
      try { v = JSON.parse(ev.data); } catch (_) { return; }
      applyView(v);
    });
    es.addEventListener('ping', () => { state.lastStreamAt = Date.now(); });
    es.addEventListener('end', () => { stopStream(); poll(); });
    es.addEventListener('error', () => {
      if (es.readyState === 2) { stopStream(); appendSys('⚠ 推送中断，已切换为轮询'); startPollFallback(); }
    });
    state.streamWatchdog = setInterval(() => {
      if (!state.stream) return;
      if (Date.now() - (state.lastStreamAt || 0) > 8000) {
        stopStream();
        appendSys('⚠ 推送无响应，已切换为轮询');
        startPollFallback();
      }
    }, 4000);
    return true;
  } catch (_) {
    stopStream();
    return false;
  }
}

function stopStream() {
  if (state.stream && state.stream.es) { try { state.stream.es.close(); } catch (_) { /* ignore */ } }
  state.stream = null;
  if (state.streamWatchdog) { clearInterval(state.streamWatchdog); state.streamWatchdog = null; }
}

async function poll() {
  const g = state.game;
  if (!g) return;
  try {
    const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=${state.playerAfter}`);
    applyView(v);
  } catch (e) { appendSys(`⚠ 拉取失败：${e.message}`); }
}

/** 渲染一份视图。SSE 与轮询共用；事件按 seq 游标过滤，重连重发也不会画两遍。 */
function applyView(v) {
  if (!v) return;
  state.view = v;
  const freshFrom = state.playerAfter; // 只有新事件才触发横幅/闪光
  if (state.playerAfter === 0) {
    $('#m-flow').innerHTML = '';
    state.seatNames = {}; for (const p of v.players) state.seatNames[p.seat] = p.name;
    state.speakingSeat = 0;
  }
  for (const e of v.events) {
    if (e.seq <= (freshFrom || 0)) continue; // 幂等：已渲染过的 seq 直接跳过
    // 夜晚播报：服务端已把整夜步骤一次性发来（播报与行动解耦，见 src/engine/flow.js 的 nightPhase），
    // 这里先入队、按固定间隔一条条播 —— 直接渲染的话并发后几条会同时冒出来（用户反馈的"播报变奇怪"）
    if (e.type === 'night_step') { state.nightQueue = state.nightQueue || []; state.nightQueue.push(e); continue; }
    if (e.type === 'phase') {
      state.nightOpen = /夜/.test((e.data && e.data.title) || '');
      if (!state.nightOpen) { clearNightWaitM(); flushNightBroadcastM(); } // 天亮 → 收等待提示，并把没播完的补上
    }
    const node = renderEventNode(e);
    if (node) $('#m-flow').appendChild(node);
    feedStage(e, e.seq > freshFrom);
  }
  if (state.nightQueue && state.nightQueue.length) playNightBroadcastM();
  if (v.events.length) state.playerAfter = Math.max(state.playerAfter, ...v.events.map((e) => e.seq));
  updateLive(v);
  scrollFlow(false);
  updateHeader(v);
  updateSeats(v);
  renderMyCard(v);
  updateActionbar(v);
  updatePausedBanner(v);
  updateMemoryChip(v);
  maybeShowRole(v);
}

/** 夜晚播报播放器（手机端）：与桌面端同一套节奏，只是等待提示挂在自己的节点上。
 *  间隔 12 秒：用户要求 10~30 秒之间并让总播报时长**短于**夜里真实行动时长
 *  （6~8 步 × 12 秒 ≈ 72~96 秒，而真实一夜通常 2~5 分钟），所以选 12 秒。 */
const NIGHT_BROADCAST_GAP_M = 12000;

function clearNightWaitM() {
  const w = document.getElementById('m-night-wait');
  if (w) w.remove();
}

function showNightWaitM() {
  if (document.getElementById('m-night-wait')) return;
  const node = el('div', 'msg event', '⏳ 等待其他玩家行动中…');
  node.id = 'm-night-wait';
  const flow = document.getElementById('m-flow');
  if (!flow) return;
  flow.appendChild(node);
  scrollFlow(false);
}

/** 天亮时把还没播完的夜间播报立刻补齐（与桌面端同一套保险逻辑） */
function flushNightBroadcastM() {
  if (!state.nightQueue || !state.nightQueue.length) return;
  const flow = document.getElementById('m-flow');
  for (const e of state.nightQueue) {
    state.lastNightStep = e.data;
    const node = renderEventNode(e);
    if (node && flow) flow.appendChild(node);
  }
  state.nightQueue = [];
  clearNightWaitM();
  scrollFlow(false);
}

async function playNightBroadcastM() {
  if (state.nightPlaying) return;
  state.nightPlaying = true;
  const flow = document.getElementById('m-flow');
  while (state.nightQueue && state.nightQueue.length) {
    const e = state.nightQueue.shift();
    state.lastNightStep = e.data; // 调试/观战要看"当前第几步"，随播放推进
    clearNightWaitM();
    const node = renderEventNode(e);
    if (node && flow) flow.appendChild(node);
    scrollFlow(false);
    await new Promise((r) => setTimeout(r, NIGHT_BROADCAST_GAP_M));
  }
  state.nightPlaying = false;
  if (state.nightOpen) showNightWaitM(); // 播完天没亮 → 行动还在跑，如实提示
}

/**
 * 暂停横幅（手机端）：额度/套餐等外部原因导致暂停时明示原因与重置时间，
 * 点「继续对局」从锚点续跑——已发生的发言不会重来。
 */
function updatePausedBanner(v) {
  const box = $('#m-paused-banner');
  if (!box) return;
  const p = v && v.paused;
  if (!p) {
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; }
    return;
  }
  const sig = `${p.kind}|${p.code}|${p.nextFlushTime || ''}`;
  if (box.dataset.sig === sig) return; // 1.2s 轮询：内容未变不重建 DOM
  box.dataset.sig = sig;
  const title = p.kind === 'quota' ? '账户额度已用尽' : '套餐 / 权限受限';
  const when = p.nextFlushTime ? `预计 <b>${escapeHtml(String(p.nextFlushTime))}</b> 重置` : '请到服务商控制台确认额度';
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="pb-title">⏸ 对局已暂停（不是结束）</div>` +
    `<div class="pb-msg">${title}${p.code ? `（${escapeHtml(String(p.code))}）` : ''}：${escapeHtml(String(p.message || ''))}</div>` +
    `<div class="pb-hint">${when}。进度已保存，恢复后从断点继续。</div>` +
    `<div class="pb-actions">` +
    `<button class="btn primary" id="m-btn-resume-paused">继续对局</button>` +
    `<button class="btn ghost" id="m-btn-terminate-paused">终止本局</button>` +
    `</div>`;
  $('#m-btn-resume-paused').addEventListener('click', resumePausedGame);
  $('#m-btn-terminate-paused').addEventListener('click', terminateGame);
}

/** 日切反思进度（日切边界后台整理记忆，不阻塞对局） */
function updateMemoryChip(v) {
  const node = $('#m-memory');
  if (!node) return;
  const m = v && v.memory;
  if (!m) { node.classList.add('hidden'); return; }
  node.classList.remove('hidden');
  node.textContent = `🧠 整理记忆 ${m.done}/${m.total}`;
}

async function resumePausedGame() {
  const g = state.game;
  if (!g) return;
  const btn = $('#m-btn-resume-paused');
  if (btn) { btn.disabled = true; btn.textContent = '恢复中…'; }
  try {
    const r = await api('POST', `/api/games/${g.gameId}/resume`, { token: g.playerToken || g.godToken });
    state.game = { gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken };
    localStorage.setItem('ww_current', JSON.stringify(state.game));
    state.playerAfter = 0;
    $('#m-flow').innerHTML = '';
    const box = $('#m-paused-banner');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; }
    await poll();
    hint('已从断点继续 ✓');
  } catch (e) {
    hint(`✗ 恢复失败：${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '继续对局'; }
  }
}

/**
 * 流程区滚动：force=true 强制贴底。
 * ⚠ 不能用"离底部距离"判断是否跟随：轮询一次可能新增几百像素（一段长发言），
 * 距离法会当场判定"用户已经上翻"从而永久停止跟随（实测过：内容停在上面，
 * 底部浮出「↓ 最新」而其实没人滚动过）。所以显式记一个跟随状态，
 * 只有**用户自己**滚动时才可能取消跟随。
 */
let flowPinned = true;
let flowSelfScroll = false;
function scrollFlow(force) {
  const s = $('#m-flow');
  if (!s) return;
  if (force) flowPinned = true;
  if (flowPinned) {
    flowSelfScroll = true;
    s.scrollTop = s.scrollHeight;
    flowSelfScroll = false;
  }
  updateToBottomBtn();
}
function onFlowScroll() {
  if (flowSelfScroll) return; // 程序自己滚的不算用户操作
  const s = $('#m-flow');
  if (!s) return;
  flowPinned = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  updateToBottomBtn();
}
/** 往上翻历史时浮出「↓ 最新」：信息滚出视野后必须有一条随时回到底部的路 */
function updateToBottomBtn() {
  const b = $('#m-to-bottom');
  if (!b) return;
  b.classList.toggle('hidden', flowPinned);
}
function appendSys(text) { $('#m-flow').appendChild(el('div', 'sysline', text)); scrollFlow(false); }

function renderEventNode(e) {
  const d = e.data || {};
  const priv = Array.isArray(e.visibleTo);
  switch (e.type) {
    case 'phase': { const night = (d.title || '').includes('夜'); return el('div', `banner ${night ? 'night' : ''}`, d.title || ''); }
    case 'night_step': return el('div', 'msg event', `🕯 ${escapeHtml(d.label)}（${d.index}/${d.total}）`);
    case 'system': return el('div', 'sysline', escapeHtml(e.text || d.text || ''));
    case 'deaths': {
      const ds = d.deaths || [];
      const rules = state.view && state.view.rules;
      const showCause = !rules || rules.revealOnDeath !== false; // 暗牌局只报死亡不报死因
      return el('div', `msg event ${ds.length ? 'red' : 'green'}`, ds.length
        ? `天亮了。昨夜死亡：${ds.map((x) => `${x.seat}号${showCause ? `（${causeLabel(x.cause)}）` : ''}`).join('、')}。`
        : '天亮了。昨夜是平安夜，无人死亡。');
    }
    case 'speech': {
      const tag = { wolf: '🔒 狼聊', lastwords: '🕯 遗言', sheriff: '🎩 警上', pk: '⚔ PK' }[d.context] || '';
      const mine = isMine(e);
      // 统一左对齐、靠颜色区分'我说的'（旧版是 AI 左/我右，窄列上白扔一半宽度）
      const m = el('div', `msg ${d.context === 'wolf' ? 'wolf' : ''} ${priv ? 'private' : ''} ${mine ? 'mine' : ''}`);
      m.appendChild(el('div', 'meta', `<span class="who">${seatLabel(e.actor)}</span> ${tag}`));
      m.appendChild(el('div', null, escapeHtml(d.text || '')));
      return m;
    }
    case 'role_reveal': return el('div', 'msg event', `${seatLabel(d.seat)} 的身份是 ${roleChipHtml(d.role)}`);
    case 'vote_reveal': {
      const detail = (d.votes || []).map((x) => `${x.seat}→${x.target || '弃'}${x.weight !== 1 ? `<small>×${x.weight}</small>` : ''}`).join('，');
      const tally = Object.entries(d.tally || {}).map(([s, n]) => `${s === '0' ? '弃票' : s + '号'}:${n}票`).join('，');
      const curse = d.curseBonus && Object.keys(d.curseBonus).length
        ? `（🐦 ${Object.keys(d.curseBonus).map((s) => s + '号').join('、')} 受诅咒+0.5）` : '';
      return el('div', 'msg event', `🗳 亮票：${detail}<br><span class="hint">${tally}${curse}</span>`);
    }
    case 'duel': return el('div', 'msg event red', `⚔️ ${seatLabel(e.actor)}（骑士）翻牌发起决斗，指定 ${seatLabel(d.target)}！`);
    case 'sheriff_run': return d.run ? el('div', 'msg event', `🎩 ${seatLabel(e.actor)} 举手，上警竞选警长！`) : null;
    case 'sheriff_elected': return el('div', 'msg event green', `🎩 ${seatLabel(d.seat)} 当选警长！`);
    case 'sheriff_none': return el('div', 'msg event', '本局没有产生警长。');
    case 'explode': return el('div', 'msg event red', `💥 ${seatLabel(e.actor)} 自爆${d.target ? `，带走 ${seatLabel(d.target)}` : '，天黑了'}！`);
    case 'shoot': return d.target ? el('div', 'msg event red', `🔫 ${seatLabel(e.actor)} 开枪带走了 ${seatLabel(d.target)}！`) : el('div', 'msg event', `🔫 ${seatLabel(e.actor)} 没有开枪。`);
    case 'idiot_save': return el('div', 'msg event', `🃏 ${seatLabel(d.seat)} 是白痴，免疫放逐（不可投票）`);
    case 'direction': return el('div', 'sysline', `${seatLabel(d.by)}（警长）决定从 ${d.startSeat} 号开始${d.direction === 'cw' ? '顺时针' : '逆时针'}发言`);
    case 'game_over': {
      if (d.winner === 'none') return el('div', 'banner', `⏹ ${escapeHtml(d.reason || '对局已终止')}`);
      if (d.winner === 'draw') return el('div', 'banner', '🤝 平局（未分胜负）');
      const b = el('div', `banner ${d.winner === 'good' ? '' : 'night'}`, d.winner === 'good' ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
      b.style.fontSize = '15px';
      return b;
    }
    case 'deal': { const r = roleInfo(d.role); return el('div', 'msg private', `${isMine(e) ? '🔒 你的身份牌' : `🔒 ${seatLabel(e.actor)} 的身份牌`}：${roleChipHtml(d.role)}<div class="hint" style="margin-top:4px">${r.short}</div>`); }
    case 'teammates': return el('div', 'msg private wolf', `🔒 ${isMine(e) ? '你的' : seatLabel(e.actor) + ' 的'}狼队：${(d.seats || []).map((s) => seatLabel(s)).join('、') || '无'}`);
    case 'wolf_propose': { const sug = d.target ? `（建议刀 ${d.target} 号）` : ''; return el('div', 'msg private wolf', `🔒 ${seatLabel(e.actor)}${d.human ? '（你）' : ''}：${escapeHtml(d.text || '')}<span class="hint">${sug}</span>`); }
    case 'wolf_kill_vote': return el('div', 'msg private wolf', `🔒 ${seatLabel(e.actor)} 投刀：${d.target ? seatLabel(d.target) : '空刀'}`);
    case 'wolf_kill': return el('div', 'msg private wolf', `🔒 狼队决定袭击 ${d.target ? seatLabel(d.target) : '无人（空刀）'}`);
    case 'seer_check': return el('div', 'msg private', `🔒 ${isMine(e) ? '你' : seatLabel(e.actor)}查验 ${seatLabel(d.target)}：${d.isWolf ? '🐺 狼人' : '✅ 好人'}`);
    case 'witch_info': return el('div', 'msg private', `🔒 ${isMine(e) ? '今晚被袭击的是' : seatLabel(e.actor) + ' 得知被袭击的是'}：${d.killTarget ? seatLabel(d.killTarget) : '无人'}`);
    case 'witch_action': return el('div', 'msg private', `🔒 ${isMine(e) ? '用药' : seatLabel(e.actor) + ' 用药'}：${d.antidote ? `解药→${seatLabel(d.killTarget)}；` : ''}${d.poison ? `毒药→${seatLabel(d.poison)}` : ''}${!d.antidote && !d.poison ? '空过' : ''}`);
    case 'night_guard': return el('div', 'msg private', `🔒 ${isMine(e) ? '你守护了' : seatLabel(e.actor) + ' 守护了'} ${d.target ? seatLabel(d.target) : '无人（空守）'}`);
    case 'night_dream': return el('div', 'msg private', `🔒 ${isMine(e) ? '你摄梦了' : seatLabel(e.actor) + '（摄梦人）摄梦了'} ${seatLabel(d.target)}${d.consecutive ? ' ⚠️ 连摄两晚，他今夜将死' : ''}`);
    case 'wolfbeauty_charm': return el('div', 'msg private', `🔒 ${isMine(e) ? '你魅惑了' : seatLabel(e.actor) + '（狼美人）魅惑了'} ${seatLabel(d.target)}`);
    case 'crow_curse': return el('div', 'msg private', `🔒 ${isMine(e) ? '你诅咒了' : seatLabel(e.actor) + '（乌鸦）诅咒了'} ${seatLabel(d.target)}（明日+0.5票）`);
    case 'admirer_crush': return el('div', 'msg private', `🔒 ${isMine(e) ? '你暗恋上了' : seatLabel(e.actor) + '（暗恋者）暗恋上了'} ${seatLabel(d.target)}`);
    case 'ai_reasoning': return el('div', 'msg private', `💭 ${seatLabel(e.actor)} 内心独白（${escapeHtml(d.task || '')}）：${escapeHtml((d.text || '').slice(0, 400))}${(d.text || '').length > 400 ? '…' : ''}`);
    case 'vote_cast': return el('div', 'msg private', `🔒 ${isMine(e) ? '你' : seatLabel(e.actor)}投给了 ${d.target ? seatLabel(d.target) : '弃票'}`);
    default: return null;
  }
}
function causeLabel(cause) { return { wolf_kill: '被袭击', poison: '被毒杀', vote_out: '被放逐', shot: '被枪带走', explode_self: '自爆', explode_target: '被自爆带走', dream: '被连摄而亡', dream_follow: '梦随出局', charm_follow: '殉情出局', duel_win: '被决斗出局', duel_fail: '决斗谢罪' }[cause] || cause; }
function roleChipHtml(rid) { const r = roleInfo(rid); return `<span class="role-tag" style="color:${r.color}">${r.emoji} ${r.name}</span>`; }

function updateHeader(v) {
  $('#m-day').textContent = `第${v.day}天`;
  $('#m-phase').textContent = v.finished ? '已结算' : (PHASE_LABEL[v.phase] || v.phase);
  if (v.phase === 'night' && state.lastNightStep && !v.finished) {
    $('#m-phase').textContent = `${PHASE_LABEL.night} · ${state.lastNightStep.label} ${state.lastNightStep.index}/${state.lastNightStep.total}`;
  }
  document.body.classList.toggle('m-night', v.phase === 'night');
}

// ---------------- 左右两列座位 ----------------
/**
 * 座位按**座位号**稳定排布：左列 1..⌈n/2⌉，右列其余。
 * 旧版是圆桌椭圆 + 以"我"为 6 点位旋转，找号数要在圆上数圈；现在号数顺序与列表一致。
 * 有目标类任务待办时（投票/查验/开枪…），座位直接变成可点选的目标：
 * 点一下即选中（灰红技能键随即变红），不用再去底部找号。
 */
function updateSeats(v) {
  if (!v) return;
  const ps = v.players || [];
  const left = $('#m-seats-l'), right = $('#m-seats-r');
  if (!left || !right) return;
  left.innerHTML = ''; right.innerHTML = '';
  if (!ps.length) return;
  const mySeat = v.me ? v.me.seat : 0;
  const half = Math.ceil(ps.length / 2);
  const pick = actionState.needTarget ? new Set(actionState.candidates) : null;
  ps.forEach((p, i) => {
    const s = el('div', 'srow'
      + (p.seat === mySeat ? ' mine' : '')
      + (p.alive ? '' : ' dead')
      + (p.alive && p.seat === state.speakingSeat ? ' speaking' : '')
      + (pick && p.alive && pick.has(p.seat) ? ' pickable' : '')
      + (actionState.target === p.seat ? ' picked' : ''));
    s.dataset.seat = String(p.seat);
    const ring = el('span', 'num', String(p.seat));
    s.appendChild(ring);
    if (p.isSheriff) s.appendChild(el('span', 'b', '👑'));
    if (p.role && p.revealed) {
      const rr = roleInfo(p.role);
      const rc = el('span', 'b l', rr.emoji);
      rc.style.color = rr.color;
      s.appendChild(rc);
    } else {
      const tag = state.tags[p.seat];
      const tagR = tag && roleInfo(tag);
      if (tagR) {
        const b = el('span', 'b l', '🏷');
        b.style.color = tagR.color;
        s.appendChild(b);
      }
    }
    s.appendChild(el('div', 'nm', escapeHtml(p.name)));
    s.addEventListener('click', () => onSeatTap(p));
    (i < half ? left : right).appendChild(s);
  });
}

/** 点座位：有待选目标就当选择器用，否则开笔记（记可能的身份） */
function onSeatTap(p) {
  const v = state.view;
  if (actionState.needTarget) {
    if (actionState.candidates.includes(p.seat)) {
      setTarget(p.seat);
      updateSeats(v);
    } else {
      flash(`${p.seat}号不在可选范围内`);
    }
    return;
  }
  if (v && v.me && p.alive && !p.revealed && p.seat !== v.me.seat) openTagModal(p.seat);
  else if (p.role && p.revealed) openInspect(p.role);
}

/** 选中目标：同步座位高亮 + 底部技能键由灰红转红 */
function setTarget(seat) {
  actionState.target = seat;
  const box = $('#m-keys');
  if (box) {
    box.querySelectorAll('.key.seat').forEach((k) => {
      const on = Number(k.dataset.seat) === seat;
      k.classList.toggle('on', on);
      k.classList.toggle('alt', !on);
    });
    const conf = box.querySelector('[data-confirm]');
    if (conf) setKeyEnabled(conf, seat > 0 || !!conf.dataset.allowZero);
  }
  $('#m-dialog-seat').textContent = seat ? `${seat} 号` : '未选择';
}

// ---------------- 事件副作用（全屏横幅 / 发言高亮）与"正在发言"节点 ----------------
/**
 * 旧版把最新事件单独渲染进一个"舞台"，长发言被 overflow:hidden 截断。
 * 现在发言与事件正文一律进入中间流程区（唯一的滚动区），这里只做两件事：
 * 全屏横幅（阶段切换等）与"谁在发言"的高亮。
 */
function feedStage(e, fresh) {
  const d = e.data || {};
  const priv = Array.isArray(e.visibleTo);
  switch (e.type) {
    case 'phase': {
      state.speakingSeat = 0;
      const night = (d.title || '').includes('夜');
      if (fresh) flash(d.title || (night ? '天黑请闭眼' : '天亮了'), night ? 'night' : '');
      break;
    }
    case 'speech': {
      if (priv || d.context === 'wolf') break; // 私密/狼聊不进公开流程
      state.speakingSeat = e.actor;
      break;
    }
    case 'vote_reveal':
      state.speakingSeat = 0; // 投票阶段没有发言者
      state.voteProgress = null;
      break;
    // 私密投票的进度（服务端只播报计数，不含任何目标/座位）：
    // 一次放逐投票要串行 8~11 次调用、期间没有任何输出，这里是唯一能让玩家知道"在跑"的信号。
    case 'vote_progress':
      state.voteProgress = d.done < d.total ? { done: d.done, total: d.total, at: Date.now() } : null;
      break;
    case 'deaths': {
      const ds = d.deaths || [];
      if (fresh) flash(ds.length ? '昨夜有人死去' : '平安夜', ds.length ? 'red' : 'night');
      break;
    }
    case 'role_reveal':
      if (fresh) flash(`${d.seat}号 翻牌`, '');
      break;
    case 'duel':
      if (fresh) flash('骑士决斗！', 'red');
      break;
    case 'explode':
      if (fresh) flash('自 爆', 'red');
      break;
    case 'shoot':
      if (fresh && d.target) flash('枪响人亡', 'red');
      break;
    case 'sheriff_elected':
      if (fresh) flash('警长诞生', '');
      break;
    case 'game_over': {
      const won = d.winner === 'good' ? '好人阵营获胜' : d.winner === 'wolf' ? '狼人阵营获胜' : d.winner === 'draw' ? '平局' : '对局结束';
      if (fresh) flash(won, d.winner === 'wolf' ? 'night' : 'red');
      break;
    }
    default:
      break;
  }
}

/** 流程区底部的"正在发言/正在思考"节点（流式打字）：把漫长的空白等待变成即时反馈 */
function updateLive(v) {
  const flow = $('#m-flow');
  if (!flow) return;
  const live = v && v.live && !v.finished ? v.live : null;
  // 私密投票期间没有公开发言（live.public=false），但服务端会播报"已收集几票"——
  // 那是这个阶段唯一能让玩家知道"程序在跑"的信号，不能因为 live 为空就把节点收掉。
  const vpRaw = v && v.finished ? null : state.voteProgress;
  const vp = vpRaw && vpRaw.done < vpRaw.total ? vpRaw : null; // 收齐即收工，不依赖事件顺序
  const node = $('#m-live');
  if (!live && !vp) { if (node) node.remove(); state.liveSince = null; return; }
  const n = node || (() => { const x = el('div', 'msg live'); x.id = 'm-live'; return x; })();
  if (n.parentNode !== flow) flow.appendChild(n);
  else if (n !== flow.lastElementChild) flow.appendChild(n); // 始终贴底
  const lp = live ? (v.players || []).find((x) => x.seat === live.seat) : null;
  // 秒表：实测单条发言平均等 103.6s、最长 362s，而这段时间手机上**完全不动**。
  // 只显示"已 N 秒"，不泄露任何私密内容（秒数进 sig，让 1.2s 轮询把表走起来）。
  const lkey = live ? `${live.seat}|${live.task || ''}` : '';
  if (live && (!state.liveSince || state.liveSince.key !== lkey)) state.liveSince = { key: lkey, at: Date.now() };
  const secs = live ? Math.max(0, Math.round((Date.now() - state.liveSince.at) / 1000))
    : Math.max(0, Math.round((Date.now() - vp.at) / 1000));
  const sig = `${live ? live.seat : 0}|${live && live.public ? 1 : 0}|${(live && live.text) || ''}|${secs}|${vp ? `${vp.done}/${vp.total}` : ''}`;
  if (n.dataset.sig === sig) return; // 1.2s 轮询：内容没变不重建 DOM
  n.dataset.sig = sig;
  if (!live) {
    // 只有投票进度：明确告诉玩家"已经收到几票、等了多久"，而不是让他盯着空白
    n.innerHTML = '<div class="meta"><span class="hint">… 正在收集投票</span></div>'
      + `<div class="hint">已思考 ${vp.done}/${vp.total} · ${secs}s</div>`;
    return;
  }
  const work = live.text ? '… 正在决策' : '… 正在思考';
  n.innerHTML = `<div class="meta"><span class="who">${escapeHtml(lp ? lp.name : '')} · ${live.seat}号</span>`
    + ` <span class="hint">${live.public && live.text ? '✍ 正在发言' : work} · 已 ${secs}s${vp ? ` · ${vp.done}/${vp.total}` : ''}</span></div>`
    + (live.public && live.text
      ? `<div>${escapeHtml(live.text)}<span class="caret"></span></div>`
      : '<div class="hint">正在思考…</div>');
}

let flashTimer = null;
function flash(text, cls) {
  const f = $('#m-flash');
  f.className = 'm-flash' + (cls ? ' ' + cls : '');
  f.innerHTML = `<div class="flash-txt">${escapeHtml(text)}</div>`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    f.classList.add('fadeout');
    setTimeout(() => f.classList.add('hidden'), 520);
  }, 1450);
}

function possibleRolesFor(v, seat) {
  const revealedCount = {};
  for (const p of v.players) if (p.role && p.revealed) revealedCount[p.role] = (revealedCount[p.role] || 0) + 1;
  const myRole = v.me ? v.me.role : null;
  const out = [];
  for (const [rid, count] of Object.entries(v.board || {})) {
    let remaining = count - (revealedCount[rid] || 0);
    if (myRole === rid) remaining -= 1;
    if (remaining > 0) out.push(rid);
  }
  return out;
}

function openTagModal(seat) {
  const v = state.view;
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>🏷 标记 ${seat} 号</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', '仅自己的笔记，AI 看不到；不可能的身份不在列表中。'));
  const chips = el('div'); chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
  for (const rid of possibleRolesFor(v, seat)) {
    const r = roleInfo(rid);
    const c = el('button', 'chip', `${r.emoji} ${r.name}`);
    if (state.tags[seat] === rid) c.classList.add('sel');
    c.addEventListener('click', () => { state.tags[seat] = rid; saveTags(); $('#m-modal').innerHTML = ''; updateSeats(state.view); });
    chips.appendChild(c);
  }
  body.appendChild(chips);
  if (state.tags[seat]) {
    const clr = el('button', 'btn danger', '清除标记');
    clr.style.marginTop = '12px';
    clr.addEventListener('click', () => { delete state.tags[seat]; saveTags(); $('#m-modal').innerHTML = ''; updateSeats(state.view); });
    body.appendChild(clr);
  }
  wrap.append(head, body);
  openModal(wrap);
}

function saveTags() { try { localStorage.setItem(`mww_tags_${state.game.gameId}`, JSON.stringify(state.tags)); } catch (_) {} }
function openModal(inner) {
  const root = $('#m-modal');
  root.innerHTML = '';
  const mask = el('div', 'modal-mask m-modal');
  const modal = el('div', 'modal');
  // ⚠ 不能把调用方给的容器整包塞进去：那样 .mhead/.mbody 会变成"孙子"，
  // flex 约束（.modal 的 max-height + .mbody 的 min-height:0）传不到正文，
  // 正文就被内容撑到真实高度（规则书实测 11192px）且滚不动。
  // 因此只要是"无类名的普通容器"，就把它的孩子直接挂到 .modal 下。
  if (inner && !inner.className && inner.children.length) {
    while (inner.firstChild) modal.appendChild(inner.firstChild);
  } else {
    modal.appendChild(inner);
  }
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) root.innerHTML = ''; });
  root.appendChild(mask);
}

// ---------------- 底部坞：左（身份牌 + 技能键）| 右（对话框） ----------------
let actionState = { target: 0, explode: false, withdraw: false, needTarget: false, candidates: [] };

const TASK_LABEL = {
  speech: '轮到你发言', pk_speech: '平票 PK 发言', lastwords: '请留遗言',
  sheriff_speech: '警长竞选演讲', night_guard: '守卫行动', wolf_kill: '狼队投票定刀口',
  seer_check: '预言家查验', sheriff_vote: '警长竞选投票', vote: '放逐投票（互相保密）',
  pk_vote: 'PK 投票', wolf_say: '狼队讨论·轮到你（可跳过）', shoot: '开枪技能',
  badge_pass: '警徽去向', direction: '决定发言方向', sheriff_run: '是否上警', witch: '女巫用药',
  night_dream: '摄梦人·选摄梦对象（连摄两晚同一人则其死亡）',
  wolfbeauty_charm: '狼美人·选魅惑对象（你出局时他殉情）',
  crow_curse: '乌鸦·选诅咒对象（明日他放逐投票+0.5票）',
  admirer_crush: '暗恋者·暗选心动对象（胜负阵营终身绑定）',
};

/** 需要"点座位选人"的任务 → 确认键文案 / 允许的免选键 */
const TARGET_TASKS = {
  night_guard: ['确认守护', '空守'],
  night_dream: ['确认摄梦', null],
  wolfbeauty_charm: ['确认魅惑', null],
  crow_curse: ['确认诅咒', null],
  admirer_crush: ['确认心动', null],
  wolf_kill: ['投刀', '空刀'],
  seer_check: ['查验', null],
  vote: ['投票', '弃票'],
  pk_vote: ['投票', '弃票'],
  sheriff_vote: ['投票', '弃票'],
  shoot: ['开枪', '不开枪'],
  badge_pass: ['移交', '撕毁警徽'],
};

/**
 * 底部坞每 1.2s 会被轮询重刷：只有"任务签名"变化才重建 DOM，
 * 否则正在输入的发言会被清空（踩过一次）。
 */
function updateActionbar(v) {
  const hintBox = $('#m-pending-hint');
  const keys = $('#m-keys');
  const dlg = $('#m-dialog');
  if (!keys || !dlg) return;
  const p = v.pending;

  // ① 狼队讨论：可以插话 / 加轮 / 提前结束
  if (!p && v.wolfTalk && v.wolfTalk.active) {
    const sig = `wt:${v.wolfTalk.round}/${v.wolfTalk.rounds}`;
    if (keys.dataset.task === sig) return;
    keys.dataset.task = sig; dlg.dataset.task = sig;
    keys.innerHTML = ''; dlg.innerHTML = '';
    hintBox.className = 'pending-hint mine';
    hintBox.textContent = `🌙 狼队讨论（第 ${v.wolfTalk.round}/${v.wolfTalk.rounds} 轮）：可插话 / 加一轮 / 提前结束`;
    const ta = el('textarea'); ta.placeholder = '插话给狼队队友…（可留空）';
    const send = keyEl('插话', 'off', () => wolfTalkAction('say', ta.value.trim(), ta));
    send.dataset.confirm = '1';
    ta.addEventListener('input', () => setKeyEnabled(send, ta.value.trim().length > 0));
    dlg.appendChild(ta);
    keys.appendChild(send);
    keys.append(
      keyEl('+1 轮', 'alt', () => wolfTalkAction('extra')),
      keyEl('结束讨论', 'alt', () => wolfTalkAction('end'))
    );
    return;
  }

  // ② 空档：显示等待文案 + 随时可用的打断技能（自爆 / 决斗）
  if (!p) {
    const sig = `idle:${v.finished ? 1 : 0}:${v.phase}:${canExplodeNow(v) ? 1 : 0}${canDuelNow(v) ? 1 : 0}`;
    hintBox.className = 'pending-hint waiting';
    hintBox.textContent = v.finished ? '对局已结束。' : waitingText(v);
    if (keys.dataset.task === sig) return;
    keys.dataset.task = sig; dlg.dataset.task = sig;
    keys.innerHTML = ''; dlg.innerHTML = '';
    dlg.appendChild(el('div', 'idle', v.finished
      ? '本局已结算 —— 看总结，或从左上角 ⚙ 里查看规则书与退出。'
      : '现在轮不到你操作。轮到你会在这里出现输入框或技能键。'));
    if (v.finished) {
      keys.appendChild(keyEl('📊 查看本局总结', 'on', () => openSummarySheet()));
      keys.appendChild(keyEl('🏠 回到首页', '', () => { localStorage.removeItem('mww_current'); location.reload(); }));
      // 结算后自动弹一次总结（用户反馈"手机端结束后什么都没有"）；只弹一次，关掉不再打扰
      if (state.summaryShownFor !== state.game.gameId) {
        state.summaryShownFor = state.game.gameId;
        setTimeout(() => openSummarySheet(), 600);
      }
      return;
    }
    mountExplodeBtn(v, keys);
    mountDuelBtn(v, keys);
    return;
  }

  const sig = `task:${p.task}:${JSON.stringify(p.candidates || [])}:${p.canExplode ? 1 : 0}${p.canWithdraw ? 1 : 0}`;
  if (keys.dataset.task === sig) return;
  keys.dataset.task = sig; dlg.dataset.task = sig;
  keys.innerHTML = ''; dlg.innerHTML = '';
  actionState = { target: 0, explode: false, withdraw: false, needTarget: false, candidates: (p.candidates || []).slice() };
  buildActionUI(v, p, keys, dlg);
  if (p.task !== 'speech') mountExplodeBtn(v, keys);
  mountDuelBtn(v, keys);
  updateSeats(v); // 目标任务：让左右座位立刻变成可点选状态
}

// ---------------- 骑士随时决斗（白天任意时刻） ----------------
function canDuelNow(v) {
  return !!(v && v.me && v.me.alive && !v.finished && v.me.role === 'knight'
    && !v.pending // 轮到自己操作时不显示打断按钮（引擎正等你的操作，打断不会生效）
    && ['speech', 'vote', 'pk'].includes(v.phase)); // 白天任意时刻，警长竞选不可
}

/** 已排队未生效的打断请求提示（优先级高于普通等待文案） */
function queuedInterruptText(v) {
  const q = v && v.queued;
  if (q && q.explode) return `🔮 自爆已就绪：当前发言结束后立即生效${q.explode.target ? `（带走 ${q.explode.target} 号）` : ''}…`;
  if (q && q.duel) return `⚔️ 决斗已就绪：当前发言结束后立即生效（指定 ${q.duel.target} 号）…`;
  return null;
}

async function confirmDuel(v) {
  const aliveSeats = v.players.filter((p) => p.alive && p.seat !== v.me.seat).map((p) => p.seat);
  const t = Number(window.prompt('⚔️ 骑士决斗：指定一名玩家——他是狼人则出局入夜，是好人则你以死谢罪。请输入座位号：' + aliveSeats.join('、')));
  if (!aliveSeats.includes(t)) return;
  if (!window.confirm(`确定决斗 ${t} 号吗？`)) return;
  try {
    await api('POST', `/api/games/${state.game.gameId}/duel`, { token: state.game.playerToken, target: t });
    $('#m-pending-hint').textContent = '⚔️ 决斗请求已提交，将在当前发言结束后的间隙生效…';
  } catch (e) { $('#m-pending-hint').textContent = `✗ ${e.message}`; }
}

function mountDuelBtn(v, box) {
  if (!canDuelNow(v) || box.querySelector('.duel-now-btn')) return;
  const b = el('button', 'btn danger duel-now-btn', '⚔️ 决斗');
  b.addEventListener('click', () => confirmDuel(v));
  box.appendChild(b);
}

// ---------------- 随时自爆（白天任意时刻） ----------------
function canExplodeNow(v) {
  const r = v && v.me && v.me.role && roleInfo(v.me.role);
  return !!(v && v.me && v.me.alive && !v.finished && v.rules && v.rules.allowSelfExplode
    && !v.pending // 轮到自己操作时不显示打断按钮（轮到你发言时请直接勾选"自爆"）
    && ['speech', 'vote', 'pk'].includes(v.phase) && r && r.selfExplode); // 白天任意时刻，警长竞选不可
}

async function confirmExplode(v) {
  let target = 0;
  if (v.me.role === 'whitewolfking') {
    const aliveSeats = v.players.filter((p) => p.alive && p.seat !== v.me.seat).map((p) => p.seat);
    const t = Number(window.prompt('白狼王自爆将带走一名玩家。请输入座位号：' + aliveSeats.join('、')));
    if (!aliveSeats.includes(t)) return;
    target = t;
  } else if (!window.confirm('确定随时自爆？将公开狼人身份并立即进入黑夜（在当前发言结束后的间隙生效）。')) return;
  try {
    await api('POST', `/api/games/${state.game.gameId}/explode`, { token: state.game.playerToken, target });
    $('#m-pending-hint').textContent = '🔮 自爆请求已提交，将在当前发言结束后的间隙生效…';
  } catch (e) { $('#m-pending-hint').textContent = '✗ ' + e.message; }
}

function mountExplodeBtn(v, box) {
  if (!canExplodeNow(v) || box.querySelector('.explode-now-btn')) return;
  const b = el('button', 'btn danger explode-now-btn', '🔮 自爆');
  b.style.flex = '1';
  b.addEventListener('click', () => confirmExplode(v));
  box.appendChild(b);
}

function waitingText(v) {
  const qi = queuedInterruptText(v);
  if (qi) return qi;
  if (v.phase === 'night' && state.lastNightStep) return `🌙 夜晚 · ${state.lastNightStep.label}（${state.lastNightStep.index}/${state.lastNightStep.total}）—— AI 行动中…`;
  return { night: '🌙 夜晚进行中…', sheriff: '🎩 警长竞选进行中…', speech: '💬 白天发言进行中…', vote: '🗳 投票进行中…', pk: '⚔ PK 进行中…', dawn: '🌅 天亮结算中…' }[v.phase] || '等待游戏推进…';
}

/** 技能键：kind = on(可用·红) / off(不可用·灰红) / alt(次要但可用·暗红描边) */
function keyEl(label, kind, onClick, opts) {
  const o = opts || {};
  const b = el('button', `key ${kind}`, label);
  if (o.sub) b.appendChild(el('span', 'k-sub', o.sub));
  if (o.seat != null) b.dataset.seat = String(o.seat);
  if (o.confirm) b.dataset.confirm = '1';
  if (kind === 'off') b.disabled = true;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
/** 技能键可用性切换：灰红 ↔ 红。disabled 与视觉状态一起改，避免"看着能点其实点了没用" */
function setKeyEnabled(btn, on) {
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.disabled = !on;
}

async function submitSimple(payload) {
  try {
    await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload });
    $('#m-keys').innerHTML = ''; $('#m-keys').dataset.task = '';
    $('#m-dialog').innerHTML = ''; $('#m-dialog').dataset.task = '';
  } catch (e) { $('#m-pending-hint').textContent = `✗ ${e.message}`; }
}
async function wolfTalkAction(kind, text, ta) {
  try {
    await api('POST', `/api/games/${state.game.gameId}/wolftalk`, { token: state.game.playerToken, kind, text });
    if (kind === 'say' && ta) ta.value = '';
    hint(`已发送 ✓`);
  } catch (e) { $('#m-pending-hint').textContent = `✗ ${e.message}`; }
}
function hint(t) { $('#m-pending-hint').textContent = t; }

/** 板子页试玩开关的样式与文案（P2-b）：真实对局用红字，避免"以为在试玩其实在花钱" */
function syncMockBtn() {
  const b = $('#m-mock-btn');
  if (!b) return;
  b.textContent = state.mock ? I18N.t('m.mockOn') : I18N.t('m.mockOff');
  b.classList.toggle('danger', !state.mock);
}

/**
 * 底部坞组装：
 *   对话框（右侧）= 发言输入 / 任务说明 / 已选目标
 *   技能键（左侧）= 确认与技能开关，**可用为红、不可用为灰红**
 * 目标类任务不再在底部堆一排座位号 —— 直接点左右两列的座位选人（见 onSeatTap）。
 */
function buildActionUI(v, p, keys, dlg) {
  const me = v.me || {};
  hint(`⏳ ${TASK_LABEL[p.task] || p.task}（无时间限制）`);

  // ---------- 发言类：输入框进对话框 ----------
  if (['speech', 'pk_speech', 'lastwords', 'sheriff_speech', 'wolf_say'].includes(p.task)) {
    const ta = el('textarea');
    ta.placeholder = p.task === 'lastwords' ? '留下你的遗言…' : '输入你的发言…';
    dlg.appendChild(ta);
    const canSend = () => ta.value.trim().length > 0
      || (p.task === 'sheriff_speech' && actionState.withdraw)
      || (p.task === 'wolf_say' && true); // 狼聊可空过（另有"跳过本轮"键）
    const send = keyEl(
      { lastwords: '留下遗言', wolf_say: '发言' }[p.task] || '发送发言',
      'off',
      async () => {
        const payload = { text: ta.value.trim() };
        if (p.canExplode && actionState.explode) {
          payload.explode = true;
          if (me.role === 'whitewolfking') payload.target = actionState.target;
        }
        if (p.task === 'sheriff_speech') payload.withdraw = actionState.withdraw;
        await submitSimple(payload);
      }
    );
    send.dataset.confirm = '1';
    ta.addEventListener('input', () => setKeyEnabled(send, canSend()));
    setKeyEnabled(send, canSend());
    // 发送键和其它技能键放在同一条动作行里（以前单独占一行、还把行拉满宽，
    // 结果输入框被上下夹击显得变形）
    keys.appendChild(send);
    if (p.canExplode && me.role === 'whitewolfking') markNeedTarget(v, v.players.filter((x) => x.alive && x.seat !== me.seat).map((x) => x.seat), '选择自爆要带走的玩家');
    if (p.canExplode) {
      keys.appendChild(keyEl('🔮 自爆', 'alt', () => {
        actionState.explode = !actionState.explode;
        hint(actionState.explode ? '已勾选自爆：发送后立即公开狼人身份并进入黑夜' : '已取消自爆');
        refreshCanvas(v);
      }));
    }
    if (p.canWithdraw) {
      keys.appendChild(keyEl('🚰 退水', 'alt', () => {
        actionState.withdraw = !actionState.withdraw;
        setKeyEnabled(send, canSend());
        hint(actionState.withdraw ? '已选择退水：发送后退出竞选' : '已取消退水');
      }));
    }
    if (p.task === 'wolf_say') {
      keys.appendChild(keyEl('跳过本轮', 'alt', () => submitSimple({ text: '' })));
    }
    return;
  }

  // ---------- 目标类：点座位选人，确认键灰红→红 ----------
  if (TARGET_TASKS[p.task]) {
    const [label, none] = TARGET_TASKS[p.task];
    actionState.needTarget = true;
    markNeedTarget(v, p.candidates, '点击左右两侧的座位选择目标');
    const conf = keyEl(label, 'off', () => submitSimple({ target: actionState.target }), { confirm: true });
    keys.appendChild(conf);
    if (p.allowNone && none) keys.appendChild(keyEl(none, 'alt', () => submitSimple({ target: 0 })));
    // 单个候选时直接预选，省一次点击
    if (p.candidates && p.candidates.length === 1) setTarget(p.candidates[0]);
    return;
  }

  // ---------- 女巫：解药 / 毒药 / 空过 ----------
  if (p.task === 'witch') {
    const ex = p.extra || {};
    if (ex.canAntidote) {
      keys.appendChild(keyEl(`💊 解药救 ${ex.killTarget} 号`, 'on', () => submitSimple({ antidote: true, poison: 0 })));
    } else {
      keys.appendChild(keyEl('💊 解药不可用', 'off', null, { sub: ex.antidoteUsed ? '已用过' : '今夜无人被刀' }));
    }
    const poisonKey = keyEl('☠ 用毒', 'off', () => submitSimple({ antidote: false, poison: actionState.target }), { confirm: true });
    if (ex.canPoison) {
      actionState.needTarget = true;
      markNeedTarget(v, v.players.filter((x) => x.alive).map((x) => x.seat), '点座位选择要毒的人（可毒自己）');
      keys.appendChild(poisonKey);
    } else {
      keys.appendChild(keyEl('☠ 毒药不可用', 'off', null, { sub: ex.poisonUsed ? '已用过' : ' ' }));
    }
    keys.appendChild(keyEl('空过', 'alt', () => submitSimple({ antidote: false, poison: 0 })));
    return;
  }

  // ---------- 二选一：上警 / 方向 ----------
  if (p.task === 'sheriff_run') {
    keys.append(
      keyEl('🎩 上警', 'on', () => submitSimple({ run: true })),
      keyEl('不上警', 'alt', () => submitSimple({ run: false }))
    );
    return;
  }
  if (p.task === 'direction') {
    keys.append(
      keyEl('顺时针 →', 'on', () => submitSimple({ direction: 'cw' })),
      keyEl('逆时针 ←', 'alt', () => submitSimple({ direction: 'ccw' }))
    );
    return;
  }

  keys.appendChild(el('span', 'hint', `未知任务：${p.task}`));
}

/** 标记"本次需要点座位选目标"：让左右两列座位进入可选状态，并在对话框里给出说明 */
function markNeedTarget(v, candidates, tip) {
  actionState.needTarget = true;
  actionState.candidates = (candidates || []).slice();
  const dlg = $('#m-dialog');
  if (dlg && !dlg.querySelector('.pick-tip')) {
    // "已选 N 号"必须自成一行：跟说明文字连排会被折成"已选 1 / 号"（实测）
    const t = el('div', 'idle pick-tip');
    t.appendChild(el('div', 'pick-hint', `🎯 ${escapeHtml(tip)}`));
    const sel = el('div', 'pick-sel');
    sel.innerHTML = '已选 <b id="m-dialog-seat">未选择</b>';
    t.appendChild(sel);
    dlg.insertBefore(t, dlg.firstChild);
  }
}
/** 重绘技能键的勾选外观（自爆等开关型技能键） */
function refreshCanvas(v) {
  const keys = $('#m-keys');
  if (!keys) return;
  const b = [...keys.querySelectorAll('.key')].find((x) => x.textContent.includes('自爆'));
  if (b) {
    b.classList.toggle('on', actionState.explode);
    b.classList.toggle('alt', !actionState.explode);
  }
  updateSeats(v);
}

// ---------------- 翻牌 / 检视 / 规则书 ----------------
function roleArtHtml(rid) {
  const r = roleInfo(rid);
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  // 注意：这里原来只在"有插画"的分支外面包 .card-frame，缺图时返回的是一张**没有卡框**的裸卡；
  // 桌面版两个分支都包了。现在两支统一走同一套手绘 SVG 框（card-frame.js）。
  const face = ext
    ? `<img class="role-art" src="../assets/roles/${rid}${ext}" alt="${r.name}">`
    : `<div class="role-art-fallback"><div class="fa-emoji">${r.emoji}</div><div class="fa-name">${r.name}</div></div>`;
  return `<div class="card-frame"${window.CardFrame.roleAttr(rid)}>${window.CardFrame.html()}${face}</div>`;
}
function openInspect(rid) {
  const r = roleInfo(rid);
  const stage = el('div', 'inspect-stage');
  const card = el('div', 'inspect-card card-frame');
  // 与桌面端同理：走 roleAttrs 原语，必须同时带上 data-faction，否则徽记永远是狼爪
  Object.assign(card.dataset, window.CardFrame.roleAttrs(rid));
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  const frame = window.CardFrame.html();
  if (ext) {
    // 插画与信息板都放进 .inner：绝对定位的包含块是 padding box，
    // 直接挂在卡上会让底部信息板压住金框下沿（桌面版一直有 .inner 包着）
    card.innerHTML = `${frame}<div class="inner"><img class="role-art" src="../assets/roles/${rid}${ext}" alt="${r.name}"><div class="in-overlay"><div class="in-name gilt-name">${r.name}</div><div class="in-desc">${escapeHtml(r.short)}</div></div></div>`;
  } else {
    card.innerHTML = `${frame}<div class="in-body"><div class="in-emoji">${r.emoji}</div><div class="in-name gilt-name">${r.name}</div><div class="in-desc">${escapeHtml(r.short)}</div></div>`;
  }
  stage.appendChild(card);
  stage.appendChild(el('div', 'inspect-hint', '移动指针检视 · 点击关闭'));
  stage.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / rect.width;
    const dy = (e.clientY - rect.top - rect.height / 2) / rect.height;
    card.style.transform = `rotateY(${(dx * 14).toFixed(2)}deg) rotateX(${(-dy * 12).toFixed(2)}deg)`;
  });
  stage.addEventListener('click', () => stage.remove());
  document.body.appendChild(stage);
}
function maybeShowRole(v) {
  if (state.roleShown || !v.me || !v.me.role || v.finished || (v.day === 0 && !v.events.length)) return; // 已结束不播翻牌
  state.roleShown = true;
  const r = roleInfo(v.me.role);
  $('#m-flip-front').innerHTML = `
    ${roleArtHtml(v.me.role)}
    <div class="r-name gilt-name">${r.name}</div>`;
  $('#m-flip-caption').innerHTML = `
    <div class="r-desc">${r.short}</div>
    ${v.me.teammates && v.me.teammates.length ? `<div class="r-desc tm">狼队：${v.me.teammates.join('、')} 号</div>` : ''}`;
  $('#m-flip').classList.remove('hidden');
  $('#m-flip-card').classList.remove('flipped');
}
/**
 * 规则书：内容与渲染器都在 web/rulebook.js（桌面端同一份）。
 * 这里只加"本局实际开关"一节 —— 玩家最关心的"我这局和默认有什么不同"。
 */
function openRulebook() {
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>📖 规则书</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  head.appendChild(close);
  const body = el('div', 'mbody rulebook');
  const thisGame = el('div', 'rb-sec');
  thisGame.innerHTML = `<h3 class="rb-h">本局实际规则</h3><p class="rb-p">${escapeHtml(formatRules())}</p>`;
  body.appendChild(thisGame);
  if (window.Rulebook && window.Rulebook.render) window.Rulebook.render(body);
  else body.appendChild(el('p', 'hint', '规则书资源未加载（rulebook.js 缺失）。'));
  wrap.append(head, body);
  openModal(wrap);
}
function formatRules() {
  const parts = [];
  parts.push(state.rules.sheriff ? '有警长竞选' : '无警长');
  parts.push({ never: '女巫不可自救', firstNight: '女巫仅首夜可自救', noFirstNight: '女巫仅首夜不可自救', always: '女巫全程可自救' }[state.rules.witchSelfSave]);
  parts.push(state.rules.allowEmptyKill ? '可空刀' : '不可空刀');
  parts.push(state.rules.allowSelfExplode ? '可自爆' : '不可自爆');
  return parts.join('；') + '。其余细则见设置内规则开关描述。';
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }
function setPath(obj, path, val) { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], obj)[last] = val; }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function terminateGame() {
  if (!confirm('确定要结束本局游戏吗？所有玩家将亮牌，本局记为终止。')) return;
  if (!state.game) return;
  try {
    await api('POST', `/api/games/${state.game.gameId}/terminate`, { token: state.game.playerToken || state.game.godToken });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 350));
      try { await poll(); } catch (_) {}
      if (state.view && state.view.finished) break;
    }
    hint('对局已终止，全场亮牌 ✓');
  } catch (e) { hint(`✗ ${e.message}`); }
}

/** 牌背（#m-flip 里的 .flip-back）是静态 HTML，框层在这里注入 —— 保持"卡框只有一份实现" */
function ensureCardBacks() {
  for (const node of document.querySelectorAll('.flip-back')) {
    if (!node.querySelector('.fr-svg')) node.insertAdjacentHTML('afterbegin', window.CardFrame.html());
  }
}
ensureCardBacks();
init().catch((e) => { document.body.innerHTML = `<div style="padding:40px;color:#e89ba4">初始化失败：${escapeHtml(e.message)}</div>`; });
