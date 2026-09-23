/**
 * m.js — AI 狼人杀 APP 端（手机专属页面）
 * 完整对局玩法；无上帝模式/日志/上下文调试/观战等调试功能。
 * 通过相对路径调用同一套 REST API，可直接被 WebView/Capacitor 打包为安卓应用。
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };

/**
 * 核心导航/操作图标的接线（计划书 §3 第 78 行前半句），与桌面 app.js 完全同一套：
 * 图标只有一份定义（web/shared/icons.js 的 39 个 `<symbol>`，每个使用点一行 `<use>`），
 * `icoLabel` 只去掉**标签开头那个图标位**，文案内部的 emoji（角色/状态语义字形）一律不动。
 */
function ico(id) { return window.WWIcons.iconMarkup(id); }
function icoLabel(id, text) { return window.WWIcons.labelMarkup(id, text); }

const state = {
  meta: null, view: null,
  boardId: 'adv12', boardCounts: null,
  rules: null, mode: 'play',
  game: null, playerAfter: 0, pollTimer: null,
  // SSE 推送（P2-2）：连接 + 看门狗时间戳（断流即回退轮询）
  stream: null, streamWatchdog: null, lastStreamAt: 0,
  roleShown: false, seatNames: {}, tags: {}, lastNightStep: null,
  speakingSeat: 0,
  // 玩家档案（PROF-01）：本机档案列表 + 当前选中 id（开局随 POST /api/games 上送）
  profiles: [], profileId: null,
  // 私人标注 V2（NOTE-04）：enterGame 时初始化；loaded=已拉取过，available=服务端可读写
  anno: null,
  // FIN-04 首页：可恢复局信息（tryResume 拉到的句柄+视图摘要）；FIN-06 局内页签当前页
  resume: null, gameTab: 'speech',
  // FIN-06 §10.10：切后台时的状态快照（回前台比对，变更则作废已选目标）
  hiddenSnap: null,
  // 防双击双提交（FIN-03：双击只产生一次业务提交）
  submitting: false,
  // ---- M2-d §5.2：切档守卫要读的两个"未保存"信号（判据留在各自的弹层里，这里只存引用）----
  noteDirty: null,        // 笔记弹层的 dirty()（弹层关闭即清空）
  profileFormOpen: false, // 资料编辑弹层是否还开着
  profileFormDirty: null, // 资料编辑弹层的 dirty()（同上）
};
/**
 * 阶段值 → 中文名：**唯一真值在 web/shared/phase-label.js**（与桌面端 app.js 引用的是同一个文件、
 * 同一个对象，不是两份拷贝）。两端原来各写一张逐字相同的表，单边改一个文案不会有任何测试发现；
 * 现在改成引用，键集合与文案由 test/phase-label.test.js 的冻结台账逐字钉住。
 * 这里只保留这个名字，是为了不动下面 3 处使用点（`PHASE_LABEL[phase] || phase` 的兜底语义不变）。
 */
const PHASE_LABEL = window.WWPhaseLabel.PHASE_LABEL;

/**
 * M2-d（计划书 §5.2/§5.3）共享纯逻辑模块的**薄接线**（与桌面端 app.js 引用同一批文件）。
 * 这里只做"谁触发、画哪块 DOM"：判断与状态机全在 web/shared/ 里，Node 单测直接覆盖。
 */
let requestGuard = null;
let prefsQueue = null;

/** §5.2 请求代际：每次档案**真的变化**时换代，迟到的响应据此丢弃 */
function getRequestGuard() {
  if (!requestGuard) requestGuard = window.WWRequestGuard.createRequestGuard({ profileId: state.profileId });
  return requestGuard;
}

/** §5.3 偏好写入串行队列（同一档案串行、合并连续修改、409 重读后重试一次） */
function getPrefsQueue() {
  if (!prefsQueue) {
    prefsQueue = window.WWPrefsQueue.createPrefsQueue({
      revisionOf: (pid) => { const p = (state.profiles || []).find((x) => x.id === pid); return p ? p.revision : undefined; },
      baseOf: (pid) => { const p = (state.profiles || []).find((x) => x.id === pid); return (p && p.preferences) || {}; },
      patch: (pid, preferences, ctx) => api('PATCH', `/api/profiles/${pid}`, { expectedRevision: ctx.expectedRevision, preferences }),
      reload: async (pid) => {
        const r = await api('GET', '/api/profiles');
        const cur = (r.profiles || []).find((x) => x.id === pid);
        if (!cur) { const e = new Error('档案已不存在（可能已被删除或归档）'); e.status = 404; throw e; }
        return cur;
      },
    });
  }
  return prefsQueue;
}

/** §5.2 本窗口是否有未保存的资料或笔记（切档先确认；别的窗口切档只提示、不销毁） */
function hasUnsavedDraft() {
  try {
    if (typeof state.noteDirty === 'function' && state.noteDirty()) return true;
    if (state.profileFormOpen && typeof state.profileFormDirty === 'function' && state.profileFormDirty()) return true;
  } catch (_) { /* 守卫自身不许把切档弄卡 */ }
  return false;
}

// ---------------- 系统返回栈（FIN-06 §10.5/§10.6） ----------------
// 返回优先级：关闭最上层面板 → 当前功能页返回（页签/规则页）→ 离局确认。
// 原生返回（popstate）与页面返回按钮走同一条栈：每开一层（弹窗/弹层/检视/图鉴/规则页/对局）
// push 一条 history state（{mww: 深度}），返回时按深度逐层关，**一次返回只关一层**，
// 不出现"既关编辑又退局"。game 是栈底哨兵：返回到它时先回到发言页签、再弹离局确认，
// 确认前把 state 推回去（不真正离局）。
const backStack = []; // [{kind:'game'|'modal'|'sheet'|'inspect'|'flip'|'screen-codex'|'screen-rules', closeDom, veto}]
let overlayReplaceNext = false; // 置位后下一次 track() 顶层换内容不加深（弹窗换弹窗/弹窗换弹层）

function overlayAlive(kind) {
  if (kind === 'modal') return !!document.querySelector('#m-modal .modal-mask');
  if (kind === 'sheet') return !!$('#m-sheet').firstChild;
  if (kind === 'inspect') return !!document.querySelector('.inspect-stage');
  if (kind === 'flip') return !$('#m-flip').classList.contains('hidden');
  if (kind === 'screen-codex') return !$('#m-codex').classList.contains('hidden');
  if (kind === 'screen-rules') return !$('#m-rules').classList.contains('hidden');
  return true;
}

/** 登记一层。三种走向：① 显式 replace / swapIfOpen（换页不加深）② 顶层同类且还活着（换内容）③ 正常压栈 */
function trackOverlay(kind, closeDom, opts) {
  const o = opts || {};
  const top = backStack[backStack.length - 1];
  const replace = overlayReplaceNext || o.swapIfOpen;
  overlayReplaceNext = false;
  if (replace && top && top.kind !== 'game') { top.kind = kind; top.closeDom = closeDom; top.veto = o.veto || null; syncLayerScrollLock(); return; }
  if (top && top.kind === kind && kind !== 'game' && (o.swapIfOpen || overlayAlive(kind))) {
    top.closeDom = closeDom;
    top.veto = o.veto || null;
    syncLayerScrollLock();
    return;
  }
  backStack.push({ kind, closeDom, veto: o.veto || null });
  try { history.pushState({ mww: backStack.length }, ''); } catch (_) { /* 无痕模式等极端环境：退化为无历史管理 */ }
  syncLayerScrollLock(); // 开层后立刻锁上背景（与首帧一致，不依赖观察者的下一个微任务）
}


/** UI 关闭最上层（X/取消/遮罩/页面返回按钮）：弹栈 + 把当前 history state 对账到新深度。
 *  不调 history.back() —— back 是异步遍历，随后再开新层会互相踩（实测会把新弹层关掉）。 */
function dropTopOverlay() {
  const top = backStack.pop();
  if (!top) return null;
  try { if (history.state && history.state.mww) history.replaceState({ mww: backStack.length }, ''); } catch (_) {}
  return top;
}

/** 关闭最上层并执行 DOM 清理（页面返回按钮的统一入口） */
function dismissTop() {
  // 栈顶已死的层（被自己的 ✕ 直接清了 DOM、没走弹栈）不消耗本次返回：先逐个弹出，
  // 否则一次返回"空按"——图鉴细节层关闭后再按返回，会被死条目吃掉一按（ui:check 实测）
  while (backStack.length && !overlayAlive(backStack[backStack.length - 1].kind)) backStack.pop();
  const top = dropTopOverlay();
  if (top) { try { top.closeDom(); } catch (_) {} }
  syncLayerScrollLock();
  return top;
}

// 原生返回：与页面返回一致 —— 按深度逐层关；game 哨兵 = 先回发言页签，再离局确认
window.addEventListener('popstate', (e) => {
  const target = (e.state && e.state.mww) || 0;
  // 先丢弃 DOM 已死的残留条目（刷新后的历史残留），避免"空按"返回
  while (backStack.length && !overlayAlive(backStack[backStack.length - 1].kind) && backStack.length > target) backStack.pop();
  while (backStack.length > target) {
    const top = backStack[backStack.length - 1];
    if (top.kind === 'game') {
      // 不能一次返回既关面板又退局：先确认；确认框开着时再按返回 = 取消
      const depthBefore = backStack.length;
      if (state.gameTab && state.gameTab !== 'speech') { setGameTab('speech'); }
      else { askLeaveGame(); }
      // askLeaveGame 自己压了确认层时不再叠加哨兵，避免留下"死条目"（按一次返回没反应）
      if (backStack.length === depthBefore) { try { history.pushState({ mww: backStack.length }, ''); } catch (_) {} }
      return;
    }
    if (top.veto && top.veto()) { try { history.pushState({ mww: backStack.length }, ''); } catch (_) {} return; }
    backStack.pop();
    try { top.closeDom(); } catch (_) {}
    if (top.kind === 'modal' && state.leaveAskOpen) {
      // 返回键关掉的是"离局确认"= 取消离局：停在这一层（一次返回只关一层），不穿透到退局
      state.leaveAskOpen = false;
      try { history.pushState({ mww: backStack.length }, ''); } catch (_) {}
      return;
    }
  }
  syncLayerScrollLock(); // 一次返回可能连关多层：循环结束后按最终状态重算滚动锁
});

/**
 * 从对局列表的一行恢复对局：取令牌 → 写本机句柄 → 进对局。
 * 「我的对局」弹层与玩家中心②组**共用这一份** —— 两处各写一遍必然漂移
 * （其中一处迟早会漏掉句柄落盘或 mock 标记）。
 */
async function resumeFromRow(r, btn) {
  if (btn) btn.disabled = true;
  try {
    const t = await api('GET', `/api/games/${r.id}/tokens`);
    const handle = { gameId: r.id, playerToken: t.player, godToken: t.god, mock: !!r.mock, savedAt: Date.now() };
    state.resume = { handle, fromDisk: !r.inMemory };
    try { window.WWGameDraft.writeHandle(localStorage, 'mww_current', handle); } catch (_) { /* 隐私模式忽略 */ }
    $('#m-modal').innerHTML = '';
    resumeGame();
  } catch (e) {
    if (btn) btn.disabled = false;
    flash(`恢复失败：${e.message}`);
  }
}

/** AC-11：我的对局列表（当前档案）——可恢复局置顶可继续，已结束局只读展示 */
async function showMyGamesSheet() {
  if (!state.profileId) { flash('尚未选择档案', ''); return; }
  let rows = [];
  try {
    const r = await api('GET', `/api/profiles/${state.profileId}/games`);
    rows = r.rows || [];
  } catch (e) { flash(`对局列表加载失败：${e.message}`); return; }
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', icoLabel('game', '我的对局')));
  const body = el('div', 'mbody');
  if (!rows.length) { body.appendChild(el('p', 'hint', '当前档案还没有对局。回「开始」页开一局吧。')); }
  else {
    const unfinished = rows.filter((r) => window.SessionModel.canResume(r));
    const finished = rows.filter((r) => r.finished).slice(0, 20);
    for (const r of unfinished) {
      const row = el('div', 'pm-row current');
      const main = el('div', 'pm-main');
      main.appendChild(elText('div', 'pm-name', `${r.mock ? '🧪' : '💳'} ${r.id}`));
      main.appendChild(el('div', 'hint', `第 ${r.day || 0} 天 · ${r.phase || ''} · 进行中`));
      row.appendChild(main);
      const ops = el('div', 'pm-ops');
      const go = el('button', 'btn small', '继续');
      go.addEventListener('click', () => resumeFromRow(r, go));
      ops.appendChild(go);
      row.appendChild(ops);
      body.appendChild(row);
    }
    for (const r of finished) {
      const row = el('div', 'pm-row');
      const main = el('div', 'pm-main');
      main.appendChild(elText('div', 'pm-name', `${r.mock ? '🧪' : '💳'} ${winnerText(r.winner)}`));
      main.appendChild(el('div', 'hint', `第 ${r.day || 0} 天 · ${r.savedAt ? new Date(r.savedAt).toLocaleString() : ''}`));
      row.appendChild(main);
      body.appendChild(row);
    }
  }
  const close = el('button', 'btn ghost', '关闭');
  close.addEventListener('click', closeModalTop);
  body.appendChild(close);
  wrap.appendChild(body);
  openModal(wrap);
}

/** 关掉当前最上层的"非 game"层。返回是否真的关掉了一层。
 *  veto 未通过（有未保存草稿）时"不关"，但返回 true —— 因为 veto 自己会弹出确认框，
 *  对玩家来说已经是一次可读反馈，不该再让调用方去关下一层。
 *  返回键（popstate / __mwwBack）与 Esc（__wwEscClose）共用这一份，避免两条关闭路径行为漂移。 */
function closeTopOverlayLayer() {
  while (backStack.length && !overlayAlive(backStack[backStack.length - 1].kind)) backStack.pop();
  const top = backStack[backStack.length - 1];
  if (!top || top.kind === 'game') return false;
  if (top.veto && top.veto()) return true;
  backStack.pop();
  try { top.closeDom(); } catch (_) {}
  if (top.kind === 'modal' && state.leaveAskOpen) {
    // 关掉的是"离局确认"= 取消离局：复位标志，之后仍可再次询问（与 popstate 分支同语义）
    state.leaveAskOpen = false;
    try { history.replaceState({ mww: backStack.length }, ''); } catch (_) {}
  }
  syncLayerScrollLock(); // 关层后立刻按"还剩几层"重算滚动锁，绝不把页面锁死
  return true;
}

/** Android 硬件返回桥（Capacitor 无 @capacitor/app，由 MainActivity 拦截返回键后调用）：
 *  与 popstate 同一条返回栈——处理一层；返回 true=已消费（留在应用），false=栈空（交给系统最小化）。
 *  计划 §10-5：关闭最上层面板 → 功能页返回（发言页签）→ 离局确认；一次返回只关一层。 */
window.__mwwBack = function () {
  while (backStack.length && !overlayAlive(backStack[backStack.length - 1].kind)) backStack.pop();
  if (!backStack.length) return false;
  const top = backStack[backStack.length - 1];
  if (top.kind === 'game') {
    if (state.gameTab && state.gameTab !== 'speech') { setGameTab('speech'); return true; }
    askLeaveGame();
    if (state.leaveAskOpen) { try { history.replaceState({ mww: backStack.length }, ''); } catch (_) {} }
    return true;
  }
  return closeTopOverlayLayer();
};

/**
 * Esc 关浮层（FIX-08）：监听器由 web/pwa.js 统一分发（全页只有一个 Esc 监听器）。
 * 只关"可关闭的浮层"，**不触发离局确认** —— Esc 不该等价于"退出对局"：栈底 game 哨兵时
 * 返回 false，pwa.js 据此认为"没有可关的层"。关闭一律走返回栈的统一关闭（遮罩、软键盘监听、
 * 返回栈深度、滚动锁都在那里清理），不再有"直接改 hidden"的旁路。
 */
window.__wwEscClose = function () {
  return closeTopOverlayLayer();
};

// ---------------- 浮层滚动锁（FIX-08） ----------------
/** 只要还有浮层开着就把 body 锁住，全关掉立刻释放。
 *  这里刻意**不**依赖"每条关闭路径都记得调用"这种约定——那种约定必然漏（按钮/遮罩/Esc/
 *  返回键/程序化关闭一共五条路，漏一条就是"浮层关了但页面再也滚不动"）。
 *  改为 MutationObserver 盯住真正的浮层容器，DOM 一变就重算；观察范围收窄到这四个容器，
 *  不订阅整个 body 子树（手机端事件流刷新很频繁，避免每次插入都重算）。 */
function syncLayerScrollLock() {
  const open = overlayAlive('modal') || overlayAlive('sheet') || overlayAlive('inspect') || overlayAlive('flip');
  document.body.classList.toggle('ww-layer-open', open);
}
for (const sel of ['#m-modal', '#m-sheet', '#m-flip']) {
  const node = document.querySelector(sel);
  if (!node) continue;
  // #m-flip 是静态节点、靠 class 切换显隐；#m-modal/#m-sheet 靠增删子节点
  new MutationObserver(syncLayerScrollLock).observe(node, sel === '#m-flip' ? { attributes: true, attributeFilter: ['class'] } : { childList: true });
}
// .inspect-stage 是直接挂在 body 上的浮层（开/关 = body 增删一个子节点）
new MutationObserver(syncLayerScrollLock).observe(document.body, { childList: true });

/** 底部弹层关闭前的一次性清理（换页/关层都要跑）。目前只有裁切页用它释放 ImageBitmap：
 *  位图不进 DOM、不会被 innerHTML = '' 回收，必须在所有出口显式 close()。 */
let sheetTeardown = null;
function runSheetTeardown() {
  if (!sheetTeardown) return;
  const fn = sheetTeardown;
  sheetTeardown = null;
  try { fn(); } catch (_) { /* 清理失败不得阻断关层 */ }
}
// M2-d §5.2：任何一次清空弹层都意味着"上一层已被销毁"——它登记的 dirty() 引用必须一起失效，
// 否则切档守卫会拿着一个已经不在页面上的表单，一直弹"有未保存内容"。
// （笔记/资料编辑器在**打开弹层之后**才登记自己的 dirty，见 openTagModal / openProfileEdit 末尾。）
function forgetOverlayDirty() { state.noteDirty = null; state.profileFormOpen = false; state.profileFormDirty = null; }
function closeModalDom() { $('#m-modal').innerHTML = ''; forgetOverlayDirty(); syncLayerScrollLock(); }
function closeSheetDom() { if (sheetViewportCleanup) sheetViewportCleanup(); sheetViewportCleanup = null; runSheetTeardown(); $('#m-sheet').innerHTML = ''; forgetOverlayDirty(); syncLayerScrollLock(); }
/** UI 关闭中部弹窗（X / 取消 / 按钮） */
function closeModalTop() {
  const top = backStack[backStack.length - 1];
  if (top && top.kind === 'modal') dropTopOverlay();
  closeModalDom();
}
/** UI 关闭底部弹层：有未保存修改时先过 veto（确认放弃），通过才真正关 */
function sheetDismiss() {
  const top = backStack[backStack.length - 1];
  if (top && top.kind === 'sheet' && top.veto && top.veto()) return;
  if (top && top.kind === 'sheet') dropTopOverlay();
  closeSheetDom();
}
/** 关闭底部弹层（保存成功/放弃等既有调用点）：直接关，不再询问 */
function closeSheet() {
  const top = backStack[backStack.length - 1];
  if (top && top.kind === 'sheet') dropTopOverlay();
  closeSheetDom();
}

/** 离局确认（返回栈的 game 哨兵触发；进度已落盘，可从首页「继续上局」回来） */
function askLeaveGame() {
  if (state.leaveAskOpen) return;
  state.leaveAskOpen = true;
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', '退出对局？'));
  wrap.appendChild(el('p', null, '对局进度已保存，退出后可从首页「继续上局」回来。要退出吗？'));
  const row = el('div', 'btnrow');
  const leave = el('button', 'btn danger', '退出到首页');
  leave.addEventListener('click', () => { state.leaveAskOpen = false; closeModalTop(); window.WWGameDraft.clearHandle(localStorage, 'mww_current'); location.reload(); });
  const stay = el('button', 'btn primary', '继续对局');
  stay.addEventListener('click', () => { state.leaveAskOpen = false; closeModalTop(); });
  row.append(leave, stay);
  wrap.appendChild(row);
  openModal(wrap);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.auth === 'pairing') showPairingGate(); // LAN 模式未配对（SEC-01）
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status; // 档案/标注的 409 并发冲突靠它精确识别（服务端文案里未必含"409"字样）
    throw err;
  }
  return data;
}

// ---------------- 局域网配对门（整改 SEC-01 的前端半边） ----------------
// LAN 模式下未配对的管理请求会拿到 401 {auth:'pairing'}：弹配对码输入层，
// 配对成功写会话 Cookie 后自动刷新。配对码显示在服务本机的设置页上。
let pairingGateShown = false;
function showPairingGate() {
  if (pairingGateShown) return;
  pairingGateShown = true;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(2,4,10,.88);display:flex;align-items:center;justify-content:center';
  wrap.innerHTML = '<div style="background:#0d1322;border:1px solid #2a3552;border-radius:12px;padding:22px 26px;max-width:340px;text-align:center">' +
    '<h3 style="margin:0 0 8px;color:#e8c56a">🌐 局域网配对</h3>' +
    '<p style="margin:0 0 12px;color:#9fb0d0;font-size:13px">这台设备尚未与管理会话配对。请查看<b style="color:#e8c56a">服务本机</b>设置页顶部的 6 位配对码，在下方输入（5 分钟内有效）。</p>' +
    '<input id="pair-code" inputmode="numeric" maxlength="6" placeholder="6 位配对码" style="width:100%;box-sizing:border-box;text-align:center;font-size:22px;letter-spacing:8px;padding:8px;background:#0a0f1c;border:1px solid #2a3552;border-radius:8px;color:#fff">' +
    '<div style="display:flex;gap:8px;margin-top:12px"><button id="pair-go" style="flex:1;padding:8px;background:#c9a227;border:0;border-radius:8px;font-weight:700">配对</button><button id="pair-cancel" style="padding:8px 12px;background:#1a2338;border:1px solid #2a3552;border-radius:8px;color:#9fb0d0">取消</button></div>' +
    '<p id="pair-err" style="color:#ff8080;font-size:12px;min-height:16px;margin:8px 0 0"></p></div>';
  document.body.appendChild(wrap);
  const done = () => location.reload();
  wrap.querySelector('#pair-cancel').addEventListener('click', () => wrap.remove());
  const go = async () => {
    const code = wrap.querySelector('#pair-code').value.trim();
    try {
      const r = await fetch('/api/auth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (r.ok) return done();
      const j = await r.json().catch(() => ({}));
      wrap.querySelector('#pair-err').textContent = j.error || '配对失败';
    } catch (e) { wrap.querySelector('#pair-err').textContent = e.message; }
  };
  wrap.querySelector('#pair-go').addEventListener('click', go);
  wrap.querySelector('#pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  wrap.querySelector('#pair-code').focus();
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 整改（审核 P1-3）：不可信内容专用 textContent 创建器 —— 结算弹层的复盘文本靠它
const elText = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = String(text); return d; };
const roleInfo = (rid) => state.meta.roles[rid];
// 安全（整改 SEC-02）：昵称是用户可控输入，seatLabel 的返回值只用于 innerHTML 模板，源头转义
const seatLabel = (seat) => { const raw = state.seatNames[seat] || ''; const n = escapeHtml(raw); return `${seat}号${n && n !== `${seat}号` ? ' ' + n : ''}`; };
const isMine = (e) => state.view && state.view.me && e.actor === state.view.me.seat;

// ---------------- 屏1：首页（品牌 / 档案 / 继续上局 / 开始新局） ----------------
async function init() {
  state.meta = await api('GET', '/api/meta');
  state.rules = JSON.parse(JSON.stringify(state.meta.defaultRules));
  applyBoard('adv12');
  renderBoardGrid();
  wireSettings();
  wirePlayerCenter(); // 屏2b 玩家中心：返回键 + ③ 外观与操作那三个控件（内容渲染在 renderPlayerCenter）
  $('#m-next').addEventListener('click', gotoRules);
  $('#m-back').addEventListener('click', () => { if (!dismissTop()) showScreen('m-boards'); });
  $('#m-start').addEventListener('click', startGame);
  // P2-b：试玩开关必须一眼可见。它原来只藏在「⚙ 设置」弹窗最底下，
  // 实测出现过"以为在试玩、其实在花额度"（设置弹窗里的勾选状态看不见）。
  if ($('#m-mock-btn')) {
    const setMode = (mockMode) => {
      if (state.mock === mockMode) return;
      state.mock = mockMode;
      syncMockBtn();
      flash(state.mock ? '🧪 已切换为 Mock 试玩：不调用 API、不消耗额度' : '💳 已切换为真实对局：会调用 API 并消耗额度');
    };
    $('#m-mock-btn').addEventListener('click', () => setMode(true));
    const realBtn = document.querySelector('#m-real-btn');
    if (realBtn) realBtn.addEventListener('click', () => setMode(false));
    syncMockBtn();
  }
  $('#m-gear').addEventListener('click', openGear);
  $('#m-codex-btn').addEventListener('click', () => openCodex());
  $('#m-codex-back').addEventListener('click', () => { if (!dismissTop()) closeCodexDom(); });
  $('#m-rulebook-btn').addEventListener('click', openRulebook);
  $('#m-mycard').addEventListener('click', showMyCard);
  $('#m-to-bottom').addEventListener('click', () => { scrollFlow(true); });
  $('#m-flow').addEventListener('scroll', onFlowScroll);
  $('#m-my-seat').addEventListener('change', () => {
    window.WWGameDraft.writeSeat(localStorage, 'ww_seat', $('#m-my-seat').value);
    renderSeatSelect();
  });
  $('#m-inspect-btn').addEventListener('click', () => state.view && state.view.me && openInspect(state.view.me.role));
  $('#m-flip-card').addEventListener('click', () => $('#m-flip-card').classList.add('flipped'));
  // 翻牌浮层也要进返回栈：返回键先收翻牌，而不是穿透到离局确认
  $('#m-flip-done').addEventListener('click', () => dismissFlip());
  // 玩家档案（PROF-01）：选择 + 管理 + "我的昵称"手改标记。加载失败不阻塞开局（服务端会归默认档案）
  $('#m-profile-select').addEventListener('change', (e) => onSelectProfile(e.target.value));
  $('#m-profile-manage').addEventListener('click', openProfileManager);
  $('#m-my-name').addEventListener('input', () => {
    $('#m-my-name').dataset.touched = '1';
    // R06：与档案昵称同一把尺子（20 码点）
    const c = window.WWProfileState.clampProfileText($('#m-my-name').value, window.WWProfileState.NICKNAME_MAX);
    if (c !== $('#m-my-name').value) $('#m-my-name').value = c;
  });
  // ---- FIN-04 首页 ----
  $('#m-play-new').addEventListener('click', () => {
    const grid = $('#m-board-grid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flash('第一步：选择板子', '');
  });
  $('#m-profile-chip').addEventListener('click', openProfileManager);
  $('#m-resume-go').addEventListener('click', resumeGame);
  $('#m-tab-start').addEventListener('click', () => {
    $('.m-home-scroll') && $('.m-home-scroll').scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#m-tab-game').addEventListener('click', async () => {
    await showMyGamesSheet(); // AC-11：按档案列出可恢复/已结束对局，而非一句提示
  });
  $('#m-tab-codex').addEventListener('click', () => openCodex());
  // 「我的」= 独立页面（计划书 §5），不再只打开档案管理弹层；弹层仍是子流程（列表/编辑/回收站）
  $('#m-tab-me').addEventListener('click', openPlayerCenter);
  // ---- FIN-06 局内页签 ----
  $('#m-tabbtn-speech').addEventListener('click', () => setGameTab('speech'));
  $('#m-tabbtn-players').addEventListener('click', () => setGameTab('players'));
  $('#m-tabbtn-notes').addEventListener('click', () => setGameTab('notes'));
  // ---- FIN-06 §10.10：回前台从服务端重新确认状态（锁屏/切后台/切网） ----
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const v = state.view;
      state.hiddenSnap = v ? { day: v.day, phase: v.phase, task: (v.pending && v.pending.task) || '' } : null;
      persistGameHandle(true); // 离开前台：立即落一次"保存时间"
    } else if (state.game && state.game.gameId) {
      if (!state.stream) startPolling(); // 后台被系统杀掉的定时器/SSE 在这里救活
      poll();
    }
  });
  window.addEventListener('online', () => { if (state.game && state.game.gameId) poll(); });
  window.addEventListener('storage', async (e) => {
    if (!window.WWProfileState.isSelectionKey(e.key)) return;
    // §5.2：**另一个窗口**切换了当前档案。本窗口正有未保存的资料/笔记时决策是 `defer` ——
    // 不弹原生确认框（那是本窗口自己的切档才该问的），更不许把正在填的内容删掉；
    // 只如实提示"那边切到了哪个档案，草稿仍归原档案"。
    const decision = window.WWSwitchGuard.decideSwitch({ dirty: hasUnsavedDraft(), source: window.WWSwitchGuard.OTHER_WINDOW });
    if (decision.action === 'defer') {
      const other = (state.profiles || []).find((x) => x.id === e.newValue);
      flash(`${decision.reason}${other ? `（另一窗口切到了「${other.nickname}」）` : ''}`);
    }
    await loadProfiles();
    if (!state.game) await loadResumeCard();
  });
  await loadProfiles();
  await loadResumeCard();
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
    // 检视大卡替换齿轮这一层（replace）：返回键一层一层关，不留下已关闭的影子层
    rows.push([icoLabel('card', '查看我的身份牌'), () => { closeModalDom(); openInspect(v.me.role, true); }]);
  }
  // 设置弹窗由 openModal 自动"换内容"（同一层），返回深度不变
  // 这一条与其余齿轮项统一走共享徽记（A3b）：文案仍是**恰好**「设置」——
  // 不许写成"设置（可改接口/模型）"那种谎报（对局中确实改不了接口/模型/节奏，理由见 openSettingsModal）。
  // 门禁也从"textContent 逐字等于 '⚙ 设置'"改成"按徽记定位（#wwIcSettings）+ 文案恰好等于「设置」"
  // （scripts/ui-check.js 的手机端齿轮段），所以换徽记不再判红，而**谎报反而会判红**。
  rows.push([icoLabel('settings', '设置'), () => openSettingsModal()]);
  rows.push([icoLabel('codex', I18N.t('codex.entry')), () => { closeModalDom(); openCodex(true); }]);
  rows.push([icoLabel('lang', `切换语言（当前${I18N.getLang() === 'en' ? ' English' : ' 中文'}）`), () => { closeModalTop(); toggleLang(); }]);
  if (inGame && !over) {
    rows.push([icoLabel('end', '结束本局'), () => askTerminate()]);
  } else {
    rows.push([icoLabel('home', '返回首页'), () => { window.WWGameDraft.clearHandle(localStorage, 'mww_current'); location.reload(); }]);
  }
  // 必须传**无类名的普通容器**：openModal 会把它 unwrap，只保留自己那一层 .modal。
  // 传 el('div','modal') 会多套一层 position:fixed 的内层 .modal（脱离文档流），
  // 外层 .modal 于是没有在流内容 → 塌成两条边框（2px）——真机上就是"点开只有一条线"。
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', icoLabel('settings', '设置')));
  const box = el('div', 'gear-list');
  rows.forEach(([label, fn]) => {
    const b = el('button', 'gear-item' + (/结束本局/.test(label) ? ' danger' : ''), label);
    b.addEventListener('click', fn);
    box.appendChild(b);
  });
  wrap.appendChild(box);
  wrap.appendChild(el('p', 'hint', inGame
    ? `对局 ${state.game.gameId}${v && v.day ? ` · 第 ${v.day} 天` : ''}${over ? ' · 已结算' : ''}`
    : ''));
  const close = el('button', 'btn ghost', '关闭');
  close.addEventListener('click', closeModalTop);
  wrap.appendChild(close);
  openModal(wrap);
}

function askTerminate() {
  // 必须传**无类名的普通容器**：openModal 会把它 unwrap，只保留自己那一层 .modal。
  // 传 el('div','modal') 会多套一层 position:fixed 的内层 .modal（脱离文档流），
  // 外层 .modal 于是没有在流内容 → 塌成两条边框（2px）——真机上就是"点开只有一条线"。
  const wrap = el('div');
  wrap.appendChild(el('h3', 'mtitle', icoLabel('end', '结束本局')));
  wrap.appendChild(el('p', null, '结束后本局不可恢复，将直接结算并公开所有身份。确定要结束吗？'));
  const row = el('div', 'btnrow');
  const yes = el('button', 'btn danger', '确定结束');
  yes.addEventListener('click', () => { closeModalTop(); terminateGame(); });
  const no = el('button', 'btn', '取消');
  no.addEventListener('click', closeModalTop);
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
  wrap.appendChild(el('h3', 'mtitle', icoLabel('settings', '设置')));
  const body = el('div', 'mbody');
  // FIN-03/§8.3：API 配置是安装级的——说明归属，避免"切档案怎么 Key 也变了"的误解
  body.appendChild(el('p', 'hint', '🔑 接口 / 模型 / Key 属于安装级配置：此设备共享，不随玩家档案切换；开局时即已固化，对局中不可修改，请回首页调整。'));

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

  // 外观与操作（档案级偏好，计划 §8.3）：字号/布局/减少动态——真实开关，保存到当前档案
  body.appendChild(el('p', 'hint', '🎨 外观与操作（档案级，保存后立即生效）'));
  const prefBox = el('div');
  prefBox.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:0 0 12px;';
  const mkSel = (id, options, value) => {
    const sel = el('select');
    sel.id = id;
    for (const [val, label] of options) sel.appendChild(el('option', null, label)).value = val;
    sel.value = value;
    sel.addEventListener('change', onPrefControlChangeM);
    return sel;
  };
  const cur = currentProfilePrefs();
  const curFont = Number(cur.fontScale) > 1 ? 'lg' : (Number(cur.fontScale) > 0 && Number(cur.fontScale) < 1 ? 'sm' : 'std');
  const rowF = el('label');
  rowF.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
  rowF.appendChild(el('span', null, '界面字号'));
  rowF.appendChild(mkSel('m-pref-font', [['sm', '小'], ['std', '标准'], ['lg', '大']], curFont));
  const rowL = el('label');
  rowL.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
  rowL.appendChild(el('span', null, '阅读布局'));
  rowL.appendChild(mkSel('m-pref-layout', [['reading', '阅读'], ['compact', '紧凑']], cur.layout === 'compact' ? 'compact' : 'reading'));
  const rowM = el('label');
  rowM.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
  rowM.appendChild(el('span', null, '减少动态效果'));
  const mchk = el('input');
  mchk.type = 'checkbox';
  mchk.id = 'm-pref-motion';
  mchk.checked = !!cur.reducedMotion;
  mchk.addEventListener('change', onPrefControlChangeM);
  rowM.appendChild(mchk);
  prefBox.append(rowF, rowL, rowM);
  body.appendChild(prefBox);

  // AC-08：待清理恢复记录的移动端可见入口（列出计数 + 重试）—— 与玩家中心④数据管理共用一份实现
  body.appendChild(el('p', 'hint', '🧹 待清理恢复记录'));
  body.appendChild(recoveryBlock());

  const list = el('div', 'gear-list');
  const add = (label, fn, danger) => {
    const b = el('button', 'gear-item' + (danger ? ' danger' : ''), label);
    b.addEventListener('click', fn);
    list.appendChild(b);
  };
  add(icoLabel('codex', I18N.t('codex.entry')), () => { closeModalDom(); openCodex(true); });
  if (inGame && v && v.me && v.me.role) add(icoLabel('card', '查看我的身份牌'), () => { closeModalDom(); openInspect(v.me.role, true); });
  add(icoLabel('lang', `切换语言（当前${I18N.getLang() === 'en' ? ' English' : ' 中文'}）`), () => { closeModalTop(); toggleLang(); });
  // 这条是"真路"而不是假开关：回首页 = 重载页面，本局存在浏览器里（mww_current），
  // 首页会出现"继续对局"卡片，所以可以放心去改设置再回来。
  add(icoLabel('settings', '去首页改接口 / 模型 / 节奏（本局会保存）'), () => { location.reload(); });
  body.appendChild(list);

  body.appendChild(el('p', 'hint', '接口 / 模型 / 节奏是服务端配置：各 AI 的参数在开局时就已经发给它，所以对局中改动不会影响正在进行的这一局（这就是它"看起来失效"的原因）。要调整请回首页设置 —— 本局会保存，随时能继续。'));
  wrap.appendChild(body);

  const row = el('div', 'btnrow');
  if (inGame && !(v && v.finished)) {
    const end = el('button', 'btn danger', icoLabel('end', '结束本局'));
    end.addEventListener('click', () => askTerminate());
    row.appendChild(end);
  }
  const home = el('button', 'btn danger', icoLabel('home', '退出到首页（放弃本局）'));
  home.addEventListener('click', () => { window.WWGameDraft.clearHandle(localStorage, 'mww_current'); location.reload(); });
  row.appendChild(home);
  wrap.appendChild(row);
  openModal(wrap);
}

/** 切换界面语言：不刷新页面（局中刷新会打断对局），I18N.setLang 会立刻重刷所有 data-i18n 节点 */
function toggleLang() {
  const next = I18N.getLang() === 'en' ? 'zh-CN' : 'en';
  I18N.setLang(next);
  // i18n 会整块重写 data-i18n 元素的 textContent（词典里的导航文案仍带前导图标字形），
  // 所以必须在这里按 data-ww-icon 重画一遍，否则切一次语言徽记就退回 emoji。
  window.WWIcons.mount(document);
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
  wrap.appendChild(el('h3', 'mtitle', icoLabel('summary', '本局总结')));
  const body = el('div', 'mbody');

  const result = v.winner === 'good' ? '🎉 好人阵营获胜'
    : v.winner === 'wolf' ? '🐺 狼人阵营获胜'
      : v.winner === 'draw' ? '🤝 平局（未分胜负）' : '⏹ 对局终止';
  const rname = (rid) => (roleInfo(rid) || {}).name || rid;
  // 安全（审核 P1-5）：复盘正文是模型输出 —— 单独用 textContent 渲染，不进 innerHTML
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
      // ⚠ details 是**字符串数组**（src/engine/score.js:26 push 的是 "+5 守刀成功 2 夜" 这种整句），
      // 不是对象。早先这里按 d.points / d.label 取值，每一行都渲染成空字符串 ——
      // 真机截图（output/takeover-2026-09-20/mobile-summary.png）里"我的得分构成"标题下面
      // 一片空白就是这个原因。验收时发现并修正。
      list.appendChild(el('div', 'set-row', `<span>${escapeHtml(String(d))}</span><b></b>`));
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
  // 安全（审核 P1-5）：复盘文本是模型输出，必须 textContent
  const rev = elText('p', 'hint', (v.review && v.review.text) || '');
  rev.id = 'm-review-box';
  body.appendChild(rev);
  wrap.appendChild(body);
  const row = el('div', 'btnrow');
  const coach = el('button', 'btn', icoLabel('coach', '生成 AI 复盘'));
  coach.addEventListener('click', () => requestReview());
  row.appendChild(coach);
  const close = el('button', 'btn', '关闭');
  close.addEventListener('click', closeModalTop);
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
function hideFlipDom() { $('#m-flip').classList.add('hidden'); syncLayerScrollLock(); }
function dismissFlip() {
  const top = backStack[backStack.length - 1];
  if (top && top.kind === 'flip') dropTopOverlay(); // 返回键/完成键同一条路径：只关翻牌这一层
  hideFlipDom();
}
function showMyCard() {
  if (!state.view || !state.view.me || !state.view.me.role) return;
  const wasOpen = !$('#m-flip').classList.contains('hidden');
  hideFlipDom();
  $('#m-flip-card').classList.add('flipped'); // 直接亮正面
  $('#m-flip').classList.remove('hidden');
  trackOverlay('flip', hideFlipDom, { swapIfOpen: wasOpen });
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
    const head = el('div', 'mhead', `<h2>${ico('settings')} AI 设置</h2>`);
    const close = el('button', 'btn ghost small', '✕');
    close.addEventListener('click', closeModalTop);
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
function openCodex(replace) {
  state.codexFrom = ['m-boards', 'm-rules', 'm-game'].find((id) => !$('#' + id).classList.contains('hidden')) || 'm-boards';
  showScreen('m-codex');
  // 进入返回栈：从齿轮/设置弹窗里进来时替换那一层（replace），返回键不空关一层
  if (replace) overlayReplaceNext = true;
  trackOverlay('screen-codex', closeCodexDom);
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

function closeCodexDom() { showScreen(state.codexFrom || 'm-boards'); }

// ---------------- 屏2b：玩家中心（计划书 §5） ----------------
/**
 * 手机「我的」= **独立页面**（与 #m-boards / #m-codex / #m-rules / #m-game 同级的 `section.m-screen`），
 * 不再是"点一下就弹底部弹层"。四组的**顺序与组名**写死在 index.html 的 DOM 里
 * （`data-ww-group="profile|games|appearance|data"`，标题逐字取自计划书 §5），
 * 本文件只按顺序把各组内容填进去 —— 这里不做任何排序或搬移，**顺序是结构事实**
 * （守卫见 test/player-center.test.js：组的次序被打乱即判红）。
 * 原有底部弹层仍保留给子流程：档案列表 / 编辑资料 / 裁切头像 / 回收站。
 */
function openPlayerCenter() {
  // 从哪一屏进来，返回就回哪一屏（与 #m-codex 的 codexFrom 同一套做法）
  state.playerFrom = ['m-boards', 'm-rules', 'm-game', 'm-codex'].find((id) => !$('#' + id).classList.contains('hidden')) || 'm-boards';
  showScreen('m-player');
  trackOverlay('screen-player', closePlayerCenterDom);
  renderPlayerCenter();
}

function closePlayerCenterDom() { showScreen(state.playerFrom || 'm-boards'); }

/** 一次性接线（返回键 + ③ 外观与操作那三个控件）；内容渲染见 renderPlayerCenter() */
function wirePlayerCenter() {
  $('#m-player-back').addEventListener('click', () => { if (!dismissTop()) showScreen('m-boards'); });
  for (const id of ['#m-pc-pref-font', '#m-pc-pref-layout', '#m-pc-pref-motion']) {
    const n = $(id);
    if (n) n.addEventListener('change', onPcPrefControlChange);
  }
}

/** 四组一起重画：切档或子流程回来后调它，避免"只刷新了一组" */
function renderPlayerCenter() {
  renderPcProfile();
  renderPcData();
  applyProfilePrefs(currentProfilePrefs()); // ③ 外观与操作：控件是静态 HTML，回显与设置弹窗同源
  renderPcGames(); // ② 异步：自管加载态与切档竞态
}

/** 组内小标题（统计概览 / 进行中 / 最近完成） */
const pcSub = (text) => el('h4', 'pc-sub', text);

/** ① 个人资料：头像、昵称、简介、当前档案（数据全部来自 state.profiles，不造假数据） */
function renderPcProfile() {
  const box = $('#m-pc-profile');
  if (!box) return;
  box.innerHTML = '';
  const usable = state.profiles.filter((x) => !x.archivedAt);
  const p = usable.find((x) => x.id === state.profileId);
  const idRow = el('div', 'pc-id');
  const av = el('span', 'pc-av');
  idRow.appendChild(av);
  renderAvatarInto(av, p); // 与首页档案行/列表同一条渲染路径：自定义图或内置徽记，永不空白
  const who = el('div', 'pc-who');
  who.appendChild(elText('b', 'pc-nick', p ? p.nickname : (usable.length ? '未选择档案' : '默认档案')));
  who.appendChild(elText('div', 'hint', p && p.bio ? p.bio : '简介还没写（点「编辑资料」补上）'));
  if (p && p.createdAt) who.appendChild(elText('div', 'hint', `创建于 ${String(p.createdAt).slice(0, 10)}`));
  idRow.appendChild(who);
  box.appendChild(idRow);

  const field = el('label', 'pc-field');
  field.appendChild(el('span', null, '当前档案'));
  const sel = el('select');
  sel.id = 'm-pc-profile-select';
  for (const q of usable) {
    const o = el('option');
    o.value = q.id;
    o.textContent = profileLabel(q); // 昵称不可信：textContent
    sel.appendChild(o);
  }
  if (state.profileId) sel.value = state.profileId;
  sel.disabled = !usable.length;
  // 切档走与规则页选择器**同一个** onSelectProfile（写选中键 + 预填昵称 + 偏好跟着档案走），
  // 然后整页重画 —— 旧档案的头像/战绩不被留在页面上（§5.2）。
  sel.addEventListener('change', (e) => { onSelectProfile(e.target.value); renderPlayerCenter(); });
  field.appendChild(sel);
  box.appendChild(field);

  const ops = el('div', 'btnrow');
  const edit = el('button', 'btn', icoLabel(p ? 'edit' : 'create', p ? '编辑资料' : '新建档案'));
  edit.id = 'm-pc-edit';
  edit.addEventListener('click', () => openProfileEdit(p || null));
  ops.appendChild(edit);
  const manage = el('button', 'btn ghost', icoLabel('players', '档案列表…'));
  manage.id = 'm-pc-manage';
  manage.addEventListener('click', openProfileManager); // 子流程仍在弹层里（选用/归档/删除/导出）
  ops.appendChild(manage);
  box.appendChild(ops);
}

/** 已结束局的一句话结论（列表与玩家中心共用，避免两处文案各写一套） */
function winnerText(w) {
  if (w === 'wolf') return '狼阵营胜';
  if (w === 'good') return '好人阵营胜';
  return w || '已结束';
}

/** 统计概览的一行文案：**唯一真值在 web/shared/stats-bucket.js**（桌面端引用同一份）——
 *  §5.3 的两条硬口径（胜率分母=有效胜负局、分母为零显示「暂无」）不会在两端写歪成两个样子。 */
function pcStatsText(s) {
  return window.WWStatsBucket.formatAggregate(s);
}

/** ② 对局与战绩：统计概览 + 进行中 + 最近完成（全部走真实接口；三段各自加载，互不牵连） */
async function renderPcGames() {
  const box = $('#m-pc-games');
  if (!box) return;
  const pid = state.profileId;
  box.innerHTML = '';
  if (!pid) { box.appendChild(el('p', 'hint', '尚未选择档案。')); return; }

  // 三段各自独立加载（与桌面端 fillPcGames 同一套取舍）：/stats 挂了不该把"进行中"也变成空白。
  // 落笔前一律比对发起时的档案 id —— §5.2：切档后迟到的响应不得覆盖新档案的页面。
  // M2-d：再叠一层**代次票据**（request-guard）—— 只比 id 挡不住 A→B→A 绕一圈回来时
  // "旧 A 的响应冒充当前 A"这一类；两条件是"与"，比原来更严，不是放宽。
  const ticket = getRequestGuard().begin(pid);
  const fresh = () => state.profileId === pid && getRequestGuard().isCurrent(ticket);
  const seg = (title) => {
    const wrap = el('div');
    wrap.appendChild(pcSub(title));
    const body = el('div');
    body.appendChild(el('p', 'hint', '加载中…'));
    wrap.appendChild(body);
    box.appendChild(wrap);
    return body;
  };
  const fail = (body, label) => (e) => {
    if (!fresh()) return;
    body.innerHTML = '';
    body.appendChild(el('p', 'hint', `${label}读取失败：${e.message}`));
  };

  const stats = seg('统计概览');
  const unBox = seg('进行中');
  const finBox = seg('最近完成');

  api('GET', `/api/profiles/${pid}/stats`).then((st) => {
    if (!fresh()) return;
    stats.innerHTML = '';
    stats.appendChild(el('p', 'hint', pcStatsText(st)));
  }).catch(fail(stats, '统计概览'));

  api('GET', `/api/profiles/${pid}/games?status=unfinished&limit=5`).then((un) => {
    if (!fresh()) return;
    unBox.innerHTML = '';
    if (!un.rows.length) { unBox.appendChild(el('p', 'hint', '没有进行中的对局。回「开始」页开一局吧。')); return; }
    for (const r of un.rows) unBox.appendChild(pcGameRow(r, true));
  }).catch(fail(unBox, '进行中'));

  api('GET', `/api/profiles/${pid}/games?status=finished&limit=5`).then((fin) => {
    if (!fresh()) return;
    finBox.innerHTML = '';
    if (!fin.rows.length) { finBox.appendChild(el('p', 'hint', '还没有已结束的对局。')); return; }
    for (const r of fin.rows) finBox.appendChild(pcGameRow(r, false));
    if (fin.total > fin.rows.length) {
      finBox.appendChild(elText('p', 'hint', `共 ${fin.total} 局已结束，这里展示最近 ${fin.rows.length} 局。`));
    }
    const more = el('button', 'btn ghost small', icoLabel('list', '全部对局…'));
    more.id = 'm-pc-all-games';
    more.addEventListener('click', showMyGamesSheet); // 看全的分页列表仍在弹层里（同一份接口）
    finBox.appendChild(more);
  }).catch(fail(finBox, '最近完成'));
}

/** ②组的一行对局：进行中给「继续」，已结束给「历史」（day / phase / savedAt 都可能缺，逐项拼） */
function pcGameRow(r, resumable) {
  const row = el('div', 'pc-row' + (resumable ? ' current' : ''));
  const main = el('div', 'pc-main');
  main.appendChild(elText('div', 'pc-name', resumable
    ? `${r.mock ? '🧪' : '💳'} ${r.id}`
    : `${r.mock ? '🧪' : '💳'} ${winnerText(r.winner)}`));
  const parts = [`第 ${r.day || 0} 天`];
  if (r.phase) parts.push(PHASE_LABEL[r.phase] || r.phase);
  if (resumable) parts.push('进行中');
  else if (r.savedAt || r.date) parts.push(new Date(r.savedAt || r.date).toLocaleString());
  main.appendChild(elText('div', 'hint', parts.join(' · ')));
  row.appendChild(main);
  const btn = el('button', resumable ? 'btn small' : 'btn ghost small', resumable ? '继续' : '历史');
  btn.id = `m-pc-${resumable ? 'resume' : 'history'}-${r.id}`;
  btn.addEventListener('click', () => { if (resumable) resumeFromRow(r, btn); else openPcHistory(r.id); });
  row.appendChild(btn);
  return row;
}

/**
 * 已结束对局的只读历史（子流程弹层）：GET /api/profiles/:id/games/:gameId/history（M2-b 落地）。
 * 正文一律 textContent —— 事件文案是引擎/模型产出，绝不进 innerHTML。
 */
async function openPcHistory(gameId) {
  const pid = state.profileId;
  if (!pid) { flash('尚未选择档案', ''); return; }
  const body = el('div');
  body.appendChild(el('p', 'hint', '只读历史：来自存档事件，不会启动引擎、也不会调用模型。'));
  const listBox = el('div', 'pc-hist');
  listBox.id = 'm-pc-history-list'; // R04：验收定位点
  listBox.textContent = '加载中…';
  // R04：分页按钮放在列表**之下、独立一个盒子**里 —— 失败时列表内容不动（已读内容保留）
  const moreBox = el('div');
  moreBox.id = 'm-pc-history-more-box';
  body.append(listBox, moreBox);
  const foot = el('div', 'btnrow');
  const close = el('button', 'btn ghost', '关闭');
  close.addEventListener('click', closeSheet);
  foot.appendChild(close);
  openSheet(`对局历史 · ${gameId}`, body, foot, { icon: 'timeline' });
  await historyPager({
    pid, gameId, listBox, moreBox,
    mkRow: (e) => {
      const line = el('div', 'pc-hist-row');
      line.appendChild(elText('span', 'hint', `第 ${e.day || 0} 天 · ${PHASE_LABEL[e.phase] || e.phase || ''}`));
      line.appendChild(elText('span', 'pc-hist-txt', e.text || ''));
      return line;
    },
  });
}

/** ④ 数据管理：导出、导入、归档、回收站和待清理恢复记录（全部接现有接口与现有弹层） */
function renderPcData() {
  const box = $('#m-pc-data');
  if (!box) return;
  box.innerHTML = '';
  const usable = state.profiles.filter((x) => !x.archivedAt);
  const p = usable.find((x) => x.id === state.profileId);

  const ops = el('div', 'btnrow');
  const exp = el('button', 'btn ghost', '导出当前档案');
  exp.id = 'm-pc-export';
  exp.disabled = !p;
  exp.title = p ? `导出「${p.nickname}」为档案包（含战绩/笔记）` : '先选一个档案';
  exp.addEventListener('click', () => { if (p) browserExportProfile(`/api/profiles/${p.id}/export`); });
  ops.appendChild(exp);
  const imp = el('button', 'btn ghost', icoLabel('import', '导入档案包'));
  imp.id = 'm-pc-import';
  imp.addEventListener('click', openProfileImport);
  ops.appendChild(imp);
  box.appendChild(ops);

  const ops2 = el('div', 'btnrow');
  const arch = el('button', 'btn ghost', '归档当前档案');
  arch.id = 'm-pc-archive';
  arch.disabled = !p;
  arch.addEventListener('click', async () => {
    if (!p) return;
    // M2-d §5.2：两条阻止（原因与顺序由 web/shared/switch-guard.js 决定，可单测）——
    //   ① 该档案还有**未结束的对局** ⇒ 不可归档，返回明确原因，**不得悄悄终止对局**；
    //   ② 最后一个可用档案。未结束局数走服务端真实计数，不是猜的。
    let unfinished = 0;
    try {
      const r = await api('GET', `/api/profiles/${p.id}/games?status=unfinished&limit=100`);
      unfinished = (r && Number(r.total)) || ((r && r.rows) || []).length;
    } catch (e) {
      flash(`读取「${p.nickname}」的进行中对局失败：${e.message}（为避免丢掉进行中的对局，已取消本次归档）`);
      return;
    }
    const blocked = window.WWSwitchGuard.archiveBlockReason({ unfinished, usableCount: usable.length });
    if (blocked) { flash(blocked); return; }
    if (!confirm(`归档「${p.nickname}」？归档后从选择器隐藏，战绩与笔记保留，可随时恢复。`)) return;
    try {
      await api('PATCH', `/api/profiles/${p.id}`, { expectedRevision: p.revision, archive: true });
      await loadProfiles();
      renderPlayerCenter();
      flash('已归档 ✓');
    } catch (e) { flash(`归档失败：${e.message}`); }
  });
  ops2.appendChild(arch);
  const trash = el('button', 'btn ghost', icoLabel('trash', '回收站'));
  trash.id = 'm-pc-trash';
  trash.addEventListener('click', openProfileTrash);
  ops2.appendChild(trash);
  box.appendChild(ops2);

  box.appendChild(el('p', 'hint', '删除只是把档案移进回收区，战绩与笔记都还在；导入会新建 UUID，不覆盖现有档案。'));
  box.appendChild(el('p', 'hint', '待清理恢复记录（导入中断后留下的中间文件）'));
  box.appendChild(recoveryBlock()); // 与「设置」弹窗共用同一份实现，两处不漂移
}

/**
 * 「待清理恢复记录」块（AC-08）：计数 + 重试清理。
 * 手机端**两处**要它（设置弹窗、玩家中心④数据管理），所以收成一份实现 ——
 * 各写一遍必然漂移（一边显示条数、另一边永远停在"检查中…"）。
 * 失败不静默：文案直接写清原因（不可用时把重试键收起来）。
 */
function recoveryBlock() {
  const box = el('div');
  const line = el('div', 'hint');
  line.textContent = '检查中…';
  const btn = el('button', 'btn ghost small', '重试清理');
  btn.style.marginBottom = '10px';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/import/recoveries/retry');
      line.textContent = r.remaining ? `仍有 ${r.remaining} 条待清理（残留文件被占用）` : '没有待清理的恢复记录 ✓';
      btn.disabled = !r.remaining;
    } catch (e) {
      line.textContent = `重试失败：${e.message}`;
      btn.disabled = false;
    }
  });
  api('GET', '/api/import/recoveries').then((r) => {
    const n = (r.items || []).length;
    line.textContent = n ? `有 ${n} 条待清理恢复记录` : '没有待清理的恢复记录 ✓';
    if (!n) btn.style.display = 'none';
  }).catch(() => {
    line.textContent = '恢复记录不可用（需管理会话）';
    btn.style.display = 'none';
  });
  box.append(line, btn);
  return box;
}

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
  close.addEventListener('click', closeModalTop);
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
  // 'm-player'（屏2b 玩家中心）与其余四屏同级：切换即整屏显隐，与 #m-codex 同一套做法
  ['m-boards', 'm-codex', 'm-player', 'm-rules', 'm-game'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
}

function gotoRules() {
  showScreen('m-rules');
  trackOverlay('screen-rules', () => showScreen('m-boards')); // 返回键：从第二步回到第一步（保留已选项）
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
  return window.WWGameDraft.readSeat(localStorage, 'ww_seat'); // 与桌面版共用同一个键
}

// ---------------- 底部弹层（手机习惯的交互容器） ----------------
// 中部 modal（#m-modal）适合短内容；档案管理（PROF-01）与私人标注编辑（NOTE-04）
// 用贴底弹层：拇指够得着按钮、输入框离软键盘近，长表单也不挤在屏幕中央。
// 结构约束：max-height: min(85dvh, 100%)，正文（.m-sheet-body）内部滚动，
// 保存/取消固定在 .m-sheet-foot —— 键盘弹出时按钮也不被顶走。
let sheetViewportCleanup = null;
function openSheet(title, bodyEl, footEl, opts) {
  const o = opts || {};
  const root = $('#m-sheet');
  if (!root) return null;
  const wasOpen = !!root.firstChild; // 弹层内换页（档案列表↔编辑）：同一层换内容，返回深度不加深
  if (sheetViewportCleanup) sheetViewportCleanup(); // 换页前先摘掉上一层的视口监听（避免叠加）
  runSheetTeardown(); // 换页同理：上一页的一次性清理必须先跑（例如裁切页的位图）
  forgetOverlayDirty(); // M2-d §5.2：换页/重开 = 上一页的表单已经不在 DOM 上，它的 dirty() 一并失效
  root.innerHTML = '';
  const mask = el('div', 'm-sheet-mask');
  const sheet = el('div', 'm-sheet');
  const head = el('div', 'm-sheet-head');
  const t = el('h3');
  // 标题可能拼座位昵称：文字一律走 createTextNode，不进 innerHTML（安全线不变）。
  // 徽记是**本次改造新增**的那一半：`o.icon` 只是 icons.js 白名单里的一个 id，
  // 认不出来的 id 会被 normalizeId 拒掉（返回空串），所以它同样不是用户输入。
  if (o.icon) t.insertAdjacentHTML('afterbegin', window.WWIcons.iconMarkup(o.icon));
  t.appendChild(document.createTextNode(window.WWIcons.plainLabel(title || '')));
  head.appendChild(t);
  const close = el('button', 'btn ghost small', ico('close'));
  close.addEventListener('click', sheetDismiss);
  head.appendChild(close);
  const body = el('div', 'm-sheet-body');
  if (bodyEl) body.appendChild(bodyEl);
  sheet.append(head, body);
  if (footEl) { const foot = el('div', 'm-sheet-foot'); foot.appendChild(footEl); sheet.appendChild(foot); }
  mask.appendChild(sheet);
  mask.addEventListener('click', (e) => { if (e.target === mask) sheetDismiss(); });
  root.appendChild(mask);
  // 返回栈：底部弹层也占一层；vetoClose（有未保存修改）时返回键先确认，不静默丢草稿
  trackOverlay('sheet', closeSheetDom, { swapIfOpen: wasOpen, veto: o.vetoClose || null });
  // 软键盘遮挡补偿（简单实现）：输入框聚焦或视口被键盘压矮时，把焦点元素滚进可视区
  const revealFocused = () => {
    const ae = document.activeElement;
    if (ae && sheet.contains(ae) && ae.scrollIntoView) setTimeout(() => ae.scrollIntoView({ block: 'nearest' }), 220);
  };
  sheet.addEventListener('focusin', revealFocused);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', revealFocused);
  sheetViewportCleanup = () => {
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', revealFocused);
    sheetViewportCleanup = null;
  };
  sheetTeardown = o.onTeardown || null; // 本页的清理钩子（换页与关层都会跑到）
  return sheet;
}

// ---------------- 玩家档案（PROF-01，与桌面端同一套 API） ----------------
// 本机多档案：战绩/笔记/经验池按档案隔离；API 配置是安装级的，切换档案不动它。
// 唯一身份是 UUID，昵称允许重名；归档替代删除，删除只对已归档档案开放（服务端二次校验）。
//
// M1 §4.1 头像的唯一真值在 web/shared/ 的两个共享模块（桌面端 app.js 引用同一份，所以"两端一致"
// 是结构事实而不是"两处碰巧写得一样"——改造前那份九宫格 emoji 表就是这样长成两份的）：
//   · avatar-badge.js —— 八个内置头像的统一线稿徽记（一份 <symbol> 定义 + <use> 引用）与显示回落；
//   · avatar-image.js —— 选图预检 / 居中覆盖裁切 / 只编码一次 / 2MiB 守卫 / §4.3 三接口的请求形状。
// 这里只保留"画在哪块 DOM、由谁触发"。
// ⚠ 纪律：只改**头像**那一行。聊天内容、玩家昵称、战绩/日志文案里的正常 emoji 一个都不动
//    （头像之外没有第二条 emoji 清理路径，也不加任何全局 emoji 正则）。

/** 表单内联错误行（沿用档案表单原有配色，不再多写一处色值） */
function formErrorLine() {
  const p = el('p', 'hint');
  p.style.color = '#ff8080';
  return p;
}

/** 头像三接口（§4.3）发的是**原始 PNG 字节**：api() 只发 JSON，所以另走一次 fetch。
 *  错误口径与 api() 对齐：401 弹局域网配对门。 */
const rawFetch = (url, init) => fetch(url, init);
async function avatarRequest(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.status === 401) showPairingGate();
    throw e;
  }
}

/** 头像显示位的唯一入口：内置徽记 / 自定义图 / 加载失败回落，全部由共享模块决定 */
function renderAvatarInto(node, profile) {
  if (!node) return;
  window.WWAvatarBadge.renderInto(node, profile || null);
}

async function loadProfiles() {
  // M1：拉列表 + 选中 id 落地收在共享模块（两端原本逐字相同），这里只接上本端的界面刷新
  await window.WWProfileState.loadProfiles({
    api, state, storage: localStorage,
    onLoaded: () => {
      renderProfileStrip();
      applyProfilePrefs(currentProfilePrefs()); // 档案级偏好跟随当前档案（FIN-07 行4）
      // M2-d §5.2：档案落地后推进请求代次（档案真的变了才换，同档案的并发请求不受影响）
      getRequestGuard().setCurrent(state.profileId);
    },
    onFailed: (msg) => renderProfileStrip(`档案加载失败：${msg}`),
  });
}

/** 当前档案的偏好（无档案时回落默认值） */
function currentProfilePrefs() {
  return window.WWProfileState.prefsOf(state.profiles, state.profileId);
}

/**
 * 偏好控件（同一套语义在手机端有**两组**控件：设置弹窗 #m-pref-*、玩家中心 #m-pc-pref-*）。
 * 回显必须两组都写 —— 只写一组就会出现"两个开关各说各话"（玩家中心显示旧值）。
 * 为什么不共用同一组 id：同一文档里 id 必须唯一，第二处只能另起前缀。
 */
const PREF_CONTROL_PAIRS = [['#m-pref-font', '#m-pc-pref-font'], ['#m-pref-layout', '#m-pc-pref-layout'], ['#m-pref-motion', '#m-pc-pref-motion']];

/** 偏好应用：html[data-pref-*] → style.css 共享变量（与桌面端同一套语义/CSS） */
function applyProfilePrefs(prefs) {
  const p = prefs || {};
  const root = document.documentElement;
  root.dataset.prefFont = Number(p.fontScale) > 1 ? 'lg' : (Number(p.fontScale) > 0 && Number(p.fontScale) < 1 ? 'sm' : 'std');
  root.dataset.prefLayout = p.layout === 'compact' ? 'compact' : 'reading';
  root.dataset.prefMotion = p.reducedMotion ? '0' : '1';
  const [fontIds, layoutIds, motionIds] = PREF_CONTROL_PAIRS;
  for (const id of fontIds) { const n = document.querySelector(id); if (n) n.value = root.dataset.prefFont; }
  for (const id of layoutIds) { const n = document.querySelector(id); if (n) n.value = root.dataset.prefLayout; }
  for (const id of motionIds) { const n = document.querySelector(id); if (n) n.checked = !!p.reducedMotion; }
}

/**
 * 偏好保存：PATCH 当前档案；失败回滚应用（计划 §11 行4）。
 * FIX-10：与桌面端同一套逻辑 —— 409（revision 过期）时重新拉取最新 revision 并重试**一次**，
 * 而不是直接放弃（原实现会让内存 revision 永久过期 → 之后每次保存都 409，自锁到刷新页面为止）；
 * 重试仍失败则给出可读的冲突说明，不静默吞掉、也不无限重试。
 */
async function saveProfilePrefs(prefs) {
  const payload = {
    fontScale: Number(prefs.fontScale) || 1,
    layout: prefs.layout || 'reading',
    reducedMotion: !!prefs.reducedMotion,
  };
  const pid = state.profileId;
  const prof = state.profiles.find((x) => x.id === pid);
  if (!prof) { applyProfilePrefs(currentProfilePrefs()); return; }
  // M2-d §5.3：写入收进**串行队列**（合并尚未发送的连续修改；409 时重读版本、
  // 无冲突字段合并后重试一次，同字段冲突保留草稿）。判断全在 web/shared/prefs-queue.js，
  // 与桌面端同一份 —— 两端不会各自演化出不同的冲突处理。
  const ticket = getRequestGuard().begin(pid);
  const out = await getPrefsQueue().submit(pid, payload);
  if (out.profile) { prof.preferences = out.profile.preferences; prof.revision = out.profile.revision; }
  // §5.3：完成时若已切档 ⇒ **只更新原档案缓存**（上面一行），当前页面一个像素都不动
  if (!getRequestGuard().isCurrent(ticket)) return;
  applyProfilePrefs(prof.preferences); // 成功回显服务端值；失败/冲突回滚到档案既有值
  // 成功也要有反馈（与桌面端同款文案）：手机端原来保存成功是**完全静默**的，
  // 改了字号/布局后没有任何确认，用户不知道到底存没存进档案。
  if (out.status === 'saved') flash('已保存到当前档案 ✓');
  else if (out.status === 'conflict') {
    flash(`偏好保存冲突：另一窗口改了同一字段（${Object.keys(out.conflict).join('、')}），`
      + '无冲突的字段已保存；你改的内容仍留在控件上（草稿未丢），请重新选择后再保存。');
  } else flash(`偏好保存失败已回退：${(out.error && out.error.message) || '未知错误'}`);
}

/**
 * 偏好控件 → 应用 + 落档案（设置弹窗与玩家中心**共用这一份**；谁触发的谁把三个控件传进来）。
 * ⚠ 不要把本函数直接当 change 监听器：它形参就是"三个控件"，事件对象会被当成 f（踩过这类坑）。
 */
function commitPrefsFromControls(f, l, m) {
  const prefs = {
    fontScale: f && f.value === 'lg' ? 1.2 : (f && f.value === 'sm' ? 0.9 : 1),
    layout: l && l.value === 'compact' ? 'compact' : 'reading',
    reducedMotion: !!(m && m.checked),
  };
  applyProfilePrefs(prefs);
  saveProfilePrefs(prefs);
}

/** 设置弹窗那组控件（#m-pref-*）的监听器：无参，读数走 id 查询 */
function onPrefControlChangeM() {
  const f = document.querySelector('#m-pref-font'), l = document.querySelector('#m-pref-layout'), m = document.querySelector('#m-pref-motion');
  commitPrefsFromControls(f, l, m);
}

/** 玩家中心那组控件（#m-pc-pref-*）的监听器 */
function onPcPrefControlChange() {
  const f = document.querySelector('#m-pc-pref-font'), l = document.querySelector('#m-pc-pref-layout'), m = document.querySelector('#m-pc-pref-motion');
  commitPrefsFromControls(f, l, m);
}

function profileLabel(p) {
  // <option> 只能承载纯文本，装不下 SVG 徽记 —— 这里用徽记的**可读名**保住"是哪个内置头像"
  // 这条信息（不再需要第二张 emoji 对照表），聊天/昵称里的 emoji 与此无关、照旧。
  return `${window.WWAvatarBadge.textLabel(p.avatarId)} ${p.nickname}${p.archivedAt ? '（已归档）' : ''}`;
}

function renderProfileStrip(err) {
  const sel = $('#m-profile-select');
  if (sel) {
    sel.innerHTML = '';
    for (const p of state.profiles.filter((x) => !x.archivedAt)) {
      const o = el('option'); o.value = p.id; o.textContent = profileLabel(p); // 昵称不可信：textContent
      sel.appendChild(o);
    }
    if (state.profileId) sel.value = state.profileId;
    sel.disabled = !state.profiles.length;
    if (err) sel.title = err; else sel.removeAttribute('title');
  }
  renderHomeProfile(err); // FIN-04：首页「当前档案」行与规则页选择器同一份数据
}

/** 首页档案行：头像 + 昵称 + 管理入口（点整行进档案管理弹层） */
function renderHomeProfile(err) {
  const av = $('#m-profile-avatar'), nick = $('#m-profile-nick');
  if (!av || !nick) return;
  const p = state.profiles.find((x) => x.id === state.profileId && !x.archivedAt);
  // 共享模块保证只有两种结果：自定义图（服务端给的 avatarUrl）或该档案 avatarId 的内置徽记；
  // 缺失/脏数据也回落到默认徽记 —— 不存在"什么都不画"的第三种情况（也就不会有破图）。
  renderAvatarInto(av, p);
  nick.textContent = p ? p.nickname : (err ? '档案加载失败' : '默认档案');
  if (err) nick.title = err; else nick.removeAttribute('title');
}

function onSelectProfile(pid) {
  // §5.2：本窗口有未保存的资料或笔记 ⇒ 切档先确认（用户取消就停在这里，草稿一个字都不动）
  const decision = window.WWSwitchGuard.decideSwitch({ dirty: hasUnsavedDraft(), source: window.WWSwitchGuard.SELF });
  if (decision.action === 'confirm' && !confirm(`${decision.reason}\n\n仍要切换档案吗？（未保存的内容会留在原档案的草稿里）`)) return;
  // §5.2 先换代再写存储：切档之前发出的请求回来时一律作废（迟到响应不得覆盖新档案页面）
  getRequestGuard().setCurrent(pid);
  // M1：写选中键 + 昵称预填收在共享模块（两端原本逐字相同），这里只接本端的界面刷新
  window.WWProfileState.selectProfile({ state, storage: localStorage, profileId: pid, nameInput: $('#m-my-name') });
  applyProfilePrefs(currentProfilePrefs()); // 切档 → 外观偏好跟着档案走
  renderProfileStrip();
  if (!state.game) loadResumeCard();
}

/** 档案管理弹层（底部）：新建/编辑/选用/归档/恢复/删除/导出/导入。每次操作后重开本层刷新列表。 */
function openProfileManager() {
  const body = el('div');
  body.appendChild(el('p', 'hint', '同一台设备可以建多个玩家档案：战绩、笔记、AI 经验池互相隔离。API 配置是整台设备共享的，切换档案不会改动它。档案的唯一身份是 UUID，昵称允许重名。'));
  const list = el('div', 'pm-list');
  const rows = [...state.profiles].sort((a, b) => (a.archivedAt ? 1 : 0) - (b.archivedAt ? 1 : 0) || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  const usableCount = state.profiles.filter((p) => !p.archivedAt).length;
  for (const p of rows) {
    const row = el('div', 'pm-row' + (p.archivedAt ? ' archived' : '') + (p.id === state.profileId ? ' current' : ''));
    row.dataset.profileId = p.id; // 供脚本/验收精确定位某一行（昵称允许重名，不能按昵称找）
    const main = el('div', 'pm-main');
    // 名前行：真实头像（自定义图或内置徽记）+ 昵称/归档/当前"三态文案"。
    // 与首页档案行是同一条渲染路径，玩家中心一眼能看出改没改成功。
    const name = el('div', 'pm-name');
    const avBox = el('span', 'pm-name-av');
    name.appendChild(avBox);
    name.appendChild(document.createTextNode(`${p.nickname}${p.archivedAt ? '（已归档）' : ''}${p.id === state.profileId ? '（当前）' : ''}`));
    renderAvatarInto(avBox, p);
    main.appendChild(name);
    main.appendChild(elText('div', 'hint', `创建于 ${(p.createdAt || '').slice(0, 10)}${p.archivedAt ? ` · 归档于 ${(p.archivedAt || '').slice(0, 10)}` : ''}`));
    row.appendChild(main);
    const ops = el('div', 'pm-ops');
    const op = (label, fn, cls = 'btn ghost small') => {
      const b = el('button', cls, label);
      b.addEventListener('click', () => fn(p));
      ops.appendChild(b);
    };
    if (!p.archivedAt) {
      op('选用', (pp) => { onSelectProfile(pp.id); renderProfileStrip(); openProfileManager(); }, 'btn small');
    }
    op('编辑', (pp) => openProfileEdit(pp));
    if (!p.archivedAt) {
      op('归档', async (pp) => {
        // M2-d §5.2：与「归档当前档案」同一套阻止（未结束对局优先，其次最后一个可用档案）
        let unfinished = 0;
        try {
          const r = await api('GET', `/api/profiles/${pp.id}/games?status=unfinished&limit=100`);
          unfinished = (r && Number(r.total)) || ((r && r.rows) || []).length;
        } catch (e) {
          alert(`读取「${pp.nickname}」的进行中对局失败：${e.message}\n为避免归档时丢掉进行中的对局，本次操作已取消。`);
          return;
        }
        const blocked = window.WWSwitchGuard.archiveBlockReason({ unfinished, usableCount });
        if (blocked) { alert(blocked); return; }
        if (!confirm(`归档「${pp.nickname}」？归档后从选择器隐藏，战绩与笔记保留，可随时恢复。`)) return;
        try {
          await api('PATCH', `/api/profiles/${pp.id}`, { expectedRevision: pp.revision, archive: true });
          await loadProfiles(); openProfileManager();
        } catch (e) { alert(`归档失败：${e.message}`); }
      });
    } else {
      op('恢复', async (pp) => {
        try {
          await api('PATCH', `/api/profiles/${pp.id}`, { expectedRevision: pp.revision, restore: true });
          await loadProfiles(); openProfileManager();
        } catch (e) { alert(`恢复失败：${e.message}`); }
      });
      op('删除…', async (pp) => {
        if (!confirm(`彻底删除「${pp.nickname}」？\n\n其战绩与笔记将进入回收区（本期不自动清空）。\n建议先点「导出」留一份备份。`)) return;
        try {
          await api('DELETE', `/api/profiles/${pp.id}`);
          window.WWProfileState.deselectIfCurrent({ state, storage: localStorage, profileId: pp.id });
          await loadProfiles(); openProfileManager();
        } catch (e) { alert(`删除失败：${e.message}`); }
      }, 'btn small danger');
    }
    op('导出', (pp) => browserExportProfile(`/api/profiles/${pp.id}/export`));
    row.appendChild(ops);
    list.appendChild(row);
  }
  body.appendChild(list);
  // 回收区入口（FIX-04）：「删除＝归档代替删除」以前删掉就找不回来，这里是唯一的恢复入口。
  const trashRow = el('div', 'btnrow');
  const trashBtn = el('button', 'btn ghost pm-trash-entry', icoLabel('trash', '回收站'));
  trashBtn.id = 'm-pm-trash-entry';
  trashBtn.addEventListener('click', openProfileTrash);
  trashRow.appendChild(trashBtn);
  body.appendChild(trashRow);
  // 计数异步补：失败不静默（标签直接写"读取失败"、title 给出原因），也不影响档案管理本身可用。
  api('GET', '/api/profiles/trash').then((r) => {
    trashBtn.innerHTML = icoLabel('trash', `回收站（${((r && r.items) || []).length}）`);
  }).catch((e) => {
    trashBtn.innerHTML = icoLabel('trash', '回收站（读取失败）');
    trashBtn.title = (e && e.message) || '回收区不可用';
  });
  body.appendChild(el('p', 'hint', '说明：这些档案是同一设备上的数据分类，不是密码保护。手机浏览器连的是电脑服务时，读写的也是电脑那一份。'));
  const foot = el('div', 'btnrow');
  const mk = el('button', 'btn', '＋ 新建档案');
  mk.addEventListener('click', () => openProfileEdit(null));
  foot.appendChild(mk);
  const imp = el('button', 'btn ghost', icoLabel('import', '导入'));
  imp.addEventListener('click', openProfileImport);
  foot.appendChild(imp);
  openSheet('👤 我的档案', body, foot);
}

/**
 * 新建/编辑档案：在同一底部弹层里换页，保存后回列表（与桌面端同一套字段、同一套共享模块）。
 *
 * 头像的两条状态轴分开管，互不覆盖：
 *   · `avatarId` —— 内置徽记，同时也是**删掉自定义图之后的回退**（服务端从不动它）；
 *   · `customUrl` / `pendingBlob` —— 自定义图：已保存的用服务端给的 `avatarUrl`，
 *     刚裁好还没保存的用 `pendingBlob`（内存里的 PNG Blob）。
 * 「改成什么样」全部攒到「保存」才落盘；只有「删除自定义头像」是立即生效的显式动作
 * （§4.1 第 6 条要求的两个明确动作语义不同，所以是两个按钮）。
 * `draft` 用于"选图 → 裁切页 → 返回"时把昵称/简介/已选内置头像原样带回，玩家不会白填一遍。
 */
function openProfileEdit(existing, draft) {
  const Badge = window.WWAvatarBadge;
  const Img = window.WWAvatarImage;
  const d = draft || {};
  const body = el('div');
  const err = formErrorLine();

  // revision 自己拿在手上：删除自定义头像会立即推进它，若继续用外面临时快照里的旧值，
  // 接着点「保存」必然 409（一次"刚被别处修改过"的假警报）。
  let rev = existing ? existing.revision : null;
  let avatarId = d.avatarId !== undefined ? d.avatarId : (existing ? existing.avatarId : Badge.DEFAULT_AVATAR_ID);
  let customUrl = d.customUrl !== undefined ? d.customUrl : (existing ? (existing.avatarUrl || null) : null);
  let pendingBlob = d.pendingBlob || null;
  let removeCustom = !!d.removeCustom;

  const nameL = el('label');
  nameL.appendChild(el('span', null, '昵称（1–20 字）'));
  const nameI = el('input');
    // R06：同桌面端 —— 原生 maxlength 按码元，放到 2×，真正的 20 码点由共享模型钳制
    const nameMax = window.WWProfileState.NICKNAME_MAX;
    nameI.maxLength = nameMax * 2;
    nameI.addEventListener('input', () => { const c = window.WWProfileState.clampProfileText(nameI.value, nameMax); if (c !== nameI.value) nameI.value = c; });
    nameI.id = 'profile-form-nick';
  nameI.value = d.nickname !== undefined ? d.nickname : (existing ? existing.nickname : '');
  nameL.appendChild(nameI);
  body.appendChild(nameL);

  const bioL = el('label');
  bioL.appendChild(el('span', null, '简介（选填，最多 100 字）'));
  const bioI = el('textarea');
    // R06：简介同理
    const bioMax = window.WWProfileState.BIO_MAX;
    bioI.maxLength = bioMax * 2;
    bioI.addEventListener('input', () => { const c = window.WWProfileState.clampProfileText(bioI.value, bioMax); if (c !== bioI.value) bioI.value = c; });
    bioI.rows = 2; bioI.id = 'profile-form-bio';
  bioI.value = d.bio !== undefined ? d.bio : (existing ? (existing.bio || '') : '');
  bioL.appendChild(bioI);
  body.appendChild(bioL);

  // ---------------- 头像（§4.1 第 1/5/6 条）----------------
  body.appendChild(el('div', 'hint', '头像：用下面的内置徽记，或从设备选一张图片裁成正方形。图片只保存在这台设备上。'));

  const curBox = el('div', 'av-current');
  const curAv = el('span', 'av-current-av');
  curAv.id = 'av-current-preview';
  const curTxt = elText('span', 'hint', '');
  curTxt.id = 'av-current-note';
  curBox.append(curAv, curTxt);
  body.appendChild(curBox);

  const avRow = el('div', 'chip-row av-row');
  avRow.id = 'av-builtin-row';
  const chips = new Map();
  for (const aid of Badge.AVATAR_IDS) {
    const c = el('button', 'chip av-chip', Badge.badgeMarkup(aid));
    c.type = 'button';
    c.id = `av-chip-${aid}`;
    c.title = `内置头像：${Badge.nameOf(aid)}`;
    c.setAttribute('aria-label', `内置头像 ${Badge.nameOf(aid)}`);
    c.addEventListener('click', () => { avatarId = aid; syncAvatarUi(); });
    chips.set(aid, c);
    avRow.appendChild(c);
  }
  body.appendChild(avRow);

  const avHint = el('div', 'hint');
  avHint.id = 'av-custom-note';
  const customRow = el('div', 'btnrow');
  const pick = el('button', 'btn', '选择图片…');
  pick.id = 'av-pick'; pick.type = 'button';
  const useBuiltin = el('button', 'btn ghost', '改用内置头像');
  useBuiltin.id = 'av-use-builtin'; useBuiltin.type = 'button';
  const delCustom = el('button', 'btn ghost small danger', '删除自定义头像');
  delCustom.id = 'av-delete-custom'; delCustom.type = 'button';
  const fileI = document.createElement('input');
  fileI.type = 'file';
  fileI.id = 'av-file';
  fileI.hidden = true;
  fileI.accept = Img.ACCEPT_ATTR;
  customRow.append(pick, useBuiltin, delCustom);
  body.append(avHint, customRow, fileI);
  body.appendChild(err);

  // 预览的异步竞态守卫：连点会先后触发两次绘制，旧的那次不许覆盖新的
  let paintSeq = 0;
  async function paintCurrent() {
    const seq = ++paintSeq;
    curAv.innerHTML = '';
    if (pendingBlob) {
      // 已裁好但还没上传：用画布把它画出来（CSP img-src 'self' 不允许 data:/blob: 图片 URL）
      const c = el('canvas', 'av-current-canvas');
      c.id = 'av-pending-preview';
      c.width = 64; c.height = 64;
      curAv.appendChild(c);
      curTxt.textContent = '已裁好新图片 · 点「保存」后生效';
      try {
        const bmp = await window.createImageBitmap(pendingBlob);
        if (seq === paintSeq) c.getContext('2d').drawImage(bmp, 0, 0, 64, 64);
        Img.releaseBitmap(bmp);
      } catch (_) { /* 预览画不出来不影响保存：真正的图源是 pendingBlob 本身 */ }
      return;
    }
    curTxt.textContent = removeCustom
      ? `保存后改用内置徽记「${Badge.nameOf(avatarId)}」`
      : (customUrl ? '当前使用自定义头像' : `当前使用内置徽记「${Badge.nameOf(avatarId)}」`);
    // 与首页档案行同一条渲染路径：这里看到的就是保存后看到的
    renderAvatarInto(curAv, { avatarId, avatarUrl: removeCustom ? null : customUrl });
  }

  function syncAvatarUi() {
    for (const [aid, c] of chips) c.classList.toggle('sel', aid === avatarId);
    const hasCustom = !!pendingBlob || (!!customUrl && !removeCustom);
    pick.textContent = hasCustom ? '重新选择图片…' : '选择图片…';
    useBuiltin.disabled = !hasCustom;
    delCustom.hidden = !customUrl;
    delCustom.disabled = !existing || !customUrl;
    // 自定义图会盖过内置徽记：不说清"上面选的是删除后的回退"，玩家点了会以为没反应
    avHint.textContent = hasCustom
      ? `当前显示自定义头像；上面的内置徽记「${Badge.nameOf(avatarId)}」是删除自定义头像后的回退`
      : '内置头像只作区分：不上传图片，也不影响战绩与笔记';
    paintCurrent();
  }

  useBuiltin.addEventListener('click', () => { pendingBlob = null; removeCustom = true; syncAvatarUi(); });

  pick.addEventListener('click', () => { fileI.click(); });
  fileI.addEventListener('change', async () => {
    const f = fileI.files && fileI.files[0];
    fileI.value = ''; // 清空：同一个文件再选一次也要能触发 change
    if (!f) return;
    err.textContent = '';
    // §4.1 第 2 条：类型/体积/可解码/宽高三层预检都在共享模块里，失败必有明确原因
    const prep = await Img.prepareSource(f);
    if (!prep.ok) { err.textContent = prep.message; return; }
    const snap = () => ({ nickname: nameI.value, bio: bioI.value, avatarId, customUrl, pendingBlob, removeCustom });
    openAvatarCrop({
      source: prep,
      onConfirm: (blob) => openProfileEdit(existing, { ...snap(), pendingBlob: blob, removeCustom: false }),
      onUseBuiltin: () => openProfileEdit(existing, { ...snap(), pendingBlob: null, removeCustom: true }),
      onCancel: () => openProfileEdit(existing, snap()),
    });
  });

  delCustom.addEventListener('click', async () => {
    if (!customUrl || !existing) return;
    if (!confirm(`删除自定义头像？\n\n删除后该档案改用内置徽记「${Badge.nameOf(avatarId)}」，已上传的图片文件会从本机移除。聊天记录与战绩不受影响。`)) return;
    delCustom.disabled = true;
    err.textContent = '';
    try {
      const resp = await avatarRequest(() => Img.deleteAvatar(rawFetch, { profileId: existing.id, revision: rev }));
      const merged = Img.mergeAvatarResult(state.profiles, resp);
      if (merged && Number.isInteger(merged.revision)) rev = merged.revision;
      // 服务端只删图片、**不动 avatarId**：回退靠的就是它
      customUrl = null; pendingBlob = null; removeCustom = false;
      await loadProfiles(); // 首页档案行立即跟上（§4.1 第 5 条）
      syncAvatarUi();
    } catch (e) {
      err.textContent = `删除自定义头像失败：${e.message}（原头像保持不变）`;
    } finally {
      delCustom.disabled = false;
    }
  });

  const foot = el('div', 'btnrow');
  const back = el('button', 'btn ghost', '返回');
  back.addEventListener('click', () => openProfileManager());
  foot.appendChild(back);
  const go = el('button', 'btn primary', existing ? '保存' : '创建');
  go.addEventListener('click', async () => {
    const nick = nameI.value.trim();
    if (!nick) { err.textContent = '昵称不能为空'; return; }
    err.textContent = '';
    go.disabled = true;
    // §5.2：保存/创建**成功之后**，这份表单就不再是"未保存的内容"，必须立刻把 dirty 摘掉 ——
    // 新建档案紧接着会 `onSelectProfile(新档案)`"新建即选用"，此刻表单还开着且昵称已填，
    // dirty 仍为 true 就会弹原生 confirm 把整页挡住（桌面端已被 ui:check 实测抓到同类缺陷）。
    const markSaved = () => { state.profileFormDirty = null; };
    try {
      let prof = existing;
      if (existing) {
        const r = await api('PATCH', `/api/profiles/${existing.id}`, { expectedRevision: rev, nickname: nick, avatarId, bio: bioI.value.trim() });
        prof = (r && r.profile) || existing;
      } else {
        const r = await api('POST', '/api/profiles', { nickname: nick, avatarId, bio: bioI.value.trim() });
        prof = r.profile;
        markSaved(); // 新建成功：紧接着的"新建即选用"不该再问"要不要丢弃未保存内容"
        onSelectProfile(prof.id); // 新建即选用
      }
      if (prof && Number.isInteger(prof.revision)) rev = prof.revision;
      // §4.1 第 7 条：头像只在玩家真的动了它时才发请求。先保存资料再传图，
      // 任何一步失败都不会留下"图没了"的中间态（原头像保持不变）。
      if (pendingBlob) {
        const resp = await avatarRequest(() => Img.putAvatar(rawFetch, { profileId: prof.id, revision: rev, body: pendingBlob }));
        const merged = Img.mergeAvatarResult(state.profiles, resp);
        if (merged && Number.isInteger(merged.revision)) rev = merged.revision;
      } else if (removeCustom && customUrl) {
        const resp = await avatarRequest(() => Img.deleteAvatar(rawFetch, { profileId: prof.id, revision: rev }));
        const merged = Img.mergeAvatarResult(state.profiles, resp);
        if (merged && Number.isInteger(merged.revision)) rev = merged.revision;
      }
      markSaved(); // 资料与头像都已落库 ⇒ 表单不再是"未保存的内容"
      await loadProfiles();
      openProfileManager();
    } catch (e) {
      go.disabled = false;
      if (e.status === 409 || /已被其他窗口|revision/i.test(e.message || '')) err.textContent = '档案刚被别处修改过（另一窗口？），请返回后重新进入再试';
      else err.textContent = e.message;
    }
  });
  foot.appendChild(go);
  openSheet(existing ? '编辑档案' : '新建档案', body, foot, { icon: existing ? 'edit' : 'create' });
  syncAvatarUi();
  // M2-d §5.2 登记给切档守卫：资料表单被改过（昵称/简介/选了新头像/改用内置图）⇒ 切档先确认。
  // 必须在 openSheet **之后**登记 —— 打开任何弹层都会清掉上一层的 dirty 引用（见 closeSheet/openSheet）。
  state.profileFormOpen = true;
  state.profileFormDirty = () => (
    nameI.value !== (existing ? existing.nickname : '')
    || bioI.value !== (existing ? (existing.bio || '') : '')
    || !!pendingBlob
    || removeCustom
  );
}

/**
 * 方形裁切页（§4.1 第 3 条）：拖动 + 缩放 + 方形/圆形实时预览；确认时按「居中覆盖」裁成
 * 512×512 并**重新编码一次** PNG（重编码本身就会丢掉 EXIF/GPS 等元数据）。
 *
 * 它是在同一个底部弹层里换页（openSheet 的 swapIfOpen），返回深度不加深。
 * 位图不进 DOM，`innerHTML = ''` 收不走它 —— 所以所有出口（确认/改用内置/返回/✕/遮罩/系统返回）
 * 都汇到 `release()`，关层那一路由 openSheet 的 onTeardown 钩子兜住。
 * 预览全是 <canvas>：CSP 是 `img-src 'self'`（src/static.js），`data:`/`blob:` 图片 URL 会被拦掉；
 * 解码走 createImageBitmap（不经过 URL）。编码复用这张 512×512 展示画布。
 */
function openAvatarCrop(cfg) {
  const Img = window.WWAvatarImage;
  const S = Img.OUTPUT_SIZE;
  const P = 96; // 预览画布内部分辨率（CSS 展示 64px）
  const source = cfg.source;
  let view = Img.initialView(source.width, source.height, S);
  let released = false;
  let drag = null;

  const release = () => {
    if (released) return;
    released = true;
    Img.releaseBitmap(source.bitmap);
  };
  const leave = (fn) => { if (released) return; release(); fn(); };

  const body = el('div');
  body.appendChild(el('p', 'hint', `拖动调整位置，用 ＋ / － 缩放。头像按「居中覆盖」裁成 ${S}×${S} 正方形，不会拉伸变形。`));

  const stage = el('canvas', 'av-crop-stage');
  stage.id = 'av-crop-stage';
  stage.width = S; stage.height = S;
  stage.setAttribute('aria-label', '裁切区域：拖动可调整位置');
  body.appendChild(stage);

  const mkPreview = (id, label, round) => {
    const box = el('div', 'av-crop-preview' + (round ? ' round' : ''));
    const c = el('canvas');
    c.id = id; c.width = P; c.height = P;
    box.append(c, elText('span', null, label));
    return { box, ctx: c.getContext('2d') };
  };
  const sq = mkPreview('av-crop-square', '方形', false);
  const rd = mkPreview('av-crop-round', '圆形', true);
  const previews = el('div', 'av-crop-previews');
  previews.append(sq.box, rd.box);
  body.appendChild(previews);

  const zoomRow = el('div', 'av-crop-zoom');
  const zOut = el('button', 'btn small', '－'); zOut.id = 'av-crop-zoom-out'; zOut.type = 'button';
  const zVal = elText('span', 'hint', ''); zVal.id = 'av-crop-zoom';
  const zIn = el('button', 'btn small', '＋'); zIn.id = 'av-crop-zoom-in'; zIn.type = 'button';
  zoomRow.append(zOut, zVal, zIn);
  body.appendChild(zoomRow);

  const err = formErrorLine();
  body.appendChild(err);

  function paint() {
    Img.drawCrop(stage.getContext('2d'), source.bitmap, S, view);
    for (const p of [{ ctx: sq.ctx, round: false }, { ctx: rd.ctx, round: true }]) {
      p.ctx.clearRect(0, 0, P, P);
      p.ctx.save();
      if (p.round) { p.ctx.beginPath(); p.ctx.arc(P / 2, P / 2, P / 2, 0, Math.PI * 2); p.ctx.clip(); }
      p.ctx.drawImage(stage, 0, 0, P, P);
      p.ctx.restore();
    }
    zVal.textContent = `${view.zoom.toFixed(2)}×`;
    zOut.disabled = view.zoom <= Img.MIN_ZOOM;
    zIn.disabled = view.zoom >= Img.MAX_ZOOM;
  }

  // 指针位移是 CSS 像素，而裁切几何按"画布内部像素"算：展示尺寸通常小于 512，必须换算
  stage.addEventListener('pointerdown', (e) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 不支持捕获时退化为"指针在区域内才能拖" */ }
    if (typeof e.preventDefault === 'function') e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    const k = r.width > 0 ? S / r.width : 1;
    view = Img.dragView(source.width, source.height, S, view, (e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
    drag = { x: e.clientX, y: e.clientY };
    paint();
  });
  const endDrag = () => { drag = null; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('lostpointercapture', endDrag);
  zOut.addEventListener('click', () => { view = Img.zoomView(source.width, source.height, S, view, view.zoom - Img.ZOOM_STEP); paint(); });
  zIn.addEventListener('click', () => { view = Img.zoomView(source.width, source.height, S, view, view.zoom + Img.ZOOM_STEP); paint(); });

  const foot = el('div', 'btnrow');
  const back = el('button', 'btn ghost', '返回');
  back.id = 'av-crop-cancel';
  back.addEventListener('click', () => leave(cfg.onCancel));
  const useBuiltin = el('button', 'btn ghost', '改用内置头像');
  useBuiltin.id = 'av-crop-builtin';
  useBuiltin.addEventListener('click', () => leave(cfg.onUseBuiltin));
  const ok = el('button', 'btn primary', '确认裁切');
  ok.id = 'av-crop-confirm';
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    err.textContent = '';
    const r = await Img.produceAvatar({ image: source.bitmap, view, outSize: S, canvas: stage });
    // 超 2MiB 时只有这一句原文文案，且**绝不**降采样/降色深重编一次
    if (!r.ok) { err.textContent = r.message; ok.disabled = false; return; }
    leave(() => cfg.onConfirm(r.blob));
  });
  foot.append(back, useBuiltin, ok);

  paint();
  // onTeardown 兜住 ✕ / 遮罩 / 系统返回这三条不经过上面按钮的关层路径
  openSheet('裁切头像', body, foot, { onTeardown: release });
}

/** 导入档案包（PROF-04）：文件 → 预览（不写盘）→ 确认 → 落地为新档案（ID 重映射，绝不覆盖现有局） */
/**
 * 浏览器导出臂（M2-e）：同源下载 + 三态归一化，行为与桌面端 web/app.js 的同名函数一致。
 * 文案只到「已发起下载」—— 浏览器无法确认用户是否保存（计划书 :237）。
 */
function browserExportProfile(url) {
  const S = window.WWTransferStatus;
  let outcome;
  try {
    const a = document.createElement('a');
    const u = String(url || '');
    // 只放行本站的档案导出端点（前缀白名单）
    if (!/^\/api\/profiles\/[^/]+\/export$/.test(u)) {
      throw new Error('导出地址不合法（只允许 /api/profiles/<id>/export）');
    }
    a.href = u;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    outcome = S.browserExportOutcome({ downloadStarted: true });
  } catch (e) {
    outcome = S.browserExportOutcome({ error: e });
  }
  const msg = S.formatOutcome(outcome);
  if (typeof flash === 'function') flash(msg, outcome.status === 'failed' ? 'warn' : '');
  else if (outcome.status === 'failed') alert(msg);
  return outcome;
}

function openProfileImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    let pkg = null;
    try { pkg = JSON.parse(await f.text()); } catch (_) { alert('文件不是合法 JSON'); return; }
    let pv;
    try { pv = await api('POST', '/api/profiles/import/preview', { package: pkg }); } catch (e) { alert(`包校验失败：${e.message}`); return; }
  const ok = confirm(window.WWTransferStatus.describePreview(pv.preview, f.size));
    if (!ok) return;
    try {
      const r = await api('POST', '/api/profiles/import', { package: pkg });
      await loadProfiles();
      onSelectProfile(r.profileId);
      renderProfileStrip();
      openProfileManager();
      // R02：同桌面端 —— 昵称原样，副本说明只出现在界面文案里
      const np = (state.profiles || []).find((x) => x.id === r.profileId);
      alert(`导入完成：${r.imported} 局已归入新档案${np ? `「${np.nickname}」` : ''}（副本，原档案未改动）${r.pendingRecoveries && r.pendingRecoveries.length ? '\n另有历史导入残留未清理，请在设置中检查恢复记录。' : ''}`);
    } catch (e) { alert(`导入失败：${e.message}`); }
  });
  inp.click();
}

// ---------------- 回收区（FIX-04）：删除后的恢复入口 ----------------
// 背景：删除是「归档代替删除」——目录搬进回收区、数据不丢，但此前**没有任何恢复入口**，
// 删掉就找不回来。服务端补齐了 GET /api/profiles/trash 与 POST /api/profiles/trash/<id>/restore，
// 这里是最小可用入口（与桌面端 web/app.js 同源实现，字段与文案保持一致）。
// 布局：走既有的底部弹层 openSheet（.m-sheet + .m-sheet-body 内部滚动），
// 不复用 .modal —— 手机端档案管理本来就是这张底部弹层，换页而不是叠层。
const TRASH_STATE_LABEL = { trashed: '已删除', failed: '删除未完成（数据仍在回收区）' };

/** 回收区条目状态文案：未知状态如实回显，不假装正常 */
const trashStateLabel = (s) => TRASH_STATE_LABEL[s] || `状态未知（${s || '?'}）`;

/** 删除时间：只取到分钟；解析不了就说"未知"，不渲染 Invalid Date */
function formatTrashTime(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `删除于 ${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '删除时间未知';
}

/**
 * 回收区条目的一行说明：状态 + 删除时间 +（目录已不在时）为什么点不了。
 * `restorable=false` 是**兜底**：服务端的 listTrash() 只返回目录还在的条目（恢复成功的墓碑不再返回），
 * 所以正常路径不会走到这里；万一收到，如实标注原因 —— 既不假装它还能恢复，也不偷偷藏起来。
 */
function trashMetaText(it) {
  const base = `${trashStateLabel(it.state)} · ${formatTrashTime(it.trashedAt)}`;
  return it.restorable ? base : `${base} · 数据目录已不在回收区，无法恢复`;
}

/**
 * 恢复失败的可读原因（400 非法 archiveId / 404 回收区没有该档案 / 409 目标位置被占用）。
 * 这个项目刚因为"空刀被拒没有可读提示"被记为已知缺口 F5 —— 这里不允许静默失败：
 * 三种错误码都要翻成"发生了什么"，让用户知道下一步该做什么。
 */
function restoreFailReason(e) {
  const raw = (e && e.message) || '未知错误';
  if (e && e.status === 404) return `回收区里已经找不到这条记录（${raw}）；可能是另一个窗口先恢复了，列表已刷新`;
  if (e && e.status === 409) return `目标档案位置已被占用，恢复已中止以免覆盖数据（${raw}）`;
  if (e && e.status === 400) return `请求被拒绝（${raw}）`;
  return raw;
}

/**
 * 渲染回收区列表。只负责列表容器；msgEl 仅在**读取失败或首次进入**时写入 ——
 * 恢复成功/失败的提示由调用方写，刷新列表时不能被冲掉（否则又是一次"静默"）。
 */
async function renderProfileTrash(listEl, msgEl) {
  const message = (text, color) => { if (msgEl) { msgEl.textContent = text; msgEl.style.color = color || ''; } };
  listEl.textContent = '';
  listEl.dataset.state = 'loading';
  listEl.appendChild(elText('p', 'hint', '正在读取回收区…'));
  message('');
  let items = [];
  try {
    items = ((await api('GET', '/api/profiles/trash')) || {}).items || [];
  } catch (e) {
    listEl.textContent = '';
    listEl.dataset.state = 'error';
    // 读取失败也必须说出来：空面板会被误读成"回收区是空的"（等于骗用户数据没了）
    listEl.appendChild(elText('p', 'hint', `回收区读取失败：${(e && e.message) || '未知错误'}`));
    return;
  }
  listEl.textContent = '';
  listEl.dataset.state = items.length ? 'items' : 'empty';
  if (!items.length) {
    listEl.appendChild(elText('p', 'hint', '回收区是空的。在档案列表里点「删除…」的档案会移到这里，数据不会丢，随时可以搬回来。'));
    return;
  }
  for (const it of items) {
    const row = el('div', 'pm-row' + (it.restorable ? '' : ' archived'));
    row.dataset.archiveId = it.archiveId;
    const main = el('div', 'pm-main');
    main.appendChild(elText('div', 'pm-name', it.nickname || '（昵称已丢失）'));
    main.appendChild(elText('div', 'hint', trashMetaText(it)));
    row.appendChild(main);
    const ops = el('div', 'pm-ops');
    const btn = el('button', 'btn small pm-restore', it.restorable ? '恢复' : '不可恢复');
    btn.dataset.archiveId = it.archiveId;
    if (it.restorable) {
      btn.addEventListener('click', () => doRestoreProfile(it, btn, listEl, msgEl));
    } else {
      // 目录已不在（已恢复过 / 上次删除失败被对账搬回）：如实说明为什么点不了，不给一个点了没反应的按钮
      btn.disabled = true;
      btn.title = '回收区里已经没有该档案目录，无法恢复';
    }
    ops.appendChild(btn);
    row.appendChild(ops);
    listEl.appendChild(row);
  }
}

/**
 * 点「恢复」：调恢复路由 → 成功后刷新档案列表 + 回收区列表并给可读提示；失败给可读原因（绝不静默）。
 * 服务端 FIX-04b：恢复**一步到位** —— 搬回目录的同时取消归档（响应带 unarchived）。
 * 所以这里恢复完即可用，前端不需要、也不应该再补一次 PATCH restore（那是多余的第二次写）。
 */
async function doRestoreProfile(it, btn, listEl, msgEl) {
  const message = (text, color) => { if (msgEl) { msgEl.textContent = text; msgEl.style.color = color || ''; } };
  btn.disabled = true;
  message(`正在恢复「${it.nickname || '档案'}」…`);
  try {
    const r = await api('POST', `/api/profiles/trash/${encodeURIComponent(it.archiveId)}/restore`);
    await loadProfiles(); // 档案列表刷新：恢复后的档案已经是可用态（archivedAt=null，可直接开局）
    await renderProfileTrash(listEl, null); // 只刷列表，保住下面这条成功提示
    const nick = (r && r.profile && r.profile.nickname) || it.nickname || '档案';
    message(`✓ 已恢复「${nick}」：档案已回到列表并可以直接使用（战绩、笔记、经验池都在）。`, '#8ee08e');
  } catch (e) {
    message(`✗ 恢复失败：${restoreFailReason(e)}`, '#ff8080');
    await renderProfileTrash(listEl, null); // 404（别处已恢复）等情形下让列表回到真实状态
  }
}

/** 回收区面板（手机端）：底部弹层换页，列出被删除（进回收区）的档案，每项带「恢复」 */
function openProfileTrash() {
  const body = el('div');
  body.appendChild(el('p', 'hint', '删除档案只是把它移进回收区，战绩、笔记与经验池都还在。点「恢复」即可一步搬回档案列表，恢复后立刻可用。'));
  const msg = el('p', 'hint');
  msg.id = 'm-pm-trash-msg';
  msg.setAttribute('role', 'status');
  body.appendChild(msg);
  const list = el('div', 'pm-list');
  list.id = 'm-pm-trash-list';
  list.dataset.state = 'loading';
  body.appendChild(list);
  const foot = el('div', 'btnrow');
  const back = el('button', 'btn primary', '← 返回档案列表');
  back.addEventListener('click', () => openProfileManager());
  foot.appendChild(back);
  openSheet('回收站', body, foot, { icon: 'trash' });
  renderProfileTrash(list, msg);
}

async function startGame() {
  $('#m-err').textContent = '';
  const startBtn = $('#m-start');
  if (startBtn && startBtn.disabled) return; // FIN-03：双击只产生一次业务提交（处理中保持宽度）
  if (startBtn) { startBtn.disabled = true; startBtn.classList.add('m-busy'); startBtn.textContent = '⏳ 开局中…'; }
  try {
    const counts = state.boardCounts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const wolves = Object.entries(counts).filter(([r]) => state.meta.roles[r].team === 'wolf').reduce((a, [, n]) => a + n, 0);
    if (total < 4 || wolves < 1 || wolves >= total - wolves) { $('#m-err').textContent = '⚠ 板子配置不合法'; return; }
    const useMock = !!state.mock;
    // 开局明确播报本局是否花钱（P2-b）：这句是玩家最后一次确认的机会
    flash(useMock ? '🧪 Mock 试玩：本局不调用 API、不消耗额度' : '💳 真实对局：本局会调用 API 并消耗额度');
    const cfg = await api('GET', '/api/config');    if (!useMock && !cfg.hasKey) { $('#m-err').textContent = '⚠ 请先在「设置」里填写 API Key（或勾选 Mock 试玩）'; return; }
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
    // 对局归属固化（PROF-02）：开局即锁定到所选档案；未加载出档案时不带字段（服务端归默认档案）
    if (state.profileId) body.profileId = state.profileId;
    try { window.WWGameDraft.writeSeat(localStorage, 'ww_seat', seatChoice); } catch (_) { /* 隐私模式忽略 */ }
    const created = await api('POST', '/api/games', body);
    // mock 随句柄保存：首页「继续上局」卡要如实标出试玩/真实（防止恢复时误标花钱）
    const owner = state.profiles.find((x) => x.id === state.profileId);
    state.game = { gameId: created.gameId, playerToken: created.playerToken, godToken: created.godToken, mySeat: created.mySeat, mock: !!created.mock || useMock, savedAt: Date.now(),
      ownerProfileId: state.profileId || null, ownerNickname: owner ? owner.nickname : null };
    await api('POST', `/api/games/${created.gameId}/start`, { token: created.godToken });
    enterGame();
  } catch (e) { $('#m-err').textContent = `✗ ${e.message}`; }
  finally {
    // 还原时不能只写 textContent：i18n 词典里的 `m.start` 是「⚔ 开始游戏」，
    // 直接写会把 data-ww-icon 的徽记抹掉（按钮从此只剩一个 emoji）。
    // 所以写完文案再按标记重画一次 —— 与切语言后重画走的是同一条路。
    if (startBtn) { startBtn.disabled = false; startBtn.classList.remove('m-busy'); startBtn.textContent = I18N.t('m.start'); window.WWIcons.mountNode(startBtn); }
  }
}

/**
 * FIN-04 首页「▶ 继续上局」卡：不再一进页面就跳进对局——首页先给出
 * 模式 / 阶段 / 保存时间，由玩家点「继续」再进（恢复前核对归属与模式）。
 * 句柄仍存在本机 localStorage（mww_current），只恢复本机自己的局。
 */
async function loadResumeCard() {
  const card = $('#m-resume-card');
  if (!card) return;
  state.resume = null;
  card.classList.add('hidden');
  const saved = window.WWGameDraft.readHandleRaw(localStorage, 'mww_current');
  if (!saved) { await adoptResumableForHandleless(); return; }
  let g = null;
  try { g = window.WWGameDraft.parseHandle(saved); } catch (_) { window.WWGameDraft.clearHandle(localStorage, 'mww_current'); card.classList.add('hidden'); return; }
  // 会话摘要同时覆盖内存与磁盘；列表落盘有延迟，不能因列表暂缺就删除有效句柄。
  try {
    const r = await api('GET', `/api/games/${g.gameId}/session?token=${g.playerToken || g.godToken}`);
    if (!r || r.finished || !r.started) {
      window.WWGameDraft.clearHandle(localStorage, 'mww_current'); // 确实已结束 / 不存在 / 从未开局 → 才允许清句柄
      card.classList.add('hidden');
      return;
    }
    g = window.SessionModel.withView(g, r);
    state.resume = { handle: g, fromDisk: !r.inMemory };
    $('#m-resume-meta').textContent = `${g.ownerNickname || '原档案'} · ${resumeMetaText(g, r)}${!r.inMemory ? ' · 从存档恢复' : ''}`;
    card.classList.remove('hidden');
  } catch (_) { card.classList.add('hidden'); } // 离线/权限失败：保留句柄，联网后再验证。
}

/** 无句柄时（换浏览器/清了存储）按服务端可恢复局找回（管理会话；LAN 手机仍靠句柄） */
async function adoptResumableForHandleless() {
  const card = $('#m-resume-card');
  try {
    const { rows } = await api('GET', '/api/games');
    const r = window.SessionModel.findOwned(rows, state.profileId);
    if (!r) { card.classList.add('hidden'); return; }
    const t = await api('GET', `/api/games/${r.id}/tokens`);
    const handle = window.SessionModel.withView({ gameId: r.id, playerToken: t.player, godToken: t.god, mock: !!r.mock, savedAt: r.date ? new Date(r.date).getTime() : null }, r);
    state.resume = { handle, fromDisk: !r.inMemory };
    try { window.WWGameDraft.writeHandle(localStorage, 'mww_current', handle); } catch (_) {}
    $('#m-resume-meta').textContent = `${handle.ownerNickname || '原档案'} · ${resumeMetaText(handle, r)}` + (!r.inMemory ? ' · 服务已重启，将从存档恢复' : '');
    card.classList.remove('hidden');
  } catch (_) { card.classList.add('hidden'); }
}

function resumeMetaText(g, v) {
  // v 为 null（磁盘可恢复局，只有行状态）时退化为句柄里的信息
  const seats = v && v.players ? v.players.length : (g.seats || 0);
  const phase = v ? `第 ${v.day || 0} 天 · ${PHASE_LABEL[v.phase] || v.phase}` : '从存档恢复';
  const mode = g.mock === undefined ? '' : ` · ${g.mock ? '🧪 Mock 试玩' : '💳 真实对局'}`;
  const at = g.savedAt ? ` · 保存于 ${new Date(g.savedAt).toLocaleString()}` : '';
  return `${seats ? seats + ' 人局 · ' : ''}${mode ? mode.replace(' · ', '') + ' · ' : ''}${phase}${at}`;
}

async function resumeGame() {
  if (!state.resume || state.resuming) return;
  state.resuming = true;
  try {
    const next = await window.SessionModel.prepare(api, state.resume.handle, state.profileId, confirmForeignOwnerM);
    if (!next) return;
    next.savedAt = Date.now();
    state.resume = { handle: next };
    state.game = next;
    try { window.WWGameDraft.writeHandle(localStorage, 'mww_current', next); } catch (_) {}
    enterGame();
  } catch (e) {
    flash(`从存档恢复失败：${e.message}`);
  } finally { state.resuming = false; }
}

function confirmForeignOwnerM(handle) {
  const owner = handle.ownerNickname || '原档案';
  const current = (state.profiles.find((p) => p.id === state.profileId) || {}).nickname || '当前档案';
  return new Promise((resolve) => {
    const body = el('div');
    body.appendChild(elText('p', 'hint', `本局属于「${owner}」，当前浏览的是「${current}」。笔记与战绩仍记入原档案。`));
    const foot = el('div', 'btnrow');
    const finish = (proceed) => { closeSheet(); resolve(proceed); };
    const sw = el('button', 'btn primary', `切回「${owner}」并恢复`);
    sw.disabled = !state.profiles.some((p) => p.id === handle.ownerProfileId && !p.archivedAt);
    sw.addEventListener('click', () => { onSelectProfile(handle.ownerProfileId); finish(true); });
    const keep = el('button', 'btn ghost', '保持当前档案，进入原档案对局');
    keep.addEventListener('click', () => finish(true));
    const cancel = el('button', 'btn ghost', '暂不恢复');
    cancel.addEventListener('click', () => finish(false));
    foot.append(sw, keep, cancel);
    openSheet('对局归属确认', body, foot, { vetoClose: () => { resolve(false); return false; } });
  });
}

/** 把对局句柄（含保存时间）落回 localStorage；immediate=true 跳过 60s 节流 */
function persistGameHandle(immediate) {
  const g = state.game;
  if (!g || !g.gameId) return;
  const now = Date.now();
  if (!immediate && now - (state.lastHandleWrite || 0) < 60000) return;
  state.lastHandleWrite = now;
  g.savedAt = now;
  try { window.WWGameDraft.writeHandle(localStorage, 'mww_current', g); } catch (_) { /* 隐私模式忽略 */ }
}

// ---------------- 屏3：对局 ----------------
function enterGame() {
  persistGameHandle(true);
  showScreen('m-game');
  state.playerAfter = 0; state.roleShown = false; state.lastNightStep = null;
  state.speakingSeat = 0;
  // FIN-06：进对局默认落在发言页；返回栈压 game 哨兵（返回键→回发言页→离局确认）
  flowPinned = true; flowNewCount = 0; state.voteProgress = null; state.liveSince = null;
  setGameTab('speech');
  const top = backStack[backStack.length - 1];
  if (!top || top.kind !== 'game') trackOverlay('game', () => {});
  // 私人标注 V2（NOTE-04/05）：先读旧 key（迁移的输入，读不到新存储时兜底显示），
  // 再异步拉服务端标注（含旧数据一次性迁移）。拉到后 updateSeats 刷新角标。
  state.anno = { rev: 0, seats: {}, loaded: false, available: false, gameId: state.game.gameId };
  state.annoUndo = null; // 换局不残留撤销快照
  try { state.tags = window.WWGameDraft.readTags(localStorage, 'mww_tags_', state.game.gameId); } catch (_) { state.tags = {}; }
  $('#m-flow').innerHTML = '';
  const mycard = $('#m-mycard');
  if (mycard) mycard.dataset.sig = ''; // 换局强制重画身份牌（sig 相同的旧局残影）
  const paused = $('#m-paused-banner');
  if (paused) { paused.classList.add('hidden'); paused.innerHTML = ''; paused.dataset.sig = ''; }
  startPolling();
  initAnnotations();
}

// ---------------- 局内页签（FIN-06 §10.1：发言 | 玩家 | 笔记） ----------------
function setGameTab(name) {
  state.gameTab = name;
  const game = $('#m-game');
  game.classList.toggle('tab-speech', name === 'speech');
  game.classList.toggle('tab-players', name === 'players');
  game.classList.toggle('tab-notes', name === 'notes');
  // AC-02：页签类与面板显隐必须同一处管理——旧实现只切类，#m-notes-pane 的 hidden
  // 从未摘掉，笔记页签选中后面板仍 display:none（验收实测复现）
  const notes = name === 'notes';
  const board = $('#m-board');
  const pane = $('#m-notes-pane');
  if (board) board.classList.toggle('hidden', notes);
  if (pane) {
    pane.classList.toggle('hidden', !notes);
    pane.setAttribute('aria-hidden', notes ? 'false' : 'true');
  }
  const map = { speech: 'm-tabbtn-speech', players: 'm-tabbtn-players', notes: 'm-tabbtn-notes' };
  for (const [tab, id] of Object.entries(map)) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.classList.toggle('active', tab === name);
    b.setAttribute('aria-selected', tab === name ? 'true' : 'false');
  }
  if (name === 'notes') renderNotesListM(); // 每次进笔记页重读最新标注（保存过/别的窗口改过都能看到）
}

function startPolling() {
  // M1：停旧 → 建推送 → 否则退回轮询 的顺序判断收在共享模块（两端原本逐字相同的四行）
  window.WWConnectionState.startConnection({ stopPolling, startStream, startFallback: startPollFallback });
}
function startPollFallback() {
  if (!window.WWConnectionState.beginFallback(state, poll)) return; // 已在轮询：不叠定时器（与原来同义）
  poll();
}
function stopPolling() {
  window.WWConnectionState.stopConnection(state, ['stream']);
}

/**
 * SSE 推送：只在服务端有变化时推帧。推送是优化不是依赖——
 * 不支持/被反代缓冲/断流一律回退轮询，手机端照常可玩。
 * 看门狗：40s 既无帧也无心跳才判定连接已死（AC-09：服务端心跳 ≈16s 一次，
 * 旧值 8s 小于一个心跳周期，正常空闲必误降级；40s = 2 个心跳 + 余量，轮询兜底不受影响）。
 */
function startStream() {
  if (!window.WWConnectionState.canStream(state)) return false; // 不支持 SSE / 没有对局（两端原本逐字相同的三行）
  const g = state.game;
  try {
    state.stream = window.WWConnectionState.openStream({
      kind: 'player',
      url: window.WWConnectionState.streamUrl(g.gameId, g.playerToken || g.godToken, state.playerAfter || 0),
      onActivity: () => { state.lastStreamAt = Date.now(); },
      onFrame: (kind, v) => applyView(v),
      onEnd: () => { stopStream(); poll(); },
      onError: () => { stopStream(); appendSys('⚠ 推送中断，已切换为轮询'); startPollFallback(); },
    });
    state.lastStreamAt = Date.now();
    state.streamWatchdog = setInterval(() => {
      // M1：判空那一跳收进共享模块；阈值（本端 40s）与降级动作仍留在本端
      window.WWConnectionState.watchdogTick(state, () => Date.now() - (state.lastStreamAt || 0) > 40000, () => {
        stopStream();
        appendSys('⚠ 推送无响应，已切换为轮询');
        startPollFallback();
      });
    }, 8000);
    return true;
  } catch (_) {
    stopStream();
    return false;
  }
}

function stopStream() {
  window.WWConnectionState.stopStreams(state, ['stream']);
}

async function poll() {
  const g = state.game;
  if (!g) return;
  try {
    const v = await api('GET', window.WWConnectionState.viewUrl(g.gameId, g.playerToken || g.godToken, state.playerAfter));
    applyView(v);
  } catch (e) { appendSys(`⚠ 拉取失败：${e.message}`); }
}

/** 渲染一份视图。SSE 与轮询共用；事件按 seq 游标过滤，重连重发也不会画两遍。 */
function applyView(v) {
  if (!v) return;
  // FIN-06 §10.10：切后台/锁屏/切网回前台后，若服务端阶段/任务已推进，
  // 之前选的目标一律作废（不允许沿用过期目标直接提交），动作区按新任务重建。
  if (state.hiddenSnap) {
    const h = state.hiddenSnap;
    state.hiddenSnap = null;
    if ((v.day !== h.day) || (v.phase !== h.phase) || (((v.pending || {}).task) || '') !== h.task) {
      actionState.target = null; // FIX-15：作废即"没选"（此前写 0，与"显式空刀"同值，判空判不出来）
      const keys = $('#m-keys');
      if (keys) keys.dataset.task = ''; // 强制动作区下一次重建（目标作废要可见）
    }
  }
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
    if (node) {
      $('#m-flow').appendChild(node);
      // FIN-10 §13.1.3：用户上翻阅读时不拉走视野，改记"N 条新发言"，由「↓ 最新」提示
      if (!flowPinned && e.seq > freshFrom && (e.type === 'speech' || e.type === 'system' || e.type === 'night_step')) flowNewCount++;
    }
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
  persistGameHandle(false); // 节流落"保存时间"：首页继续上局卡显示最近保存点
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
    `<button class="btn primary" id="m-btn-resume-paused">${icoLabel('resume', '继续对局')}</button>` +
    `<button class="btn ghost" id="m-btn-terminate-paused">${icoLabel('end', '终止本局')}</button>` +
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
    state.game = { ...g, gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken };
    window.WWGameDraft.writeHandle(localStorage, 'mww_current', state.game); // 本端句柄 key 是 mww_current（曾误写 ww_current，恢复后句柄丢失）
    state.playerAfter = 0;
    $('#m-flow').innerHTML = '';
    const box = $('#m-paused-banner');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; }
    await poll();
    hint('已从断点继续 ✓');
  } catch (e) {
    hint(`✗ 恢复失败：${e.message}`);
    if (btn) { btn.disabled = false; btn.innerHTML = icoLabel('resume', '继续对局'); }
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
let flowNewCount = 0; // 上翻期间新增的发言条数（FIN-10：不拉走视野，改提示）
function scrollFlow(force) {
  const s = $('#m-flow');
  if (!s) return;
  if (force) { flowPinned = true; flowNewCount = 0; }
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
  const pinned = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  if (pinned) flowNewCount = 0; // 回到底部：未读清零
  flowPinned = pinned;
  updateToBottomBtn();
}
/** 往上翻历史时浮出「↓ 最新 / ↓ N 条新发言」：信息滚出视野后必须有一条随时回到底部的路 */
function updateToBottomBtn() {
  const b = $('#m-to-bottom');
  if (!b) return;
  b.classList.toggle('hidden', flowPinned);
  const label = flowNewCount > 0 ? `↓ <span class="newcnt">${flowNewCount} 条新发言</span>` : '↓ 最新';
  if (b.dataset.label !== label) { b.dataset.label = label; b.innerHTML = label; }
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
  if (state.game) state.game = window.SessionModel.withView(state.game, v);
  const owner = $('#m-owner');
  if (owner) { owner.textContent = `本局归属 · ${v.ownerNickname || '未关联档案'}`; owner.title = owner.textContent; }
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
  if (!ps.length) { left.innerHTML = ''; right.innerHTML = ''; left.dataset.roster = ''; right.dataset.roster = ''; return; }
  const roster = ps.map((p) => p.seat).join(',');
  const half = Math.ceil(ps.length / 2);
  // FIN-10 §13.1.1：座位以 seat 为 key 增量更新（发言字块/状态变化不再清空重建全部座位）；
  // 只有开局/换局（人数或座位集合变化）才走全量重建兜底。
  if (left.dataset.roster !== roster || right.dataset.roster !== roster) {
    left.dataset.roster = roster; right.dataset.roster = roster;
    left.innerHTML = ''; right.innerHTML = '';
    const portraits = window.AICast ? window.AICast.assignPortraits(ps) : new Map();
    ps.forEach((p) => {
      const s = el('div', 'srow');
      s.dataset.seat = String(p.seat);
      const ring = el('span', 'num');
      ring.appendChild(el('span', 'seat-index', String(p.seat)));
      if (window.AICast) window.AICast.decorate(ring, portraits.get(p.seat)); // 头像只在创建时画一次
      s.appendChild(ring);
      s.appendChild(el('div', 'nm'));
      s.addEventListener('click', () => {
        // 每次点击取**最新**玩家快照（onSeatTap 语义保留：选目标 / 开笔记 / 查看翻牌）
        const cur = ((state.view || {}).players || []).find((x) => x.seat === p.seat);
        if (cur) onSeatTap(cur);
      });
      (p.seat <= half ? left : right).appendChild(s);
    });
  }
  const mySeat = v.me ? v.me.seat : 0;
  const pick = actionState.needTarget ? new Set(actionState.candidates) : null;
  ps.forEach((p) => {
    const s = (p.seat <= half ? left : right).querySelector(`[data-seat="${p.seat}"]`);
    if (!s) return;
    s.classList.toggle('mine', p.seat === mySeat);
    s.classList.toggle('dead', !p.alive);
    s.classList.toggle('speaking', !!(p.alive && p.seat === state.speakingSeat));
    s.classList.toggle('pickable', !!(pick && p.alive && pick.has(p.seat)));
    s.classList.toggle('picked', actionState.target === p.seat);
    patchSeatBadges(s, p);
    const nm = s.querySelector('.nm');
    if (nm && nm.textContent !== p.name) nm.textContent = p.name; // 昵称不可信：textContent
  });
}

/** 座位角标增量同步：警徽 / 翻牌真身 / 我的标注摘要 / 旧格式兜底标记。签名不变不动 DOM。 */
function patchSeatBadges(s, p) {
  const revealed = !!(p.role && p.revealed);
  const sum = revealed ? '' : (seatTagSummary(p.seat) || '');
  const legacy = (!revealed && !sum && state.tags[p.seat] && roleInfo(state.tags[p.seat])) ? state.tags[p.seat] : null;
  const sig = `${p.isSheriff ? 1 : 0}|${revealed ? p.role : ''}|${sum}|${legacy || ''}`;
  if (s.dataset.badges === sig) return;
  s.dataset.badges = sig;
  const nm = s.querySelector('.nm');
  for (const old of [...s.querySelectorAll('.b, .tag-pill')]) old.remove();
  const put = (node) => { if (nm) s.insertBefore(node, nm); else s.appendChild(node); };
  if (p.isSheriff) put(el('span', 'b', '👑'));
  if (revealed) {
    const rr = roleInfo(p.role);
    const rc = el('span', 'b l', rr.emoji);
    rc.style.color = rr.color;
    put(rc);
  } else if (sum) {
    // 我的标注角标（NOTE-04）：倾向中文 · 首个候选身份 emoji+名。真身公开后由真身覆盖。
    const pill = el('span', 'tag-pill', ico('tag') + escapeHtml(sum));
    pill.title = '我的私人笔记摘要（AI 看不到）';
    put(pill);
  } else if (legacy) {
    // 旧格式兜底（无归属档案的旧局尚未迁移成功时）：保留旧 🏷 显示
    const b = el('span', 'b l', ico('tag'));
    b.style.color = roleInfo(legacy).color;
    put(b);
  }
}

// ---------------- 笔记页（FIN-06 §10.3）：全部座位标注列表 + 点击编辑 ----------------
// 复用桌面 renderNotesList 的语义（同一套 anno 数据与 seatTagSummary 摘要），布局按手机自实现：
// 全部座位各占一行（行高 ≥56），有笔记的排前面显示摘要，点任意一行进 openTagModal 底部弹层。
function renderNotesListM() {
  const box = $('#m-notes-list');
  if (!box) return;
  box.innerHTML = '';
  const v = state.view;
  if (!state.anno || !state.anno.loaded) { box.appendChild(el('p', 'hint', '标注加载中…')); return; }
  if (!v || !(v.players || []).length) { box.appendChild(el('p', 'hint', '对局尚未开始，还没有可标注的座位。')); return; }
  // 最近一次笔记撤销（§11 行11）：独立于游戏行动撤销；仅记录最近一次
  if (state.annoUndo && state.annoUndo.seat != null) {
    const u = el('div', 'm-note-undo');
    u.appendChild(el('span', 'hint', `${state.annoUndo.seat} 号刚被修改`));
    const ub = el('button', 'btn ghost small', icoLabel('undo', '撤销'));
    ub.addEventListener('click', async () => {
      const { seat, prev } = state.annoUndo;
      state.annoUndo = null;
      const token = state.game.playerToken || state.game.godToken;
      try {
        if (prev) {
          const r = await api('PUT', `/api/games/${state.game.gameId}/annotations`, { token, expectedRevision: state.anno.rev, seats: { [seat]: prev } });
          state.anno.rev = r.revision;
          state.anno.seats = r.annotations.seats || {};
        } else {
          const r = await api('DELETE', `/api/games/${state.game.gameId}/annotations?token=${encodeURIComponent(token)}&seat=${seat}&expectedRevision=${state.anno.rev}`);
          state.anno.rev = r.revision;
          state.anno.seats = r.annotations.seats || {};
        }
      } catch (e) {
        if (e.status === 409) {
          try {
            const r = await api('GET', `/api/games/${state.game.gameId}/annotations?token=${encodeURIComponent(token)}`);
            state.anno.rev = r.revision;
            state.anno.seats = r.annotations.seats || {};
          } catch (_) {}
        }
        flash(`撤销失败：${e.message}`);
      }
      if (state.view) updateSeats(state.view);
      renderNotesListM();
    });
    u.appendChild(ub);
    box.appendChild(u);
  }
  let hasAny = false;
  for (const p of [...v.players].sort((a, b) => a.seat - b.seat)) {
    const a = (state.anno.seats || {})[p.seat];
    const has = !!(a && (a.leaning !== 'neutral' || (a.candidateRoleIds || []).length || a.claimedRoleId || a.note));
    if (has) hasAny = true;
    const row = el('button', 'm-note-row' + (has ? '' : ' empty') + (p.alive ? '' : ' dead'));
    row.dataset.seat = String(p.seat);
    row.type = 'button';
    row.setAttribute('role', 'listitem');
    row.appendChild(el('span', 'n-num', String(p.seat)));
    const main = el('div', 'n-main');
    main.appendChild(elText('div', 'n-name', `${p.seat}号 ${p.name}${p.alive ? '' : '（出局）'}`));
    main.appendChild(elText('div', 'n-sum', has ? (seatTagSummary(p.seat) || '有笔记') : '未记录 · 点这里写笔记'));
    if (a && a.note) main.appendChild(elText('div', 'n-note', a.note));
    row.appendChild(main);
    row.appendChild(el('span', 'n-edit', has ? '编辑 ›' : '＋'));
    row.addEventListener('click', () => openTagModal(p.seat));
    box.appendChild(row);
  }
  if (!hasAny) {
    const tip = el('p', 'hint', '还没有任何笔记。点上面任意座位开始记录；笔记只是你的推理，AI 看不到。');
    tip.style.marginTop = 'var(--sp-2)';
    box.appendChild(tip);
  }
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
  const seatEl = $('#m-dialog-seat');
  if (seatEl) seatEl.textContent = seat ? `${seat} 号` : '未选择';
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

/** 流程区底部的"正在发言/正在思考"节点（流式打字）：把漫长的空白等待变成即时反馈。
 *  FIN-10 §13.1.2：流式文本只更新当前节点的文本子节点，秒表只重建 meta 行 —— 不整块重建。 */
function updateLive(v) {
  const flow = $('#m-flow');
  if (!flow) return;
  const live = v && v.live && !v.finished ? v.live : null;
  // 私密投票期间没有公开发言（live.public=false），但服务端会播报"已收集几票"——
  // 那是这个阶段唯一能让玩家知道"程序在跑"的信号，不能因为 live 为空就把节点收掉。
  const vpRaw = v && v.finished ? null : state.voteProgress;
  const vp = vpRaw && vpRaw.done < vpRaw.total ? vpRaw : null; // 收齐即收工，不依赖事件顺序
  let node = $('#m-live');
  if (!live && !vp) { if (node) node.remove(); state.liveSince = null; return; }
  if (!node) {
    node = el('div', 'msg live'); node.id = 'm-live';
    node.appendChild(el('div', 'meta'));
    node.appendChild(el('div', 'live-body'));
  }
  if (node.parentNode !== flow) flow.appendChild(node);
  else if (node !== flow.lastElementChild) flow.appendChild(node); // 始终贴底
  const lp = live ? (v.players || []).find((x) => x.seat === live.seat) : null;
  // 秒表：实测单条发言平均等 103.6s、最长 362s，而这段时间手机上**完全不动**。
  // 只显示"已 N 秒"，不泄露任何私密内容（秒数进 sig，让 1.2s 轮询把表走起来）。
  const lkey = live ? `${live.seat}|${live.task || ''}` : '';
  if (live && (!state.liveSince || state.liveSince.key !== lkey)) state.liveSince = { key: lkey, at: Date.now() };
  const secs = live ? Math.max(0, Math.round((Date.now() - state.liveSince.at) / 1000))
    : Math.max(0, Math.round((Date.now() - vp.at) / 1000));
  const meta = node.querySelector('.meta');
  const body = node.querySelector('.live-body');
  if (!live) {
    // 只有投票进度：明确告诉玩家"已经收到几票、等了多久"，而不是让他盯着空白
    const msig = `vp|${vp.done}/${vp.total}|${secs}`;
    if (node.dataset.msig !== msig) {
      node.dataset.msig = msig;
      meta.innerHTML = '<span class="hint">… 正在收集投票</span>';
      body.innerHTML = '';
      body.appendChild(elText('div', 'hint', `已思考 ${vp.done}/${vp.total} · ${secs}s`));
    }
    return;
  }
  const work = live.text ? '… 正在决策' : '… 正在思考';
  const msig = `${live.seat}|${live.public ? 1 : 0}|${live.public && live.text ? 'say' : work}|${secs}|${vp ? `${vp.done}/${vp.total}` : ''}|${lp ? lp.name : ''}`;
  if (node.dataset.msig !== msig) {
    node.dataset.msig = msig;
    meta.innerHTML = '<span class="who"></span> <span class="hint"></span>';
    meta.querySelector('.who').textContent = `${lp ? lp.name : ''} · ${live.seat}号`;
    meta.querySelector('.hint').textContent = `${live.public && live.text ? '✍ 正在发言' : work} · 已 ${secs}s${vp ? ` · ${vp.done}/${vp.total}` : ''}`;
  }
  if (node.dataset.txt !== (live.public && live.text ? live.text : '')) {
    node.dataset.txt = live.public && live.text ? live.text : '';
    body.innerHTML = '';
    if (live.public && live.text) {
      const txt = document.createElement('span');
      txt.className = 'typing-live';
      txt.textContent = live.text; // 模型输出：按纯文本渲染
      body.append(txt, el('span', 'caret'));
    } else {
      body.appendChild(elText('div', 'hint', '正在思考…'));
    }
  }
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

// ---------------- 私人标注 V2（NOTE-04/05，与桌面端同一套 API 与语义） ----------------
// 三层信息各司其职：候选身份（我还不确定）、自称身份（TA 说自己是谁）、倾向+把握（我的综合判断）。
// 合法性判断统一走 window.WWAnnotationsModel（web/shared/annotations-model.js，与 Node 侧同一套白名单）；
// 持久化在服务端档案目录（/api/games/:gid/annotations），带 revision 乐观并发；AI 完全不可见。
const AM = () => window.WWAnnotationsModel;

/** 进局初始化：① 旧 mww_tags_<gid>（{seat: roleId}）一次性迁移进新存储；② 拉取本局标注 */
async function initAnnotations() {
  const gid = state.game.gameId;
  const token = state.game.playerToken || state.game.godToken;
  // --- 迁移（NOTE-05，复审 P1-1）：逐座位合并 + 无损容纳检查；确认落盘后才清理本地 key ---
  // mergeLegacyTags 返回 { fill, pending }：pending 是候选/备注都放不下的座位 ——
  // 保留在本地 key 里待确认并弹提示，绝不静默丢弃，也绝不靠截断原备注腾位置。
  let legacy = null;
  try { legacy = window.WWGameDraft.readLegacyTags(localStorage, 'mww_tags_', gid); } catch (_) {}
  if (legacy && Object.keys(legacy).length) {
    let migrated = false;
    try {
      const cur = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
      const serverSeats = (cur.annotations && cur.annotations.seats) || {};
      const { fill, pending } = AM().mergeLegacyTags(serverSeats, legacy, (rid) => (state.meta.roles && state.meta.roles[rid]) || null);
      let rev = cur.revision;
      let seats = serverSeats;
      if (Object.keys(fill).length) {
        const put = await api('PUT', `/api/games/${gid}/annotations`, { token, expectedRevision: cur.revision, seats: fill });
        rev = put.revision;
        seats = put.annotations.seats || {};
      }
      state.anno.rev = rev;
      state.anno.seats = seats;
      if (Object.keys(pending).length) {
        // 待确认：本地 key 只保留未解决的座位，下次迁移仍会尝试
        try { window.WWGameDraft.writeTags(localStorage, 'mww_tags_', gid, pending); } catch (_) {}
        state.tags = pending;
        openLegacyPendingPrompt(pending);
      } else {
        window.WWGameDraft.clearTags(localStorage, 'mww_tags_', gid); // 全部落盘确认后才清理
        state.tags = {};
      }
      migrated = true;
    } catch (_) { /* 迁移失败（无归属档案/离线/409）：保留本地旧格式继续显示，不阻塞对局 */ }
    if (!migrated) { try { state.tags = legacy; } catch (_) {} }
  }
  // --- 常规拉取 ---
  try {
    const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
    state.anno.rev = r.revision;
    state.anno.seats = r.annotations.seats || {};
    state.anno.available = true;
  } catch (_) { /* 旧局无归属档案（404）：标注功能降级为旧格式本地标记，不阻塞对局 */ }
  state.anno.loaded = true;
  if (state.view) updateSeats(state.view); // 角标按最新标注重画
  renderNotesListM(); // 笔记页（若已打开）同步可编辑列表
}

/** 旧标记待确认提示（复审 P1-1，与桌面端 openLegacyPendingPrompt 同语义）：
 *  候选与备注都满的座位无法自动并入；本地 key 已保留这些座位，给出可见入口让用户编辑并入或显式丢弃。 */
function openLegacyPendingPrompt(pending) {
  const seats = Object.keys(pending);
  if (!seats.length) return;
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('tag')} 旧标记待确认</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', closeModalTop);
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', '以下座位的旧版标记无法自动并入你的笔记（该座位的候选与备注已满）。旧数据仍保留在本机，不会丢失；请选择编辑并入或显式丢弃：'));
  const list = el('div', 'pm-list');
  for (const seat of seats) {
    const rid = pending[seat];
    const r = state.meta.roles && state.meta.roles[rid];
    const row = el('div', 'pm-row');
    const main = el('div', 'pm-main');
    main.appendChild(elText('div', 'pm-name', `${seat} 号 · 旧标记：${r ? r.name : rid}`));
    row.appendChild(main);
    const ops = el('div', 'pm-ops');
    const edit = el('button', 'btn ghost small', '编辑并入');
    edit.addEventListener('click', () => {
      // 编辑弹层替换本提示层（返回键一层层关，不留下已关闭的影子层）
      overlayReplaceNext = true;
      closeModalDom();
      openTagModal(Number(seat)); // 保存成功后即并入；取消则仍留在待确认记录里
    });
    const drop = el('button', 'btn small danger', '丢弃旧标记');
    drop.addEventListener('click', () => {
      delete pending[seat];
      try {
        if (Object.keys(pending).length) window.WWGameDraft.writeTags(localStorage, 'mww_tags_', state.game.gameId, pending);
        else window.WWGameDraft.clearTags(localStorage, 'mww_tags_', state.game.gameId);
      } catch (_) {}
      closeModalTop();
      if (Object.keys(pending).length) openLegacyPendingPrompt(pending);
    });
    ops.append(edit, drop);
    row.appendChild(ops);
    list.appendChild(row);
  }
  body.appendChild(list);
  wrap.append(head, body);
  openModal(wrap);
}

/** 座位角标文案：倾向中文 · 首个候选身份 emoji+名（与桌面端 seatTagSummary 同一规则） */
function seatTagSummary(seat) {
  const A_ = AM();
  const a = state.anno && state.anno.seats && state.anno.seats[seat];
  if (!a || !A_) return null;
  if ((a.leaning || 'neutral') === 'neutral' && !(a.candidateRoleIds || []).length && !a.claimedRoleId) return null;
  const parts = [];
  if (a.leaning && a.leaning !== 'neutral') parts.push(A_.LEANING_CN[a.leaning] || a.leaning);
  const rid = (a.candidateRoleIds && a.candidateRoleIds[0]) || a.claimedRoleId;
  const r = rid && state.meta.roles && state.meta.roles[rid];
  if (r) parts.push(`${r.emoji}${r.name}`);
  return parts.join(' · ') || null;
}

/** 保存一座位标注：expectedRevision=当前 revision。成功刷新角标；409 弹人工合并，绝不静默覆盖 */
function saveAnnotations(seat, entry) {
  const gid = state.game.gameId;
  const token = state.game.playerToken || state.game.godToken;
  const prev = state.anno.seats[seat] ? JSON.parse(JSON.stringify(state.anno.seats[seat])) : null; // 撤销快照（§11 行11）
  return api('PUT', `/api/games/${gid}/annotations`, { token, expectedRevision: state.anno.rev, seats: { [seat]: entry } })
    .then((r) => {
      state.anno.rev = r.revision;
      state.anno.seats = r.annotations.seats || {};
      state.annoUndo = { seat, prev }; // 仅记录最近一次；撤销不复用游戏行动撤销
      if (state.view) updateSeats(state.view);
      renderNotesListM(); // 笔记页若开着，同步最新标注（FIN-10：保存不清草稿不抢焦点）
      return true;
    })
    .catch((e) => {
      if (e.status === 409 || String(e.message).includes('409') || /另一窗口/.test(e.message)) {
        // 并发冲突：另一窗口更新过。给"载入最新并保留我这份"的人工合并路径，绝不静默覆盖。
        const keep = entry; // 本地正在编辑的这份
        const box = el('div');
        box.appendChild(el('p', null, '⚠ 另一个窗口更新了笔记（版本冲突）。'));
        box.appendChild(el('p', 'hint', '可载入最新笔记（保留你正在编辑的这一个座位的修改），或放弃本次修改。'));
        const br = el('div', 'btnrow');
        const merge = el('button', 'btn', '载入最新并保留我这份');
        merge.addEventListener('click', async () => {
          merge.disabled = true;
          try {
            const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
            state.anno.rev = r.revision;
            state.anno.seats = r.annotations.seats || {};
            closeModalTop();
            const okFlag = await saveAnnotations(seat, keep); // 以最新 revision 重放这一座位的修改
            if (okFlag) closeSheet();
          } catch (_) { alert('合并保存仍失败，请稍后重试'); merge.disabled = false; }
        });
        const discard = el('button', 'btn ghost', '放弃');
        discard.addEventListener('click', async () => {
          discard.disabled = true;
          try {
            const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
            state.anno.rev = r.revision;
            state.anno.seats = r.annotations.seats || {};
          } catch (_) { /* 拉不下来就保持内存现状 */ }
          closeModalTop();
          closeSheet();
          if (state.view) updateSeats(state.view);
          renderNotesListM();
        });
        br.append(merge, discard);
        box.appendChild(br);
        closeModalTop(); // 中部 modal 压在底部弹层（z-index 更高）之上
        openModal(box);
      } else {
        // 其它失败：底部弹层不关，草稿保留在输入框，把错误写在弹层里
        const errBox = document.getElementById('m-anno-err');
        if (errBox) errBox.textContent = `保存失败：${e.message}（草稿未丢失）`;
        else alert(`保存失败：${e.message}`);
      }
      return false;
    });
}

/**
 * 清除一个座位的私人标注（FIX-07）：走服务端的 **DELETE 语义**，而不是"PUT 一份空标注"。
 * 为什么必须删：PUT 空标注只是把内容清空，座位键仍留在 `doc.seats` 里 ——
 *   · 导出包 `counts.notes` 按"有 seats 的游戏"计数（src/profiles/transfer.js:59），已清空的座位把计数撑高；
 *   · 标注文件只增不减，座位键永远清不掉。
 * 契约（src/api.js 的 gameAnnotationDelete）：`DELETE /api/games/<gid>/annotations?token=&seat=&expectedRevision=`
 *   → 200 { annotations, revision }；seat 非数字 400、权限不足 403、revision 过期 409。
 * 与 PUT 一样带 expectedRevision 乐观并发：409 时重拉最新版本后重试一次（不无限重试）。
 * 失败要可读：写在弹层的错误行里（#m-anno-err），并明确笔记没丢。
 */
function clearSeatAnnotation(seat) {
  const gid = state.game.gameId;
  const token = state.game.playerToken || state.game.godToken;
  const prev = state.anno.seats[seat] ? JSON.parse(JSON.stringify(state.anno.seats[seat])) : null;
  const del = () => api('DELETE', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}&seat=${seat}&expectedRevision=${state.anno.rev}`);
  return del()
    .catch((e) => {
      if (e.status !== 409) throw e;
      return api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`).then((fresh) => {
        state.anno.rev = fresh.revision;
        state.anno.seats = fresh.annotations.seats || {};
        return del();
      });
    })
    .then((r) => {
      state.anno.rev = r.revision;
      state.anno.seats = r.annotations.seats || {}; // 以服务端返回为准：座位键真的没了，列表/角标才不会再显示
      state.annoUndo = { seat, prev };
      if (state.view) updateSeats(state.view);
      renderNotesListM();
      return true;
    })
    .catch((e) => {
      const errBox = document.getElementById('m-anno-err');
      if (errBox) errBox.textContent = `清除失败：${e.message}（笔记未丢失）`;
      else alert(`清除失败：${e.message}（笔记未丢失）`);
      return false;
    });
}

/**
 * 笔记草稿的会话存储钩子（§9.3 :302）：键是 **owner + gameId + seat**。
 * `owner` 用**开局时固化的对局归属**（`state.game.ownerProfileId`），而不是"现在浏览器选中的档案"——
 * 局中允许切到别的档案去看战绩，回来时这个座位的草稿必须还在原地。
 * 为什么做成 state 上的钩子：openTagModal 会被 test/annotation-editor.test.js 整段抽出、
 * 在没有 window 的沙箱里单跑，函数体里读不了新全局（详见 openTagModal 里的说明）。
 */
state.noteDraftHook = (() => {
  const at = (seat) => {
    const g = state.game;
    if (!g || !g.gameId) return null; // 没有对局 ⇒ 没有草稿归属，宁可不写也不写到错的键上
    return { ownerProfileId: g.ownerProfileId || null, gameId: g.gameId, seat };
  };
  return {
    at,
    load: (seat) => { const a = at(seat); return a ? window.WWDraftStore.readNoteDraft(sessionStorage, a) : null; },
    save: (seat, draft) => { const a = at(seat); if (a) window.WWDraftStore.writeNoteDraft(sessionStorage, a, draft); },
    clear: (seat) => { const a = at(seat); if (a) window.WWDraftStore.clearNoteDraft(sessionStorage, a); },
  };
})();

/** 标注编辑器（NOTE-04）：底部弹层。倾向/把握/候选（≤3）/自称/笔记/依据，保存取消常驻底部 */
function openTagModal(seat) {
  const v = state.view;
  // 无归属档案的旧局（服务端 404）：退回旧版本地标记，保持可用可读（NOTE-05）
  if (!state.anno || !state.anno.available) return openLegacyTagModal(seat);
  const A_ = AM();
  if (!A_) return openLegacyTagModal(seat); // 共享模型未加载（离线缓存旧包）时的兜底
  const roles = possibleRolesFor(v, seat); // 仍可能的身份（沿用现有逻辑）
  const cur = state.anno.seats[seat] || {};
  const blank = () => ({
    leaning: cur.leaning || 'neutral',
    candidateRoleIds: [...(cur.candidateRoleIds || [])],
    claimedRoleId: cur.claimedRoleId || null,
    confidence: cur.confidence || 'low',
    note: cur.note || '',
    evidenceSeq: cur.evidenceSeq || null,
    day: cur.day || (v ? v.day : null),
    phase: cur.phase || (v ? v.phase : null),
  });
  const draft = blank();

  // §9.3 :302 笔记草稿按 **owner + gameId + seat** 保存（**不按当前浏览档案归属**）：
  // 打开时先看看这个座位有没有上次没提交的草稿 —— 切到别的档案看一眼战绩再回来，内容必须还在。
  // ⚠ 这里只能走 `state` 上的钩子（钩子在本文件 openTagModal **之前**登记到 `state.noteDraftHook`）：
  //   本函数被 test/annotation-editor.test.js **整段抽出来**丢进一个只有 el/state/… 的 vm 沙箱里单跑，
  //   引用任何新全局都会让那条既有用例当场 ReferenceError。
  const hook = state.noteDraftHook || null;
  const savedDraft = hook ? hook.load(seat) : null;
  if (savedDraft && typeof savedDraft === 'object') {
    for (const k of Object.keys(draft)) if (savedDraft[k] !== undefined && savedDraft[k] !== null) draft[k] = savedDraft[k];
  }
  /**
   * dirty 的基准是**打开这一刻（含草稿恢复之后）的样子**，不是"服务端已保存的值"。
   * 为什么（两件事都要成立）：
   *   · 恢复出来的草稿**不会**被当成"未保存的修改"：否则每次打开一个还有草稿的座位，
   *     点 X/遮罩/取消都会弹"有未保存的修改，确定放弃？"——而关掉弹层并不会删掉草稿，
   *     这个对话框纯属噪音，还会在 ui-check 里把页面挡住（那里没有原生对话框的自动处理器）；
   *   · **在本次打开里真改过** ⇒ 照样判 dirty（下面的既有用例钉的就是这一条）。
   * 二者都不损失数据：草稿只在"保存成功"或"显式清除"时才删。
   */
  const openedAs = JSON.stringify(draft);
  const dirty = () => JSON.stringify(draft) !== openedAs;
  /** 草稿变更即落**会话存储**（切档/关弹层都不销毁它；保存成功或显式清除才删） */
  const persist = () => { if (hook) hook.save(seat, draft); };

  const body = el('div');
  const pname = (v.players.find((p) => p.seat === seat) || {}).name || '';
  const intro = el('p', 'hint');
  intro.textContent = `${seat}号 ${pname} · 只是你的推理笔记，AI 看不到；身份已公开的座位会自动显示真身。`;
  body.appendChild(intro);

  // ① 倾向 + ② 把握
  body.appendChild(el('h4', null, '倾向判断'));
  const leanRow = el('div', 'chip-row');
  for (const lv of A_.LEANINGS) {
    const c = el('button', 'chip' + (draft.leaning === lv ? ' sel' : ''), A_.LEANING_CN[lv]);
    c.type = 'button';
    c.addEventListener('click', () => { draft.leaning = lv; [...leanRow.children].forEach((x) => x.classList.remove('sel')); c.classList.add('sel'); });
    leanRow.appendChild(c);
  }
  body.appendChild(leanRow);
  const confRow = el('div', 'chip-row');
  for (const cv of ['low', 'medium', 'high']) {
    const c = el('button', 'chip' + (draft.confidence === cv ? ' sel' : ''), `${A_.CONFIDENCE_CN[cv]}把握`);
    c.type = 'button';
    c.addEventListener('click', () => { draft.confidence = cv; [...confRow.children].forEach((x) => x.classList.remove('sel')); c.classList.add('sel'); });
    confRow.appendChild(c);
  }
  body.appendChild(confRow);

  // ③ 候选身份（≤3）：只列"仍可能"的身份；再点一次取消
  body.appendChild(el('h4', null, `候选身份（最多 ${A_.MAX_CANDIDATES} 个）`));
  const candRow = el('div', 'chip-row');
  for (const rid of roles) {
    const r = roleInfo(rid);
    const sel = () => draft.candidateRoleIds.includes(rid);
    const c = el('button', 'chip' + (sel() ? ' sel' : ''), `${r.emoji} ${r.name}`);
    c.type = 'button';
    c.addEventListener('click', () => {
      if (sel()) draft.candidateRoleIds = draft.candidateRoleIds.filter((x) => x !== rid);
      else { if (draft.candidateRoleIds.length >= A_.MAX_CANDIDATES) return; draft.candidateRoleIds.push(rid); }
      c.classList.toggle('sel');
    });
    candRow.appendChild(c);
  }
  body.appendChild(candRow);

  // ④ 自称身份（TA 声称的，不等于你信的）。AC-07：列出全板子角色（可记录对跳），不按候选池过滤
  body.appendChild(el('h4', null, '自称身份（TA 声称的，不一定信）'));
  const claimSel = el('select');
  claimSel.appendChild(el('option', null, '（未声称）')).value = '';
  for (const rid of [...new Set([...Object.keys(v.board || {}).filter((id) => v.board[id] > 0), draft.claimedRoleId])]) {
    const r = state.meta.roles[rid];
    if (!r) continue;
    claimSel.appendChild(el('option', null, `${r.emoji} ${r.name}`)).value = rid;
  }
  claimSel.value = draft.claimedRoleId || '';
  claimSel.addEventListener('change', () => { draft.claimedRoleId = claimSel.value || null; });
  body.appendChild(claimSel);

  // ⑤ 笔记正文 + 依据出处（事件序号）
  const noteL = el('label');
  noteL.appendChild(el('span', null, `笔记（最多 ${A_.MAX_NOTE} 字；可记录"依据第几条发言"）`));
  const noteI = el('textarea');
  noteI.maxLength = A_.MAX_NOTE;
  noteI.rows = 3;
  noteI.value = draft.note || '';
  noteI.addEventListener('input', () => { draft.note = noteI.value; });
  noteI.placeholder = '例：跳预言家但查杀方向存疑，依据第 12 条发言';
  noteL.appendChild(noteI);
  body.appendChild(noteL);
  const evL = el('label');
  evL.appendChild(el('span', null, '依据事件序号（选填，发言流里每条前的 #号）'));
  const evI = el('input');
  evI.type = 'number';
  evI.min = '1';
  evI.value = draft.evidenceSeq || '';
  evI.addEventListener('input', () => { draft.evidenceSeq = evI.value ? Number(evI.value) : null; });
  evL.appendChild(evI);
  body.appendChild(evL);

  const err = el('p', 'hint'); err.style.color = '#ff8080'; err.id = 'm-anno-err';
  body.appendChild(err);

  const foot = el('div', 'btnrow');
  // X / 遮罩 / 取消 / 系统返回键都先过同一道 veto：有未保存修改必须显式确认，不静默丢草稿
  const vetoClose = () => dirty() && !confirm('有未保存的修改，确定放弃？');
  const cancel = el('button', 'btn ghost', '取消');
  cancel.addEventListener('click', () => { if (!vetoClose()) closeSheet(); });
  foot.appendChild(cancel);
  const save = el('button', 'btn primary', '保存笔记');
  save.addEventListener('click', async () => {
    const entry = A_.normalizeSeatAnnotation({
      leaning: draft.leaning,
      candidateRoleIds: draft.candidateRoleIds,
      claimedRoleId: draft.claimedRoleId,
      confidence: draft.confidence,
      note: noteI.value,
      evidenceSeq: evI.value ? Number(evI.value) : null,
      day: draft.day, phase: draft.phase,
    });
    save.disabled = true;
    const okFlag = await saveAnnotations(seat, entry);
    if (okFlag) { if (hook) hook.clear(seat); closeSheet(); } // 保存成功 ⇒ 该座位草稿已落盘，删掉
    else save.disabled = false; // 保存失败：弹层不关，草稿保留
  });
  foot.appendChild(save);
  if (cur && (cur.leaning !== 'neutral' || (cur.candidateRoleIds || []).length || cur.claimedRoleId || cur.note)) {
    const clr = el('button', 'btn danger', '清除');
    clr.addEventListener('click', async () => {
      save.disabled = true; clr.disabled = true;
      // FIX-07：真正删除（DELETE），不是写一份空标注 —— 否则座位键留在 doc.seats 里，计数只增不减
      const okFlag = await clearSeatAnnotation(seat);
      if (okFlag) { if (hook) hook.clear(seat); closeSheet(); } // 显式清除 = 该座位草稿作废
      else { save.disabled = false; clr.disabled = false; }
    });
    foot.appendChild(clr);
  }
  openSheet(`${seat} 号的私人笔记`, body, foot, { vetoClose, icon: 'notes' });
  // 草稿落盘用**事件委托**挂一次：弹层里几十个控件（倾向/把握/候选/自称/正文/依据）逐个挂必然漏，
  // 漏掉的那个字段在切档或换座位时就串了。各控件自己的监听器先跑，冒泡到这里时 draft 已经是最新的。
  // ⚠ 挂在**本弹层的 body 上**（不是 #m-sheet 根节点）：弹层根节点的 innerHTML 每次重开都被清空，
  //   但挂在根节点上的监听器会跨弹层活下来 —— 那样已关闭弹层的旧 draft 会在下一层被"复活"再写回去。
  body.addEventListener('input', persist);
  body.addEventListener('change', persist);
  body.addEventListener('click', persist);
  // §5.2 登记给切档守卫：本窗口有未保存笔记 ⇒ 切档先确认。
  // 必须在 openSheet **之后**登记 —— 打开/换页都会清掉上一层的 dirty 引用。
  state.noteDirty = dirty;
}

/** 旧格式兜底（无归属档案的旧局 404 / 共享模型缺失）：本地身份标记 {seat: roleId}，只存 localStorage */
function openLegacyTagModal(seat) {
  const v = state.view;
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('tag')} 标记 ${seat} 号</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', closeModalTop);
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', '本局的私人标注服务不可用（旧局无归属档案或网络受限），只能保存本地身份标记（旧格式，AI 看不到）；新开一局即可使用完整私人标注。'));
  const chips = el('div', 'chip-row');
  for (const rid of possibleRolesFor(v, seat)) {
    const r = roleInfo(rid);
    const c = el('button', 'chip' + (state.tags[seat] === rid ? ' sel' : ''), `${r.emoji} ${r.name}`);
    c.addEventListener('click', () => { state.tags[seat] = rid; saveTags(); closeModalTop(); updateSeats(state.view); });
    chips.appendChild(c);
  }
  body.appendChild(chips);
  if (state.tags[seat]) {
    const clr = el('button', 'btn danger', '清除标记');
    clr.style.marginTop = '12px';
    clr.addEventListener('click', () => { delete state.tags[seat]; saveTags(); closeModalTop(); updateSeats(state.view); });
    body.appendChild(clr);
  }
  wrap.append(head, body);
  openModal(wrap);
}

function saveTags() { try { window.WWGameDraft.writeTags(localStorage, 'mww_tags_', state.game.gameId, state.tags); } catch (_) {} }
function openModal(inner) {
  const root = $('#m-modal');
  const wasOpen = overlayAlive('modal'); // 弹窗换弹窗（齿轮→设置/确认）：同一层换内容，返回深度不变
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
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModalTop(); });
  root.appendChild(mask);
  trackOverlay('modal', closeModalDom, { swapIfOpen: wasOpen });
}

// ---------------- 底部坞：左（身份牌 + 技能键）| 右（对话框） ----------------
let actionState = { target: null, explode: false, withdraw: false, needTarget: false, candidates: [] };

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

/** 需要"点座位选人"的任务 → 确认键文案 / 允许的免选键 / 目标名词（FIX-15 可读提示用） */
const TARGET_TASKS = {
  night_guard: ['确认守护', '空守', '守护对象'],
  night_dream: ['确认摄梦', null, '摄梦对象'],
  wolfbeauty_charm: ['确认魅惑', null, '魅惑对象'],
  crow_curse: ['确认诅咒', null, '诅咒对象'],
  admirer_crush: ['确认心动', null, '暗恋对象'],
  wolf_kill: ['投刀', '空刀', '刀口'],
  seer_check: ['查验', null, '查验对象'],
  vote: ['投票', '弃票', '投票对象'],
  pk_vote: ['投票', '弃票', '投票对象'],
  sheriff_vote: ['投票', '弃票', '投票对象'],
  shoot: ['开枪', '不开枪', '开枪目标'],
  badge_pass: ['移交', '撕毁警徽', '接任警长'],
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
    // FIN-03：composing 期间 Enter 不发送
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!send.disabled) send.click();
    });
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
      ? `本局已结算 —— 看总结，或从左上角 ${ico('settings')} 里查看规则书与退出。`
      : '现在轮不到你操作。轮到你会在这里出现输入框或技能键。'));
    if (v.finished) {
      keys.appendChild(keyEl(icoLabel('summary', '查看本局总结'), 'on', () => openSummarySheet()));
      keys.appendChild(keyEl(icoLabel('home', '回到首页'), '', () => { window.WWGameDraft.clearHandle(localStorage, 'mww_current'); location.reload(); }));
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
  // FIX-15：target 初值 null = "还没选"；0 = "显式放弃"（空刀/空守/弃票，由各自的键写入）。
  // 以前两者都是 0，"没选就提交"无法与"明确放弃"区分，于是未选目标时只能把确认键禁用 ——
  // 点了毫无反应也没有任何文字（玩家不知道自己为什么没投出去）。
  actionState = { target: null, explode: false, withdraw: false, needTarget: false, candidates: (p.candidates || []).slice() };
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
  const b = el('button', 'btn danger duel-now-btn', icoLabel('duel', '决斗'));
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
  const b = el('button', 'btn danger explode-now-btn', icoLabel('explode', '自爆'));
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

/**
 * R01：**面板期冻结**的人类动作凭据（手机端）。
 * 只从真实的 view.pending 取值，并在构建底部坞的那一刻取一次；闭包里不再读 state.game。
 */
function freezePending(v, p) {
  return Object.freeze({
    gameId: (state.game && state.game.gameId) || null,
    token: (state.game && state.game.playerToken) || null,
    pendingId: (p && p.pendingId != null) ? p.pendingId : null, // 非等待态为 null，服务端行为不变
    task: (p && p.task) || null,
  });
}

/** **人类动作的唯一提交路径**（R01 第 1 条）：确认键、技能快捷键、跳过按钮全部走这里 */
async function submitHumanAction(pend, payload) {
  const body = { token: (pend && pend.token) || state.game.playerToken, payload };
  if (pend && pend.pendingId != null) body.pendingId = pend.pendingId; // 顶层为主
  const gid = (pend && pend.gameId) || (state.game && state.game.gameId);
  return api('POST', `/api/games/${gid}/action`, body);
}

/** 失败瞬间抓草稿（已选目标 + 对话框输入），只在任务未变时放回 */
function captureDraft() {
  const ta = document.querySelector('#m-dialog textarea');
  return { target: actionState.target, text: ta ? ta.value : '' };
}
function restoreDraft(d) {
  if (!d) return;
  const ta = document.querySelector('#m-dialog textarea');
  if (ta && d.text) ta.value = d.text;
  if (d.target !== undefined) actionState.target = d.target;
}

/** 失败统一处理（R01 第 3、4 条）：保留草稿 + 刷新任务 + 明确提示；不自动重放、不动后端校验 */
async function afterActionFailure(e, pend) {
  const status = e && e.status;
  const conflict = status === 409;
  const unknown = !status;
  if (!conflict && !unknown) { hint(`✗ ${e.message}`); return; }
  const draft = captureDraft();
  await poll().catch(() => {}); // 先同步真实状态
  const nowTask = (state.view && state.view.pending && state.view.pending.task) || null;
  const same = !!(nowTask && pend && nowTask === pend.task);
  if (same) restoreDraft(draft);
  hint(conflict
    ? `✗ ${e.message}（已刷新当前任务${same ? '，你的输入已保留' : ''}；请确认后重新提交）`
    : `✗ ${(e && e.message) || '网络异常'}（网络结果不明，已同步最新状态，请确认后再提交）`);
}

async function submitSimple(payload, pend) {
  if (state.submitting) return; // FIN-03：双击只产生一次业务提交
  if (navigator.onLine === false) { hint('⚠ 当前离线：等网络恢复后再提交'); return; } // 断网不基于过期任务提交
  state.submitting = true;
  const keys = $('#m-keys');
  const busy = keys ? keys.querySelector('[data-confirm]') : null;
  if (busy) { busy.disabled = true; busy.classList.add('m-busy'); } // 处理中保持宽度、吞点击
  try {
    await submitHumanAction(pend, payload);
    $('#m-keys').innerHTML = ''; $('#m-keys').dataset.task = '';
    $('#m-dialog').innerHTML = ''; $('#m-dialog').dataset.task = '';
  } catch (e) {
    // 失败不清输入：既能"签名未变不重建"，也能在刷新任务后由 afterActionFailure 放回草稿
    if (busy) { busy.disabled = false; busy.classList.remove('m-busy'); }
    await afterActionFailure(e, pend);
  } finally { state.submitting = false; }
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
  // AC-11：模式卡选中态（#m-mock-btn 现为模式卡之一；红字开关已废除）
  // 卡片标签表达选项本身，不把未选中的「试玩」写成「真实对局」。保留标题/说明层级。
  b.classList.toggle('sel', !!state.mock);
  b.setAttribute('aria-checked', state.mock ? 'true' : 'false');
  const rb = document.querySelector('#m-real-btn');
  if (rb) { rb.classList.toggle('sel', !state.mock); rb.setAttribute('aria-checked', state.mock ? 'false' : 'true'); }
}

/**
 * 底部坞组装：
 *   对话框（右侧）= 发言输入 / 任务说明 / 已选目标
 *   技能键（左侧）= 确认与技能开关，**可用为红、不可用为灰红**
 * 目标类任务不再在底部堆一排座位号 —— 直接点左右两列的座位选人（见 onSeatTap）。
 */
function buildActionUI(v, p, keys, dlg) {
  // R01：**面板期冻结**凭据；下面的 simple(...) 与所有技能键闭包全部用它，闭包里不再读 state
  const pend = freezePending(v, p);
  const simple = (payload) => submitSimple(payload, pend);

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
          // FIX-15：target 初值已改为 null，白狼王自爆这里显式落成 0（与改动前发给服务端的字节一致）
          if (me.role === 'whitewolfking') payload.target = Number(actionState.target) || 0;
        }
        if (p.task === 'sheriff_speech') payload.withdraw = actionState.withdraw;
        await simple(payload);
      }
    );
    send.dataset.confirm = '1';
    ta.addEventListener('input', () => setKeyEnabled(send, canSend()));
    setKeyEnabled(send, canSend());
    // FIN-03：Enter 直接发送，但中文 composing 期间 Enter 只上屏候选，不发送
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!send.disabled) send.click();
    });
    // 发送键和其它技能键放在同一条动作行里（以前单独占一行、还把行拉满宽，
    // 结果输入框被上下夹击显得变形）
    keys.appendChild(send);
    if (p.canExplode && me.role === 'whitewolfking') markNeedTarget(v, v.players.filter((x) => x.alive && x.seat !== me.seat).map((x) => x.seat), '选择自爆要带走的玩家');
    if (p.canExplode) {
      keys.appendChild(keyEl(icoLabel('explode', '自爆'), 'alt', () => {
        actionState.explode = !actionState.explode;
        hint(actionState.explode ? '已勾选自爆：发送后立即公开狼人身份并进入黑夜' : '已取消自爆');
        refreshCanvas(v);
      }));
    }
    if (p.canWithdraw) {
      keys.appendChild(keyEl(icoLabel('withdraw', '退水'), 'alt', () => {
        actionState.withdraw = !actionState.withdraw;
        setKeyEnabled(send, canSend());
        hint(actionState.withdraw ? '已选择退水：发送后退出竞选' : '已取消退水');
      }));
    }
    if (p.task === 'wolf_say') {
      keys.appendChild(keyEl('跳过本轮', 'alt', () => simple({ text: '' })));
    }
    return;
  }

  // ---------- 目标类：点座位选人，确认键灰红→红 ----------
  if (TARGET_TASKS[p.task]) {
    const [label, none, noun] = TARGET_TASKS[p.task];
    actionState.needTarget = true;
    markNeedTarget(v, p.candidates, '到「玩家」页点选目标座位');
    // FIX-15：确认键**始终可点**（原来未选目标时是 disabled → 点了毫无反应、也没有任何文字，
    // 玩家不知道自己为什么没投出去）。现在未选目标就给出可读提示，与桌面端同款文案；
    // 选中座位后 setTarget() 会把它点亮成"主操作红"。显式点「空刀/空守/弃票」的行为完全不变。
    const conf = keyEl(label, 'alt', () => {
      if (actionState.target === null || actionState.target === undefined) {
        hint(`✗ 请先在「玩家」页点一个座位选出${noun || '目标'}${none ? `（想放弃这次操作就点「${none}」）` : ''}`);
        return;
      }
      simple({ target: actionState.target });
    }, { confirm: true });
    keys.appendChild(conf);
    if (p.allowNone && none) keys.appendChild(keyEl(none, 'alt', () => simple({ target: 0 })));
    // 单个候选时直接预选，省一次点击
    if (p.candidates && p.candidates.length === 1) setTarget(p.candidates[0]);
    return;
  }

  // ---------- 女巫：解药 / 毒药 / 空过 ----------
  if (p.task === 'witch') {
    const ex = p.extra || {};
    if (ex.canAntidote) {
      keys.appendChild(keyEl(icoLabel('antidote', `解药救 ${ex.killTarget} 号`), 'on', () => simple({ antidote: true, poison: 0 })));
    } else {
      keys.appendChild(keyEl(icoLabel('antidote', '解药不可用'), 'off', null, { sub: ex.antidoteUsed ? '已用过' : '今夜无人被刀' }));
    }
    const poisonKey = keyEl(icoLabel('poison', '用毒'), 'off', () => simple({ antidote: false, poison: Number(actionState.target) || 0 }), { confirm: true }); // FIX-15：null→0，与改动前一致
    if (ex.canPoison) {
      actionState.needTarget = true;
      markNeedTarget(v, v.players.filter((x) => x.alive).map((x) => x.seat), '到「玩家」页点选要毒的人（可毒自己）');
      keys.appendChild(poisonKey);
    } else {
      keys.appendChild(keyEl(icoLabel('poison', '毒药不可用'), 'off', null, { sub: ex.poisonUsed ? '已用过' : ' ' }));
    }
    keys.appendChild(keyEl('空过', 'alt', () => simple({ antidote: false, poison: 0 })));
    return;
  }

  // ---------- 二选一：上警 / 方向 ----------
  if (p.task === 'sheriff_run') {
    keys.append(
      keyEl(icoLabel('sheriff', '上警'), 'on', () => simple({ run: true })),
      keyEl('不上警', 'alt', () => simple({ run: false }))
    );
    return;
  }
  if (p.task === 'direction') {
    keys.append(
      keyEl('顺时针 →', 'on', () => simple({ direction: 'cw' })),
      keyEl('逆时针 ←', 'alt', () => simple({ direction: 'ccw' }))
    );
    return;
  }

  keys.appendChild(el('span', 'hint', `未知任务：${p.task}`));
}

/** 标记"本次需要点座位选目标"：让玩家页座位卡进入可选状态，并在对话框里给出说明与显式入口
 *  （FIN-06 §10.4：非法目标禁用并说明；§10.7：切页签不靠长按——去玩家页选人有可见入口） */
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
    const go = el('button', 'btn small m-goto-players', icoLabel('players', '去玩家页选人'));
    go.type = 'button';
    go.addEventListener('click', () => setGameTab('players'));
    t.appendChild(go);
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
function openInspect(rid, replace) {
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
  // 点击关闭也走返回栈：返回键与点击行为一致（关检视 ≠ 退局）
  stage.addEventListener('click', () => {
    const top = backStack[backStack.length - 1];
    if (top && top.kind === 'inspect') dismissTop();
    else { stage.remove(); syncLayerScrollLock(); }
  });
  document.body.appendChild(stage);
  if (replace) overlayReplaceNext = true; // 从齿轮/设置里进来：替换那一层，返回深度不加深
  trackOverlay('inspect', () => stage.remove());
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
  const wasOpen = !$('#m-flip').classList.contains('hidden');
  $('#m-flip').classList.remove('hidden');
  $('#m-flip-card').classList.remove('flipped');
  trackOverlay('flip', hideFlipDom, { swapIfOpen: wasOpen }); // 翻牌也在返回栈里：返回先收翻牌
}
/**
 * 规则书：内容与渲染器都在 web/rulebook.js（桌面端同一份）。
 * 这里只加"本局实际开关"一节 —— 玩家最关心的"我这局和默认有什么不同"。
 */
function openRulebook() {
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('rulebook')} 规则书</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', closeModalTop);
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

/**
 * 导航/操作图标（计划书 §3 第 78 行）的注入点，与桌面 app.js 同一套两步走：
 *   ① 立刻注入 shared 的 `<symbol>` 定义（之后 JS 拼的按钮直接 `<use>` 引用）；
 *   ② 等 `DOMContentLoaded` 再画 `[data-ww-icon]` —— **必须晚于 i18n.js 的挂载**
 *      （i18n.js 先加载、先注册），否则 applyI18n 会把徽记连同 textContent 一起抹掉。
 *      切语言时同理（见 toggleLang）。
 */
window.WWIcons.ensureDefs(document);
function mountNavIcons() { window.WWIcons.mount(document); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountNavIcons);
else mountNavIcons();

init().catch((e) => { document.body.innerHTML = `<div style="padding:40px;color:#e89ba4">初始化失败：${escapeHtml(e.message)}</div>`; });

/**
 * R04（审核 P2）：把一局历史**按服务端游标分页读完**（手机端；与桌面端同源实现）。
 * 追加在文件末尾，是为了不动 m.js 那条行号钉点（emoji-preserve 的 1788±25）—— 判据一字未改。
 * 续读用 nextAfter、以 seq 去重、迟到响应丢弃、失败不清空已读内容，逐条对应 §R04。
 */
async function historyPager({ pid, gameId, listBox, moreBox, mkRow }) {
  const PAGE = 100;
  const seen = new Set();
  let cursor = 0;   // 下一页的 after（取自服务端 nextAfter）
  let loaded = 0;   // 已渲染条数（去重后）
  let gen = 0;      // 世代号：只有最新一次请求有权改页面
  const stale = (my) => my !== gen || state.profileId !== pid;
  const setMore = (hasMore, remaining, err) => {
    moreBox.textContent = '';
    if (err) moreBox.appendChild(elText('p', 'hint', `加载更多失败：${err}（已读内容保留，可直接重试）`));
    if (hasMore || err) {
      const b = el('button', 'btn ghost', err ? '重试' : `加载更多（已读 ${loaded} 条，还有 ${remaining} 条）`);
      b.id = 'm-pc-history-more';
      b.addEventListener('click', () => { b.disabled = true; void page(); });
      moreBox.appendChild(b);
    } else if (loaded) {
      moreBox.appendChild(elText('p', 'hint', `已到末尾（共 ${loaded} 条公开事件）。`));
    }
  };
  const page = async (first) => {
    const my = ++gen;
    const url = `/api/profiles/${pid}/games/${encodeURIComponent(gameId)}/history?limit=${PAGE}${cursor ? `&after=${cursor}` : ''}`;
    try {
      const r = await api('GET', url);
      if (stale(my)) return; // 档案已切走 / 已发起新一轮：这份响应作废，绝不动页面
      if (first) listBox.textContent = '';
      for (const e of (r.rows || [])) {
        const seq = Number(e.seq);
        if (!Number.isFinite(seq) || seen.has(seq)) continue; // 以 seq 去重
        seen.add(seq); loaded++;
        listBox.appendChild(mkRow(e));
      }
      if (Number.isFinite(Number(r.nextAfter))) cursor = Number(r.nextAfter);
      if (first && !loaded) listBox.appendChild(el('p', 'hint', '这条历史里没有可展示的公开事件。'));
      // 服务端 total = 该游标之后的**全部**公开事件数（含本页）⇒ 真正"还没读到"的要减掉本页条数，
      // 否则按钮上"已读 N 条，还有 M 条"会自相矛盾（N+M 大于总数）。
      setMore(!!r.hasMore, Math.max(0, (Number(r.total) || 0) - (r.rows || []).length), null);
    } catch (e) {
      if (stale(my)) return;
      if (first) {
        listBox.textContent = '';
        listBox.appendChild(el('p', 'hint', `历史加载失败：${e.message}`));
      }
      setMore(true, 0, e.message); // 失败：已读内容保留，按钮变「重试」
    }
  };
  await page(true);
}
