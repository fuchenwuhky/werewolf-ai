/**
 * app.js — AI 狼人杀前端（原生 JS，无依赖）
 */
'use strict';

// ---------------- 全局状态 ----------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };
// 整改（计划 §2.1 / 审核 P1-5）：不可信内容（模型输出、昵称、服务端消息）专用 —— 永远 textContent
const elText = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = String(text); return d; };

/**
 * 推送看门狗阈值：服务端心跳约 16s（src/api.js 的 STREAM_TICK_MS × STREAM_PING_TICKS），
 * 这里取 36s = 2 个心跳周期 + 余量，容忍丢一次心跳。绝不能小于心跳周期，否则正常空闲会误杀连接。
 */
const STREAM_DEAD_MS = 36000;

const state = {
  meta: null,            // {roles, boards, ruleMeta, defaultRules}
  setup: { boardCounts: null, boardId: 'adv12', rules: null, mode: 'play', mySeat: 'random' },
  game: null,            // {gameId, playerToken, godToken, mock}
  view: null,            // 最近一次 view 响应
  afterSeq: 0,
  pollTimer: null,
  // SSE 推送（P2-2）：两条流 + 各自最近一帧 + 看门狗时间戳
  stream: null, godStream: null, streamWatchdog: null, lastStreamAt: 0,
  playerView: null, godView: null,
  coachSig: null, // 教练面板的重绘签名（内容没变就不重建 DOM）
  ready: false,   // 初始化（拉取 meta/config 并绑定事件）是否完成：没完成时点击要明说，不能毫无反应
  godMode: false,
  godLogAfter: 0,
  roleShown: false,
  seatNames: {},
  tags: {},              // 身份标记（仅玩家自己的笔记）：{seat: roleId}（旧格式，仅迁移期兼容读取）
  profileId: null,       // 当前选中的玩家档案 UUID（PROF-01）；null = 尚未加载完成
  profiles: [],          // GET /api/profiles 缓存（含已归档）
  anno: { rev: 0, seats: {}, loaded: false, gameId: null }, // 本局私人标注（NOTE-02/03）：{seat: V2标注}
  lastView: null,        // 最近一次玩家视图：圆桌要从"选目标"里重绘，必须留一份
  voteTally: {},         // 最近一次亮票的票数（画在圆桌圆心与座位角标上），阶段切换即清空
};

const PHASE_LABEL = { setup: '开局', night: '夜晚', dawn: '天亮', sheriff: '警长竞选', speech: '白天发言', vote: '放逐投票', pk: 'PK 环节', over: '结算' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.auth === 'pairing') showPairingGate(); // LAN 模式未配对（SEC-01）
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status; // 409 并发冲突等按状态码精确判定（错误文案不可靠）
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

// ---------------- 设置页 ----------------
async function initSetup() {
  state.meta = await api('GET', '/api/meta');
  const cfg = await api('GET', '/api/config');
  state.cfg = cfg; // 供输入时的通道数预览使用（与磁盘一致的最近一次读数）
  $('#cfg-baseurl').value = cfg.baseUrl || '';
  $('#cfg-model').value = cfg.model || '';
  $('#cfg-modelfast').value = cfg.modelFast || '';
  $('#cfg-temp').value = cfg.temperature;
  $('#cfg-maxtokens').value = cfg.maxTokens;
  $('#cfg-effort').value = cfg.reasoningEffort || 'medium';
  $('#cfg-fasteffort').value = cfg.fastEffort || 'low';
  $('#cfg-budget').value = cfg.contextBudget || 12000;
  $('#cfg-cachecontrol').checked = !!cfg.cacheControl;
  $('#cfg-keepalive').checked = cfg.keepAlive !== false; // 默认开
  renderPaceSelect(cfg.pace);
  if (cfg.hasKey) $('#cfg-key').placeholder = `已保存（${cfg.apiKeyMasked}），留空则不修改`;
  renderKeyChannels(cfg);

  // LAN 模式下，本机设置页展示当前配对码（整改 SEC-01：手机等设备要用它配对）
  api('GET', '/api/auth/pairing').then((p) => {
    if (!p || !p.needed || !p.code) return;
    const card = document.querySelector('#cfg-key') && document.querySelector('#cfg-key').closest('div');
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.style.color = '#e8c56a';
    tip.textContent = `🌐 局域网配对码：${p.code}（${Math.ceil((p.expiresInMs || 0) / 1000)}s 内有效；手机打开本页会要求输入它）`;
    if (card && card.parentElement) card.parentElement.insertBefore(tip, card.nextSibling);
    else document.body.insertBefore(tip, document.body.firstChild);
  }).catch(() => {});

  state.setup.rules = JSON.parse(JSON.stringify(state.meta.defaultRules));
  state.setup.mySeat = savedSeatChoice(); // 恢复上次的座位偏好（含 'random'），默认随机
  applyBoardTemplate('adv12');
  renderBoardTemplateSelect();
  renderBoardEditor();
  renderRulesEditor();
  renderSeatsSelect();
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
    state.setup.mode = document.querySelector('input[name=mode]:checked').value;
    $('#play-options').classList.toggle('hidden', state.setup.mode !== 'play');
    renderAiNames(true); renderPersonas();
    renderSetupDigest();
  }));
  $('#my-seat').addEventListener('change', () => {
    state.setup.mySeat = $('#my-seat').value;
    persistSeatChoice(state.setup.mySeat);
    renderAiNames(true); renderPersonas();
  });
  // 模型 / Mock / 节奏 任一变化都要刷新顶部的"这一局是什么"信息条（它存在的意义就是给人做最后确认）
  ['#cfg-model', '#use-mock', '#cfg-pace'].forEach((sel) => {
    const node = $(sel);
    if (!node) return;
    node.addEventListener('change', renderSetupDigest);
    if (node.tagName === 'INPUT') node.addEventListener('input', renderSetupDigest);
  });
  renderSetupDigest();
  $('#btn-rand-names').addEventListener('click', () => { renderAiNames(true); renderPersonas(); });
  // 角色图鉴：这一屏的渲染在 web/codex.js（桌面与手机同一份），这里只接开关与返回。
  // 搜索框、筛选项、牌面点击、细节栏里的检视/规则书按钮，都由 Codex.mount() 自己接线。
  const codexBtn = $('#btn-codex');
  if (codexBtn) codexBtn.addEventListener('click', openCodex);
  const codexBack = $('#btn-codex-back');
  if (codexBack) codexBack.addEventListener('click', closeCodex);
  $('#btn-discard').addEventListener('click', () => {
    if (confirm('确定放弃当前进行中的对局？该对局将无法继续。')) {
      localStorage.removeItem('ww_current');
      localStorage.removeItem('ww_resumable');
      $('#resume-box').classList.add('hidden');
    }
  });
  renderAiNames(true);
  renderPersonas(false);

  $('#btn-save-config').addEventListener('click', saveConfig);
  $('#btn-test-config').addEventListener('click', testConfig);
  // 清空额外 Key 必须是显式动作：输入框留空的语义是"不修改"（否则改个温度就把多 Key 清空了）
  const clearKeys = $('#btn-clear-keys');
  if (clearKeys) clearKeys.addEventListener('click', async () => {
    if (!confirm('确定清空所有额外 API Key？清空后会退回单通道（这些 Key 不会出现在任何日志里）。')) return;
    try {
      const r = await api('PUT', '/api/config', { apiKeys: [] });
      $('#cfg-test-result').textContent = `✓ 已清空额外 Key（当前 ${r.channels || 1} 条并发通道）`;
      const after = await api('GET', '/api/config').catch(() => null);
      if (after) { state.cfg = after; renderKeyChannels(after); }
    } catch (e) { $('#cfg-test-result').textContent = `✗ ${e.message}`; }
  });
  const keysBox = $('#cfg-keys');
  if (keysBox) keysBox.addEventListener('input', () => renderKeyChannels(state.cfg || {}));
  // 主动探测每把 Key 的实际并发额度（会花几次极短请求，所以必须是用户点出来的）
  const probeBtn = $('#btn-probe');
  if (probeBtn) probeBtn.addEventListener('click', probeChannels);
  $('#btn-god-close').addEventListener('click', toggleGod);
  $('#board-template').addEventListener('change', (e) => {
    state.setup.boardId = e.target.value;
    if (e.target.value !== 'custom') { applyBoardTemplate(e.target.value); renderBoardEditor(); renderRulesEditor(); }
  });
  $('#btn-start').addEventListener('click', startGame);
  // 玩家档案（PROF-01）：加载列表 + 绑定选择/管理入口；失败不阻塞开局（服务端会归默认档案）
  $('#profile-select').addEventListener('change', (e) => onSelectProfile(e.target.value));
  $('#btn-profile-manage').addEventListener('click', openProfileManager);
  // 用户手改过昵称后就不再用档案昵称覆盖
  $('#my-name').addEventListener('input', () => { $('#my-name').dataset.touched = '1'; });
  loadProfiles();
  $('#btn-resume').addEventListener('click', () => {
    if (localStorage.getItem('ww_resumable')) resumeFromAnchor();
    else resumeGame();
  });
  await checkResume();
  // 到这里才有 meta/config、事件也才绑上。此前点击按钮什么都不会发生 ——
  // 冷启动较慢时用户会以为"点了没反应"。所以：开始按钮在 HTML 里就是 disabled，
  // 这里显式启用；整个加载窗口内的拦截由 index.html 最先执行的那段守卫负责（见 index.html 顶部）。
  const startBtn = $('#btn-start');
  if (startBtn) startBtn.disabled = false;
  // 顺手擦掉守卫写下的"正在加载配置"：按钮已经可用了，这行字留着会自相矛盾（截图里就挂着过）
  const errBox = $('#setup-error');
  if (errBox && /正在加载配置/.test(errBox.textContent || '')) errBox.textContent = '';
  state.ready = true;
  window.__wwReady = true; // 告诉顶部守卫可以放行了
}

function applyBoardTemplate(id) {
  const tpl = state.meta.boards[id];
  state.setup.boardCounts = { ...tpl.roles };
  // 板子内置板规（如狼美人局女巫不可自救）预填进规则表单，仍可手动调整
  if (tpl.rules && state.setup.rules) Object.assign(state.setup.rules, JSON.parse(JSON.stringify(tpl.rules)));
  state.setup.boardId = id;
}

function renderBoardTemplateSelect() {
  const sel = $('#board-template');
  sel.innerHTML = '';
  for (const b of Object.values(state.meta.boards)) {
    sel.appendChild(el('option', null, b.name)).value = b.id;
  }
  sel.appendChild(el('option', null, '自定义')).value = 'custom';
  sel.value = state.setup.boardId;
}

function renderBoardEditor() {
  const box = $('#board-editor');
  box.innerHTML = '';
  const roles = state.meta.roles;
  for (const [rid, meta] of Object.entries(roles)) {
    const row = el('div', 'role-row');
    row.appendChild(el('span', 'rname', `${meta.emoji} ${meta.name}`));
    const cnt = el('span', 'cnt');
    const minus = el('button', null, '−');
    const num = el('b', null, String(state.setup.boardCounts[rid] || 0));
    const plus = el('button', null, '+');
    minus.addEventListener('click', () => { state.setup.boardCounts[rid] = Math.max(0, (state.setup.boardCounts[rid] || 0) - 1); num.textContent = state.setup.boardCounts[rid]; updateBoardTotal(); if (state.setup.boardId !== 'custom') { state.setup.boardId = 'custom'; $('#board-template').value = 'custom'; } });
    plus.addEventListener('click', () => { state.setup.boardCounts[rid] = (state.setup.boardCounts[rid] || 0) + 1; num.textContent = state.setup.boardCounts[rid]; updateBoardTotal(); if (state.setup.boardId !== 'custom') { state.setup.boardId = 'custom'; $('#board-template').value = 'custom'; } });
    cnt.append(minus, num, plus);
    row.appendChild(cnt);
    box.appendChild(row);
  }
  updateBoardTotal();
  renderSeatsSelect();
}

function boardTotal() { return Object.values(state.setup.boardCounts).reduce((a, b) => a + (b || 0), 0); }

function updateBoardTotal() {
  const total = boardTotal();
  const wolves = Object.entries(state.setup.boardCounts).filter(([r]) => state.meta.roles[r].team === 'wolf').reduce((a, [, n]) => a + n, 0);
  const msgs = [];
  if (total < 4) msgs.push('总人数至少 4');
  if (wolves < 1) msgs.push('至少 1 狼');
  if (wolves >= total - wolves) msgs.push('狼不能多于好人');
  $('#board-total').textContent = `总人数：${total}（狼 ${wolves} / 好 ${total - wolves}）${msgs.length ? ' ⚠️ ' + msgs.join('；') : ' ✓'}`;
  renderSeatsSelect();
  renderAiNames(false);
  renderSetupDigest();
}

/**
 * 设置页顶部的"这一局是什么"信息条 + 底部操作条上的摘要。
 *
 * 为什么值得做：这张设置页有 4 张卡、几十个控件，"我到底要开一局什么"这件事在按下开始之前
 * 完全看不出来。把 板子 / 人数 / 阵营配比 / 模式 / 模型 / 节奏 收成一行，读一眼就能确认，
 * 也顺便让"改完忘记保存"这类问题暴露得更早（模型来自服务端返回的已保存配置）。
 */
function renderSetupDigest() {
  // 本页新增的文案全部走 i18n：写死中文会让"英文模式"里突然冒出一条中文（本轮就漏过一次）。
  // 板子名/节奏名来自服务端 meta（引擎数据，按既定范围不翻译），只翻译包着它们的标签。
  const T = (k, v) => ((typeof I18N !== 'undefined' && I18N.t && I18N.t(k, v)) || k);
  const boardSel = $('#board-template');
  const boardName = boardSel && boardSel.selectedOptions[0] ? boardSel.selectedOptions[0].textContent : '';
  const total = boardTotal();
  const wolves = Object.entries(state.setup.boardCounts || {}).filter(([r]) => state.meta && state.meta.roles[r] && state.meta.roles[r].team === 'wolf').reduce((a, [, n]) => a + n, 0);
  const mode = document.querySelector('input[name=mode]:checked');
  const isWatch = mode && mode.value === 'watch';
  const model = ($('#cfg-model') && $('#cfg-model').value.trim()) || T('digest.noModel');
  const paceSel = $('#cfg-pace');
  const pace = paceSel && paceSel.selectedOptions[0] ? paceSel.selectedOptions[0].textContent : '';
  const paceTxt = pace ? pace.replace(/（.*$/, '') : '';
  const mock = $('#use-mock') && $('#use-mock').checked;
    // 整改：开头的「12人」剥干净（人数已单列「12 人局」），否则留下孤字「人」读不通。
  const cleanBoard = escapeHtml(String(boardName || T('digest.unknownBoard'))
    .replace(/^[0-9]+\s*人*/, '')
    .replace(/^[\s·—\-]+/, '')
    .slice(0, 16));
  const facts = [
    `<li>${T('digest.board')} <b>${cleanBoard}</b></li>`,
    `<li><b>${T('digest.players', { n: total })}</b> · ${T('digest.wolves', { w: wolves })} / ${T('digest.good', { g: total - wolves })}</li>`,
    `<li>${isWatch ? T('digest.watch') : T('digest.play')}</li>`,
    mock ? `<li>${T('digest.mock')}</li>` : `<li>${T('digest.model', { m: escapeHtml(model.replace(/^.*\//, '')) })}</li>`,
  ];
  if (paceTxt) facts.push(`<li>${T('digest.pace', { p: escapeHtml(paceTxt) })}</li>`);
  const box = $('#hero-facts');
  if (box) box.innerHTML = facts.join('');
  const sum = $('#setup-summary');
  if (sum) {
    sum.innerHTML = `${isWatch ? T('digest.watch') : T('digest.play')} · ${T('digest.players', { n: total })} · ${T('digest.wolves', { w: wolves })}/${T('digest.good', { g: total - wolves })}`
      + `<span class="ss-sep">|</span>${cleanBoard}`
      + (mock ? `<span class="ss-sep">|</span>${T('digest.mock')}` : `<span class="ss-sep">|</span>${escapeHtml(model)}`)
      + (paceTxt ? `<span class="ss-sep">|</span>${escapeHtml(paceTxt)}` : '');
  }
}

/**
 * 我的座位下拉：**默认"🎲 随机"**，也可以明确指定某一号。
 *
 * 为什么默认随机：老是坐 1 号会很难受 —— 发言顺序固定、首夜被刀/被查的概率体感失衡，
 * 而且 1 号在很多板子里是"第一个发言"的固定角色。随机之后每局的位置都不一样。
 *
 * "随机"的取值是字符串 'random'，由**服务端**抽签（见 api.js createGame）：手机端/桌面端/直连 API
 * 三条路径行为一致，且显式 seed 时座位也能一起复现。这里只负责把选择记下来。
 */
function renderSeatsSelect() {
  const sel = $('#my-seat');
  const total = boardTotal();
  const cur = sel.value || state.setup.mySeat; // 'random' 或数字
  sel.innerHTML = '';
  sel.appendChild(el('option', null, '🎲 随机（推荐）')).value = 'random';
  for (let i = 1; i <= total; i++) sel.appendChild(el('option', null, `${i} 号座位`)).value = i;
  const wanted = String(cur);
  sel.value = [...sel.options].some((o) => o.value === wanted) ? wanted : 'random';
  state.setup.mySeat = sel.value;
  // 选"随机"时要说明座位号开局才定 —— 否则用户会奇怪"我给某座位填的昵称怎么不见了"
  const hint = $('#seat-hint');
  if (hint) {
    hint.textContent = sel.value === 'random'
      ? tr('players.seatRandomHint', '🎲 座位开局时随机分配（每局都不一样）。下面每个座位的昵称/人格都会保留，抽到你的那个座位会换成你的昵称。')
      : '';
  }
}

/** 取词：有 i18n.js 就用它，否则退回中文原文案 */
function tr(key, zh) {
  const fn = window.I18N && window.I18N.t;
  const v = fn ? fn(key) : null;
  return v == null ? zh : v;
}

function renderRulesEditor() {
  const box = $('#rules-editor');
  box.innerHTML = '';
  for (const m of state.meta.ruleMeta) {
    const item = el('div', 'rule-item');
    item.appendChild(el('span', 'rlabel', `<b>${m.label}</b> <span class="hint">${m.desc || ''}</span>`));
    if (m.type === 'bool') {
      const path = m.path || m.key;
      const cb = el('input'); cb.type = 'checkbox';
      cb.checked = getPath(state.setup.rules, path);
      cb.addEventListener('change', () => setPath(state.setup.rules, path, cb.checked));
      item.appendChild(cb);
    } else if (m.type === 'enum') {
      const sel = el('select');
      for (const o of m.options) sel.appendChild(el('option', null, o.label)).value = o.value;
      sel.value = String(getPath(state.setup.rules, m.key));
      sel.addEventListener('change', () => {
        const v = m.parse ? m.parse(sel.value) : sel.value;
        setPath(state.setup.rules, m.key, v);
      });
      item.appendChild(sel);
    } else if (m.type === 'nightOrder') {
      const wrap = el('div', 'rule-order');
      const labels = { admirer: '暗恋者', guard: '守卫', dreamer: '摄梦人', wolf: '狼人', wolfbeauty: '狼美人', seer: '预言家', witch: '女巫', crow: '乌鸦' };
      const render = () => {
        wrap.innerHTML = '';
        state.setup.rules.nightOrder.forEach((step, i) => {
          const rowEl = el('div', 'ord');
          rowEl.appendChild(el('span', null, `${i + 1}. ${labels[step] || step}`));
          const up = el('button', 'btn small ghost', '↑');
          const down = el('button', 'btn small ghost', '↓');
          up.disabled = i === 0; down.disabled = i === state.setup.rules.nightOrder.length - 1;
          up.addEventListener('click', () => { const a = state.setup.rules.nightOrder; [a[i - 1], a[i]] = [a[i], a[i - 1]]; render(); });
          down.addEventListener('click', () => { const a = state.setup.rules.nightOrder; [a[i + 1], a[i]] = [a[i], a[i + 1]]; render(); });
          rowEl.append(up, down);
          wrap.appendChild(rowEl);
        });
      };
      render();
      /* 夜晚行动顺序：8 行编辑器，占 ~390px，把规则卡撑得很高（设置页 2×2 布局里右下会空出一大块）。
         收进默认折叠的 details：改它的人本来就少，展开后仍占整行宽度。 */
      const det = el('details', 'rule-order-details');
      det.innerHTML = `<summary class="rlabel"><b>${tr('rules.nightOrder', '夜晚行动顺序')}</b><span class="hint">${tr('rules.nightOrderHint', '（默认按官方流程，通常不用改；展开可调整先后）')}</span></summary>`;
      det.appendChild(wrap);
      item.innerHTML = '';
      item.appendChild(det);
      item.style.gridColumn = '1 / -1'; // 跨两列，别把顺序列表挤进右侧窄列
    }
    box.appendChild(item);
  }
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }
function setPath(obj, path, val) { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((o, k) => o[k], obj); t[last] = val; }

/** 可能会是 AI 的座位。选"随机"时座位尚未确定，所以全部座位都要能填昵称/人格。 */
function aiSeats() {
  const total = boardTotal();
  const sel = $('#my-seat');
  const raw = state.setup.mode === 'play' ? String(sel.value || state.setup.mySeat) : '';
  const mySeat = raw === 'random' ? 0 : Number(raw || 0);
  const seats = [];
  for (let i = 1; i <= total; i++) if (i !== mySeat) seats.push(i);
  return seats;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderAiNames(random) {
  const box = $('#ai-names');
  const existing = {};
  box.querySelectorAll('input').forEach((i) => { existing[i.dataset.seat] = i.value; });
  box.innerHTML = '';
  const pool = shuffle(state.meta.names || []);
  let pi = 0;
  for (const seat of aiSeats()) {
    const input = el('input');
    input.dataset.seat = seat;
    input.maxLength = 12;
    const cur = existing[seat];
    const isDefault = cur == null || cur === '' || cur === `${seat}号`;
    input.value = !isDefault ? cur : (random ? pool[pi++ % pool.length] : `${seat}号`);
    box.appendChild(input);
  }
}

function renderPersonas() {
  const box = $('#ai-personas');
  const existing = {};
  box.querySelectorAll('input').forEach((i) => { existing[i.dataset.seat] = i.value; });
  box.innerHTML = '';
  for (const seat of aiSeats()) {
    const input = el('input');
    input.dataset.seat = seat;
    input.setAttribute('list', 'persona-list');
    input.placeholder = `留空＝名册默认／随机性格（也可选择或自定义）`;
    input.maxLength = 60;
    if (existing[seat]) input.value = existing[seat];
    box.appendChild(input);
  }
  // 性格下拉选项（允许自由输入自定义文本）
  let dl = $('#persona-list');
  if (!dl) {
    dl = el('datalist');
    dl.id = 'persona-list';
    document.body.appendChild(dl);
  }
  dl.innerHTML = (state.meta.personas || []).map((p) => `<option value="${p.name}">${p.tag}</option>`).join('');
}

/**
 * 节奏档位（P2-6）：把"这一局要快 / 要标准 / 要深"做成一个选择器，
 * 而不是把 effortPolicy / digestMinEvents / digestKeep / contextBudget 四个内部参数摆给用户。
 *
 * 两条刻意的设计：
 *  ① 选中档位时**同步把可见的输入框填成该档的值**（思考强度/上下文预算），用户看得见改了什么；
 *     隐藏的两个参数（反思阈值、纪要保留数）在下面用文字如实说明，不做黑箱。
 *  ② 当前参数与任何档位都不完全一致时，显示"自定义"而不是硬贴一个档位名 —— 设置项谎报状态
 *     是 keepAlive 复选框那次的教训，这里不再犯。
 */
function renderPaceSelect(currentPace) {
  const sel = $('#cfg-pace');
  if (!sel) return;
  const paces = (state.meta && state.meta.paces) || [];
  const options = paces.map((p) => `<option value="${p.id}">${p.label}</option>`);
  options.push('<option value="custom">自定义（当前参数与任何档位都不完全一致）</option>');
  sel.innerHTML = options.join('');
  sel.value = paces.some((p) => p.id === currentPace) ? currentPace : 'custom';
  sel.addEventListener('change', () => applyPaceToForm(sel.value));
  renderPaceHint(sel.value);
}

/** 把档位值填进可见输入框（这样用户能看见"这一档到底改了什么"） */
function applyPaceToForm(paceId) {
  const p = ((state.meta && state.meta.paces) || []).find((x) => x.id === paceId);
  if (p) {
    const v = p.values;
    if (v.reasoningEffort) $('#cfg-effort').value = v.reasoningEffort;
    if (v.fastEffort) $('#cfg-fasteffort').value = v.fastEffort;
    if (v.contextBudget) $('#cfg-budget').value = v.contextBudget;
  }
  renderPaceHint(paceId);
}

function renderPaceHint(paceId) {
  const box = $('#cfg-pace-hint');
  if (!box) return;
  const p = ((state.meta && state.meta.paces) || []).find((x) => x.id === paceId);
  if (!p) {
    box.textContent = '当前参数与任何档位都不完全一致（例如你手工调过其中某一项）。再选一个档位并保存，即可回到该档的完整参数。';
    return;
  }
  const v = p.values;
  box.textContent = `${p.desc}（本档同时设定：反思阈值 ${v.digestMinEvents} 条、纪要保留 ${v.digestKeep} 条、思考调度 ${v.effortPolicy === 'flat' ? '按任务名一刀切' : '按信息含量'}）`;
}

async function saveConfig() {
  const pace = $('#cfg-pace') ? $('#cfg-pace').value : '';
  const body = {
    baseUrl: $('#cfg-baseurl').value.trim(),
    model: $('#cfg-model').value.trim(),
    modelFast: $('#cfg-modelfast').value.trim(),
    temperature: Number($('#cfg-temp').value),
    maxTokens: Number($('#cfg-maxtokens').value),
    reasoningEffort: $('#cfg-effort').value,
    fastEffort: $('#cfg-fasteffort').value,
    contextBudget: Number($('#cfg-budget').value),
    cacheControl: $('#cfg-cachecontrol').checked,
    keepAlive: $('#cfg-keepalive').checked,
  };
  // 档位只在选中具体档时提交；'custom' 表示用户要保留自己调出来的参数，不发 pace（服务端就不会展开档位）
  if (pace && pace !== 'custom') body.pace = pace;
  const key = $('#cfg-key').value.trim();
  if (key) body.apiKey = key;
  // 额外 Key：留空 = 不修改（与服务端 apiKey 同一约定），避免"改个温度就把多 Key 清空"。
  // 想清空请用旁边的「清空额外 Key」按钮 —— 显式操作，不靠猜。
  const extra = ($('#cfg-keys').value || '').split(/[\s,;、]+/).map((s) => s.trim()).filter(Boolean);
  if (extra.length) body.apiKeys = extra;
  try {
    const r = await api('PUT', '/api/config', body);
    $('#cfg-key').value = '';
    $('#cfg-keys').value = '';
    $('#cfg-key').placeholder = `已保存（${r.apiKeyMasked}），留空则不修改`;
    $('#cfg-test-result').textContent = `✓ 已保存（${r.channels || 1} 条并发通道）`;
    // 保存后按服务端反查结果回显档位：不以客户端的想法为准，避免"界面显示 A、磁盘是 B"
    const after = await api('GET', '/api/config').catch(() => null);
    if (after) { state.cfg = after; renderPaceSelect(after.pace); renderKeyChannels(after); }
  } catch (e) { $('#cfg-test-result').textContent = `✗ ${e.message}`; }
}

/**
 * 并发通道提示：既报"池里有几把 Key"，也报**调度器实时允许几条泳道**。
 *
 * 为什么要显示实时值：每把 Key 实际允许几并发只有服务商知道，调度器会按实测反馈
 * 自己加减（撞限流砍半、忙时有排队就加档），设置页那个按钮则是主动探一次。
 * 所以"当前 N 条"必须来自调度器（cfg.pool），不能拿 Key 数反推 —— 否则用户改了配置
 * 却发现并发没变，或者自适应已经涨上去了却仍显示 1，都会让人以为功能没生效。
 */
function renderKeyChannels(cfg) {
  const box = $('#cfg-keys');
  const hint = $('#cfg-channels');
  if (!box || !hint) return;
  const extra = (cfg && cfg.extraKeys) || 0;
  const pool = (cfg && cfg.pool) || null;
  const keys = (pool && pool.keys) || extra + 1;
  const live = (pool && pool.channels) || (cfg && cfg.channels) || 1;
  const limits = pool && pool.slots ? pool.slots.map((s) => s.limit) : null;
  box.placeholder = extra > 0
    ? `已保存 ${extra} 把额外 Key（留空则不修改）`
    : 'sk-...（可选：一行一个，或用逗号分隔）';
  const local = box.value.split(/[\s,;、]+/).filter((s) => s.trim()).length;
  const afterKeys = local ? local + 1 : keys;
  const parts = [];
  if (local) parts.push(`保存后共 ${afterKeys} 把 Key`);
  else parts.push(`${keys} 把 Key`);
  parts.push(`当前并发容量 ${live} 条${limits && limits.length > 1 ? `（每把 ${limits.join('/')} 条）` : ''}`);
  let detail = '';
  if (pool && pool.adaptive) {
    detail = pool.ramps > 0
      ? `已按实测自动加档 ${pool.ramps} 次${pool.rateLimited ? `、撞限流回退 ${pool.rateLimited} 次` : ''}。`
      : '自适应已开：忙时有排队就加档、撞限流就回退，无需手动调。';
  } else if (pool) {
    detail = '自适应已关：并发固定为上面的值。';
  }
  hint.textContent = `${parts.join('；')}。${detail}并发不是线性提速 —— 发言必须按顺序听，实测上限约 -23%，不是减半。`;
}

/** 主动探测每把 Key 的实际并发额度，并直接写进运行中的调度器 */
async function probeChannels() {
  const btn = $('#btn-probe');
  const hint = $('#cfg-channels');
  if (btn) { btn.disabled = true; btn.textContent = '探测中…'; }
  const was = hint ? hint.textContent : '';
  if (hint) hint.textContent = '正在逐档试并发（每档几个极短请求）…';
  try {
    const r = await api('POST', '/api/config/probe', { max: 4 });
    const lines = (r.results || []).map((x) => `Key${x.index + 1} → ${x.limit} 并发`).join('，');
    if (state.cfg) state.cfg.pool = r.pool;
    renderKeyChannels(state.cfg || {});
    if (hint) hint.textContent = `✓ 探测完成：${lines}；当前容量 ${r.pool ? r.pool.channels : '?'} 条。${hint.textContent}`;
  } catch (e) {
    if (hint) hint.textContent = `✗ 探测失败：${e.message}`;
    else if (was) hint.textContent = was;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '探测并发额度'; }
  }
}

async function testConfig() {
  const key = $('#cfg-key').value.trim();
  if (key) await saveConfig();
  $('#cfg-test-result').textContent = '测试中…';
  try {
    const r = await api('POST', '/api/config/test');
    $('#cfg-test-result').textContent = r.ok ? `✓ 连接成功（${r.latencyMs}ms）` : `✗ ${r.error}`;
  } catch (e) { $('#cfg-test-result').textContent = `✗ ${e.message}`; }
}

async function startGame() {
  $('#setup-error').textContent = '';
  try {
    const total = boardTotal();
    // 座位：'random'（默认，由服务端抽签）或明确的号数；纯观战没有人类座位
    const seatChoice = state.setup.mode === 'play' ? String($('#my-seat').value || 'random') : '0';
    const randomSeat = seatChoice === 'random';
    const mySeat = randomSeat ? 0 : Number(seatChoice);
    const humanName = $('#my-name').value.trim() || '我';
    const nameInputs = [...document.querySelectorAll('#ai-names input')];
    const personaInputs = [...document.querySelectorAll('#ai-personas input')];
    const players = [];
    for (let i = 1; i <= total; i++) {
      if (i === mySeat) {
        players.push({ name: humanName, isHuman: true, personality: '' });
      } else {
        const ni = nameInputs.find((x) => Number(x.dataset.seat) === i);
        const pi = personaInputs.find((x) => Number(x.dataset.seat) === i);
        players.push({ name: (ni && ni.value.trim()) || `${i}号`, isHuman: false, personality: (pi && pi.value.trim()) || '' });
      }
    }
    const useMock = $('#use-mock').checked;
    const body = {
      boardId: state.setup.boardId !== 'custom' ? state.setup.boardId : null,
      board: state.setup.boardId === 'custom' ? { ...state.setup.boardCounts } : undefined,
      rules: state.setup.rules,
      players,
      mock: useMock,
    };
    // 随机座位：座位由服务端定（同时把人类昵称一起带过去），建局响应里回传实际座位
    if (randomSeat) { body.mySeat = 'random'; body.myName = humanName; }
    // 对局归属固化（PROF-02）：开局即锁定到所选档案；未加载出档案时不带字段（服务端归默认档案）
    if (state.profileId) body.profileId = state.profileId;
    persistSeatChoice(seatChoice);
    const created = await api('POST', '/api/games', body);
    state.game = { gameId: created.gameId, playerToken: created.playerToken, godToken: created.godToken, mySeat: created.mySeat };
    localStorage.setItem('ww_current', JSON.stringify(state.game));
    if (created.mySeat) console.info(`[ww] 本局你在 ${created.mySeat} 号座位`);
    await api('POST', `/api/games/${created.gameId}/start`, { token: created.godToken });
    enterGameScreen();
  } catch (e) {
    $('#setup-error').textContent = `✗ ${e.message}`;
  }
}

/** 记住座位偏好（含 'random'）：否则每次回来都要重新选，默认又会回到 1 号 */
function persistSeatChoice(choice) {
  try { localStorage.setItem('ww_seat', String(choice)); } catch (_) { /* 隐私模式忽略 */ }
}

function savedSeatChoice() {
  try { return localStorage.getItem('ww_seat') || 'random'; } catch (_) { return 'random'; }
}

/** 恢复/找回进行中的对局：优先用本地令牌；令牌丢失则从最近未结束存档找回 */
async function checkResume() {
  const saved = localStorage.getItem('ww_current');
  if (saved) {
    try {
      const g = JSON.parse(saved);
      const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=0`);
      // 注意：判断"能否继续"必须用 inMemory（对局是否还在服务端内存里）。
      // 曾经这里用的是 v.live —— 那是流式直播缓冲，没人在打字时就是 null，
      // 于是刷新页面会被误判成"不可恢复"，紧接着把用户令牌删掉（丢档）。
      if (v && !v.finished && v.started && v.inMemory) {
        $('#resume-box').classList.remove('hidden');
        $('#resume-box h2').textContent = `发现进行中的对局（继续上次的局）${await resumeDetail(g.gameId, v)}`;
        return;
      }
      localStorage.removeItem('ww_current'); // 已结束/从未开局（设置页放弃的创建残留）→ 不恢复
    } catch (_) { localStorage.removeItem('ww_current'); }
  }
  // 令牌丢失（如清了浏览器缓存/误点清除）：从最近未结束的对局找回令牌
  try {
    const { rows } = await api('GET', '/api/games');
    const unfinished = rows.find((r) => !r.finished && r.started && r.inMemory); // 未开局或已随服务器重启失活的对局不可恢复
    if (unfinished) {
      const tokens = await api('GET', `/api/games/${unfinished.id}/tokens`);
      const g = { gameId: unfinished.id, playerToken: tokens.player, godToken: tokens.god };
      const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=0`);
      if (v && !v.finished) {
        localStorage.setItem('ww_current', JSON.stringify(g));
        $('#resume-box').classList.remove('hidden');
        $('#resume-box h2').textContent = `发现进行中的对局（已自动找回会话）${await resumeDetail(g.gameId, v)}`;
        return;
      }
    }
    // 服务重启后内存丢失的对局：有断点锚点，可从存档恢复续跑
    const resumable = rows.find((r) => r.resumable);
    if (resumable) {
      localStorage.setItem('ww_resumable', JSON.stringify({ gameId: resumable.id, day: resumable.day }));
      $('#resume-box').classList.remove('hidden');
      $('#resume-box h2').textContent = `发现中断的对局（服务重启过）${await resumeDetail(resumable.id, resumable)}`;
      $('#btn-resume').textContent = '从断点恢复对局';
      return;
    }
  } catch (_) { /* 无可恢复对局 */ }
}

/**
 * 恢复卡片的一句话详情（P3-a）：人数 / 第几天 / 试玩还是真局 / 存档多久前。
 * 以前卡片只有一句"发现对局"，玩家不知道要恢复的是哪一局什么状态（实测反馈）。
 * 拿不到详情不影响恢复 —— 详情是锦上添花，恢复本身不能因为它失败。
 */
async function resumeDetail(gameId, v) {
  const parts = [];
  if (v && v.day != null) parts.push(`第 ${v.day} 天`);
  try {
    const { rows } = await api('GET', '/api/games');
    const r = (rows || []).find((x) => x.id === gameId);
    if (r) {
      if (r.seats) parts.push(`${r.seats} 人局`);
      parts.push(r.mock ? '试玩局（不调用 API）' : '真实对局（调用 API，会消耗额度）');
      if (r.date) {
        const mins = Math.round((Date.now() - new Date(r.date).getTime()) / 60000);
        if (mins >= 1) parts.push(`存档于 ${mins} 分钟前`);
      }
    }
  } catch (_) { /* 详情拿不到就只显示已知信息 */ }
  return parts.length ? `（${parts.join(' · ')}）` : '';
}

async function resumeFromAnchor() {
  try {
    const info = JSON.parse(localStorage.getItem('ww_resumable') || 'null');
    if (!info) return;
    const r = await api('POST', `/api/games/${info.gameId}/resume`, {});
    localStorage.removeItem('ww_resumable');
    localStorage.setItem('ww_current', JSON.stringify({ gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken }));
    state.game = { gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken };
    enterGameScreen();
  } catch (e) { alert(`恢复失败：${e.message}`); }
}

function resumeGame() {
  try { state.game = JSON.parse(localStorage.getItem('ww_current')); enterGameScreen(); } catch (_) {}
}

// ---------------- 玩家档案（PROF-01/04，方案 §3） ----------------
// 本机多档案：昵称/头像/简介/战绩/笔记/经验池按档案隔离；API 配置是安装级的，切换档案不动它。
// 唯一身份是 UUID，昵称允许重名。归档替代删除；删除只对已归档档案开放（二次确认）。
const AVATAR_EMOJI = { scholar: '🎓', hunter: '🏹', seer: '🔮', wolf: '🐺', witch: '🧪', night: '🌙', candle: '🕯️', mask: '🎭' };

async function loadProfiles() {
  try {
    const r = await api('GET', '/api/profiles');
    state.profiles = r.profiles || [];
    let saved = null;
    try { saved = localStorage.getItem('ww_profile_id'); } catch (_) {}
    const cur = state.profiles.find((p) => p.id === saved && !p.archivedAt);
    state.profileId = cur ? cur.id : (state.profiles.find((p) => !p.archivedAt) || {}).id || r.defaultProfileId || null;
    renderProfileStrip();
  } catch (e) {
    state.profileId = null;
    renderProfileStrip(`档案加载失败：${e.message}`);
  }
}

function profileLabel(p) {
  return `${AVATAR_EMOJI[p.avatarId] || '👤'} ${p.nickname}${p.archivedAt ? '（已归档）' : ''}`;
}

function renderProfileStrip(err) {
  const sel = $('#profile-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of state.profiles.filter((x) => !x.archivedAt)) {
    const o = el('option', null, escapeHtml(profileLabel(p)));
    o.value = p.id;
    sel.appendChild(o);
  }
  if (state.profileId) sel.value = state.profileId;
  sel.disabled = !state.profiles.length;
  if (err) sel.title = err; else sel.removeAttribute('title');
}

function onSelectProfile(pid) {
  state.profileId = pid;
  try { localStorage.setItem('ww_profile_id', pid); } catch (_) {}
  const p = state.profiles.find((x) => x.id === pid);
  // 档案昵称作为"我的昵称"默认值（仍可手动改，不强制同步）
  if (p && $('#my-name') && !$('#my-name').dataset.touched) $('#my-name').value = p.nickname;
}

function openProfileManager() {
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>👤 玩家档案</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', '同一台设备可以建多个玩家档案：战绩、笔记、AI 经验池互相隔离。API 配置是整台设备共享的，切换档案不会改动它。档案的唯一身份是 UUID，昵称允许重名。'));

  const list = el('div', 'pm-list');
  const rows = [...state.profiles].sort((a, b) => (a.archivedAt ? 1 : 0) - (b.archivedAt ? 1 : 0) || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  const usableCount = state.profiles.filter((p) => !p.archivedAt).length;
  for (const p of rows) {
    const row = el('div', 'pm-row' + (p.archivedAt ? ' archived' : '') + (p.id === state.profileId ? ' current' : ''));
    const main = el('div', 'pm-main');
    const name = elText('div', 'pm-name', profileLabel(p));
    if (p.id === state.profileId) name.textContent += '（当前）';
    main.appendChild(name);
    main.appendChild(elText('div', 'hint', `创建于 ${(p.createdAt || '').slice(0, 10)}${p.archivedAt ? ` · 归档于 ${(p.archivedAt || '').slice(0, 10)}` : ''}`));
    row.appendChild(main);
    const ops = el('div', 'pm-ops');
    const op = (label, fn, cls = 'btn ghost small') => {
      const b = el('button', cls, label);
      b.addEventListener('click', () => fn(p, b));
      ops.appendChild(b);
      return b;
    };
    if (!p.archivedAt) {
      op('选用', async (pp) => { onSelectProfile(pp.id); $('#modal-root').innerHTML = ''; renderProfileStrip(); }, 'btn small');
    }
    op('编辑', (pp) => openProfileEdit(pp));
    // 战绩（PROF-03，§3.7）：懒加载，按桶分列（真实胜率分母只含真实+自然结束+可判定）
    if (!p.archivedAt) {
      op('战绩', async (pp, btn) => {
        try {
          const s = await api('GET', `/api/profiles/${pp.id}/stats`);
          btn.textContent = `战绩 ${s.wins}胜${s.losses}负${s.draws ? s.draws + '平' : ''}`;
          btn.title = `正式 ${s.real} 局（胜率分母）· 试玩 ${s.byBucket.mock} · 观战 ${s.byBucket.spectate} · 终止 ${s.byBucket.terminated} · 存档合计 ${s.total}`;
          btn.disabled = true;
        } catch (e) { btn.textContent = '战绩获取失败'; btn.title = e.message; }
      });
    }
    if (!p.archivedAt) {
      op('归档', async (pp) => {
        if (usableCount <= 1) { alert('最后一个可用档案不能归档（可先新建一个）'); return; }
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
        if (!confirm(`彻底删除「${pp.nickname}」？\n\n其战绩与笔记将进入回收区（30 天后由你手动清理，本期不自动清空）。\n建议先在列表里点「导出」留一份备份。`)) return;
        try {
          await api('DELETE', `/api/profiles/${pp.id}`);
          if (state.profileId === pp.id) { state.profileId = null; try { localStorage.removeItem('ww_profile_id'); } catch (_) {} }
          await loadProfiles(); openProfileManager();
        } catch (e) { alert(`删除失败：${e.message}`); }
      }, 'btn small danger');
    }
    op('导出', (pp) => { window.open(`/api/profiles/${pp.id}/export`, '_blank', 'noopener'); });
    row.appendChild(ops);
    list.appendChild(row);
  }
  body.appendChild(list);

  const btnrow = el('div', 'btnrow');
  const mk = el('button', 'btn', '＋ 新建档案');
  mk.addEventListener('click', () => openProfileEdit(null));
  btnrow.appendChild(mk);
  const imp = el('button', 'btn ghost', '📥 导入档案包');
  imp.addEventListener('click', () => openProfileImport());
  btnrow.appendChild(imp);
  body.appendChild(btnrow);
  body.appendChild(el('p', 'hint', '说明：这些档案是同一设备上的数据分类，不是密码保护。能读本地文件或管理本服务的人就能看到所有档案。手机浏览器连的是电脑服务时，读写的也是电脑那一份。'));
  wrap.append(head, body);
  openModal(wrap);
}

function openProfileEdit(existing) {
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${existing ? '编辑档案' : '新建档案'}</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; openProfileManager(); });
  head.appendChild(close);
  const body = el('div', 'mbody');

  const nameL = el('label', null, '<span>昵称（1–20 字）</span>');
  const nameI = el('input'); nameI.maxLength = 20; nameI.value = existing ? existing.nickname : '';
  nameL.appendChild(nameI);
  body.appendChild(nameL);

  body.appendChild(el('div', 'hint', '头像（内置，仅作区分，不上传图片）'));
  const av = el('div');
  av.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 12px;';
  let avatarId = existing ? existing.avatarId : 'scholar';
  for (const [aid, emoji] of Object.entries(AVATAR_EMOJI)) {
    const c = el('button', 'chip' + (aid === avatarId ? ' sel' : ''), emoji);
    c.type = 'button';
    c.addEventListener('click', () => { avatarId = aid; [...av.children].forEach((x) => x.classList.remove('sel')); c.classList.add('sel'); });
    av.appendChild(c);
  }
  body.appendChild(av);

  const bioL = el('label', null, '<span>简介（选填，最多 100 字）</span>');
  const bioI = el('textarea'); bioI.maxLength = 100; bioI.rows = 2; bioI.value = existing ? (existing.bio || '') : '';
  bioL.appendChild(bioI);
  body.appendChild(bioL);

  const err = el('p', 'hint'); err.style.color = '#ff8080';
  const go = el('button', 'btn', existing ? '保存' : '创建');
  go.addEventListener('click', async () => {
    const nick = nameI.value.trim();
    if (!nick) { err.textContent = '昵称不能为空'; return; }
    try {
      if (existing) await api('PATCH', `/api/profiles/${existing.id}`, { expectedRevision: existing.revision, nickname: nick, avatarId, bio: bioI.value.trim() });
      else {
        const r = await api('POST', '/api/profiles', { nickname: nick, avatarId, bio: bioI.value.trim() });
        onSelectProfile(r.profile.id);
      }
      await loadProfiles();
      $('#modal-root').innerHTML = '';
      openProfileManager();
    } catch (e) {
      if (e.message.includes('409') || /已被其他窗口|revision/i.test(e.message)) err.textContent = '档案刚被别处修改过（另一窗口？），请关闭后重开再试';
      else err.textContent = e.message;
    }
  });
  body.append(go, err);
  wrap.append(head, body);
  openModal(wrap);
}

/** 导入档案包（PROF-04）：文件 → 预览（不写盘）→ 确认 → 落地为新档案（ID 重映射，绝不覆盖现有局） */
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
    const ok = confirm(
      `导入预览（尚未写入任何数据）：\n\n` +
      `档案：${pv.preview.nickname}（将创建为「${pv.preview.nickname}（导入）」新档案）\n` +
      `已结束对局：${pv.preview.games} 局（ID 会重新生成，不覆盖现有对局）\n` +
      `笔记：${pv.preview.notes} 份\n\n` +
      `进行中的对局不会包含在包内。确认导入？`);
    if (!ok) return;
    try {
      const r = await api('POST', '/api/profiles/import', { package: pkg });
      await loadProfiles();
      onSelectProfile(r.profileId);
      $('#modal-root').innerHTML = '';
      renderProfileStrip();
      openProfileManager();
      alert(`导入完成：${r.imported} 局已归入新档案`);
    } catch (e) { alert(`导入失败：${e.message}`); }
  });
  inp.click();
}

// ---------------- 游戏页 ----------------
function enterGameScreen() {
  $('#screen-setup').classList.add('hidden');
  $('#screen-game').classList.remove('hidden');
  state.playerAfter = 0;
  state.godAfter = 0;
  state.playerView = null; state.godView = null; // 清掉上一局的缓存帧，避免切换对局后渲染残留
  state.roleShown = false;
  state.anno = { rev: 0, seats: {}, loaded: false, gameId: state.game.gameId };
  try { state.tags = JSON.parse(localStorage.getItem(`ww_tags_${state.game.gameId}`)) || {}; } catch (_) { state.tags = {}; }
  $('#stream').innerHTML = '';
  $('#btn-gear').addEventListener('click', openGearMenu);
  $('#btn-notes').addEventListener('click', toggleNotesDrawer);
  $('#btn-notes-close').addEventListener('click', toggleNotesDrawer);
  initAnnotations(); // NOTE-03/05：拉取本局标注 + 旧 ww_tags_ 一次性迁移
  startPolling();
}

/**
 * 齿轮菜单：把顶栏原来那排按钮（规则书 / 上帝 / 结束本局 / APP端 / 首页）收进一处。
 * 与手机端同一套信息架构：设置类入口只有一个齿轮，退出类操作也放在里面。
 */
function openGearMenu() {
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>⚙ 设置</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
  head.appendChild(close);
  const body = el('div', 'mbody');
  const list = el('div', 'gear-list');
  const v = state.view;
  const items = [
    ['📖 规则书', () => openRulebook()],
    [I18N.t('codex.entry'), () => openCodex()],
    ['🎴 我的身份牌', () => { if (v && v.me && v.me.role) openInspect(v.me.role); }],
    ['📝 私人笔记', () => toggleNotesDrawer()],
    [`👁 上帝视角（当前${state.godMode ? '开' : '关'}）`, () => toggleGod()],
    [`🌐 切换语言（当前${I18N.getLang() === 'en' ? ' English' : ' 中文'}）`, () => switchLangDesktop()],
    ['📱 手机 APP 端', () => { window.location.href = '/m/'; }],
  ];
  if (v && !v.finished) items.push(['⏹ 结束本局', () => terminateGame()]);
  items.push(['🏠 返回首页', () => backHome()]);
  items.forEach(([label, fn], i) => {
    const b = el('button', 'gear-item' + (i === items.length - 1 ? '' : ''), label);
    if (/结束本局/.test(label)) b.classList.add('danger');
    b.addEventListener('click', () => { $('#modal-root').innerHTML = ''; fn(); });
    list.appendChild(b);
  });
  body.appendChild(list);
  body.appendChild(el('p', 'hint', '对局中随时可以打开此菜单；上帝视角会给所有 AI 提示注入裁判信息，仅供调试。'));
  wrap.append(head, body);
  openModal(wrap);
}

function switchLangDesktop() {
  I18N.setLang(I18N.getLang() === 'en' ? 'zh-CN' : 'en');
  renderSetupDigest(); // 信息条与摘要是 JS 拼的，不跟着 data-i18n 自动重刷
  if (codexVisible()) window.Codex.render(); // 图鉴内容由 JS 拼，不跟着 data-i18n 自动重刷
}

// ---------------- 私人标注 V2（NOTE-03/05，方案 §4） ----------------
// 三层信息各司其职：候选身份（我还不确定）、自称身份（TA 说自己是谁）、倾向+把握（我的综合判断）。
// 合法性判断统一走 web/shared/annotations-model.js（与 Node 侧 normalizeSeatAnnotation 同一套白名单）。
// 持久化在服务端档案目录（/api/games/:id/annotations），带 revision 乐观并发；AI 完全不可见。
const A = () => window.WWAnnotationsModel;

/** 进局初始化：① 旧 ww_tags_<gid>（{seat: roleId}）一次性迁移进新存储；② 拉取本局标注 */
async function initAnnotations() {
  const gid = state.game.gameId;
  const token = state.game.playerToken || state.game.godToken;
  // --- 迁移（NOTE-05，复审 P1-1）：逐座位合并 + 无损容纳检查；确认落盘后才清理本地 key ---
  // mergeLegacyTags 返回 { fill, pending }：pending 是候选/备注都放不下的座位 ——
  // 保留在本地 key 里待确认并弹提示，绝不静默丢弃，也绝不靠截断原备注腾位置。
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(`ww_tags_${gid}`)) || null; } catch (_) {}
  if (legacy && Object.keys(legacy).length) {
    let migrated = false;
    try {
      const cur = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
      const serverSeats = (cur.annotations && cur.annotations.seats) || {};
      const { fill, pending } = A().mergeLegacyTags(serverSeats, legacy, (rid) => (state.meta.roles && state.meta.roles[rid]) || null);
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
        // 待确认：本地 key 只保留未解决的座位，下一局/下次迁移仍会尝试
        try { localStorage.setItem(`ww_tags_${gid}`, JSON.stringify(pending)); } catch (_) {}
        state.tags = pending;
        openLegacyPendingPrompt(pending);
      } else {
        localStorage.removeItem(`ww_tags_${gid}`); // 全部落盘确认后才清理
        state.tags = {};
      }
      migrated = true;
    } catch (_) { /* 迁移失败（无归属档案/离线/409）：保留本地旧格式，下局再试 */ }
    if (!migrated) { try { state.tags = legacy; } catch (_) {} }
  }
  // --- 常规拉取 ---
  try {
    const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
    state.anno.rev = r.revision;
    state.anno.seats = r.annotations.seats || {};
  } catch (_) { /* 无归属档案的旧局：标注功能只读不可用，不阻塞对局 */ }
  state.anno.loaded = true;
  // 关键：进局首次渲染座位时标注往往还在拉取中；数据到达后必须补一次重绘，
  // 否则刷新恢复的场景下角标要等下一次全量重绘才会出现（实测踩过）
  if (state.view) updateSeats(state.view);
  if (!$('#notes-drawer').classList.contains('hidden')) renderNotesList();
}

/** 旧标记待确认提示（复审 P1-1）：候选与备注都满的座位无法自动并入，
 *  本地 key 已保留这些座位；这里给出可见入口让用户编辑并入或显式丢弃。 */
function openLegacyPendingPrompt(pending) {
  const seats = Object.keys(pending);
  if (!seats.length) return;
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>🏷 旧标记待确认</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
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
      $('#modal-root').innerHTML = '';
      openTagModal(Number(seat)); // 编辑保存成功后该座位即并入；失败/取消则仍留在待确认记录里
    });
    const drop = el('button', 'btn small danger', '丢弃旧标记');
    drop.addEventListener('click', () => {
      delete pending[seat];
      try {
        if (Object.keys(pending).length) localStorage.setItem(`ww_tags_${state.game.gameId}`, JSON.stringify(pending));
        else localStorage.removeItem(`ww_tags_${state.game.gameId}`);
      } catch (_) {}
      $('#modal-root').innerHTML = '';
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

/** 座位角标文案：优先展示倾向（偏狼/偏好好人…），有候选时附第一个候选身份 */
function seatTagSummary(seat) {
  const a = state.anno.seats && state.anno.seats[seat];
  if (!a || (!a.leaning || a.leaning === 'neutral') && !(a.candidateRoleIds || []).length && !a.claimedRoleId) return null;
  const A_ = A();
  const parts = [];
  if (a.leaning && a.leaning !== 'neutral') parts.push(A_.LEANING_CN[a.leaning] || a.leaning);
  const rid = (a.candidateRoleIds && a.candidateRoleIds[0]) || a.claimedRoleId;
  const r = rid && state.meta.roles && state.meta.roles[rid];
  if (r) parts.push(`${r.emoji}${r.name}`);
  return parts.join(' · ') || null;
}

function saveAnnotations(seat, entry) {
  const gid = state.game.gameId;
  const token = state.game.playerToken || state.game.godToken;
  return api('PUT', `/api/games/${gid}/annotations`, { token, expectedRevision: state.anno.rev, seats: { [seat]: entry } })
    .then((r) => {
      state.anno.rev = r.revision;
      state.anno.seats = r.annotations.seats || {};
      updateSeats(state.view);
      if (!$('#notes-drawer').classList.contains('hidden')) renderNotesList();
      return true;
    })
    .catch((e) => {
      if (e.status === 409) {
        // 并发冲突（方案 §4.5）：另一窗口改过。给出"载入最新并保留我这版"的人工合并路径，绝不静默覆盖。
        const keep = entry; // 本地编辑的这份
        const box = el('div');
        box.appendChild(el('p', 'hint', '⚠ 另一个窗口更新了笔记（版本冲突）。可选择：载入最新笔记（保留你正在编辑的这一个座位的修改）或放弃本次修改。'));
        const br = el('div', 'btnrow');
        const merge = el('button', 'btn', '载入最新并保留我的修改');
        merge.addEventListener('click', async () => {
          const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
          state.anno.rev = r.revision;
          state.anno.seats = r.annotations.seats || {};
          $('#modal-root').innerHTML = '';
          try {
            await saveAnnotations(seat, keep); // 以最新 revision 重放这一座位的修改
          } catch (_) { alert('合并保存仍失败，请稍后重试'); }
        });
        const discard = el('button', 'btn ghost', '放弃我的修改');
        discard.addEventListener('click', async () => {
          const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
          state.anno.rev = r.revision;
          state.anno.seats = r.annotations.seats || {};
          $('#modal-root').innerHTML = '';
          updateSeats(state.view);
        });
        br.append(merge, discard);
        box.appendChild(br);
        openModal(box);
      } else {
        alert(`保存失败：${e.message}\n（草稿仍在输入框里，未丢失）`);
      }
      return false;
    });
}

/** 某座位当前"仍可能"的身份：扣除已公开翻牌的、你自己占用的（唯一身份即排除） */
function possibleRolesFor(v, seat) {
  const board = v.board || {};
  const revealedCount = {};
  for (const p of v.players) {
    if (p.role && p.revealed) revealedCount[p.role] = (revealedCount[p.role] || 0) + 1;
  }
  const myRole = v.me ? v.me.role : null;
  const out = [];
  for (const [rid, count] of Object.entries(board)) {
    let remaining = count - (revealedCount[rid] || 0);
    if (myRole === rid) remaining -= 1;
    if (remaining > 0) out.push(rid);
  }
  return out;
}

function openTagModal(seat) {
  const v = state.view;
  const A_ = A();
  const roles = possibleRolesFor(v, seat);
  const cur = state.anno.seats[seat] || {};
  const draft = {
    leaning: cur.leaning || 'neutral',
    candidateRoleIds: [...(cur.candidateRoleIds || [])],
    claimedRoleId: cur.claimedRoleId || null,
    confidence: cur.confidence || 'low',
    note: cur.note || '',
    evidenceSeq: cur.evidenceSeq || null,
    day: cur.day || (v ? v.day : null),
    phase: cur.phase || (v ? v.phase : null),
  };
  const dirty = () => JSON.stringify(draft) !== JSON.stringify({
    leaning: cur.leaning || 'neutral',
    candidateRoleIds: [...(cur.candidateRoleIds || [])],
    claimedRoleId: cur.claimedRoleId || null,
    confidence: cur.confidence || 'low',
    note: cur.note || '',
    evidenceSeq: cur.evidenceSeq || null,
    day: cur.day || (v ? v.day : null),
    phase: cur.phase || (v ? v.phase : null),
  });

  const wrap = el('div');
  const name = (v.players.find((p) => p.seat === seat) || {}).name || '';
  const head = el('div', 'mhead', `<h2>📝 ${seat} 号的私人笔记</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => {
    if (dirty() && !confirm('有未保存的修改，确定放弃？')) return;
    $('#modal-root').innerHTML = '';
  });
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', `${escapeHtml(name)} · 只是你的推理笔记，AI 看不到。身份已公开的座位会自动显示真身，不需要标注。`));

  // ① 倾向 + ② 把握
  body.appendChild(el('h4', null, '倾向判断'));
  const leanRow = el('div');
  leanRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;';
  for (const lv of A_.LEANINGS) {
    const c = el('button', 'chip' + (draft.leaning === lv ? ' sel' : ''), A_.LEANING_CN[lv]);
    c.type = 'button';
    c.addEventListener('click', () => { draft.leaning = lv; [...leanRow.children].forEach((x) => x.classList.remove('sel')); c.classList.add('sel'); });
    leanRow.appendChild(c);
  }
  body.appendChild(leanRow);
  const confRow = el('div');
  confRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;';
  for (const cv of ['low', 'medium', 'high']) {
    const c = el('button', 'chip' + (draft.confidence === cv ? ' sel' : ''), `${A_.CONFIDENCE_CN[cv]}把握`);
    c.type = 'button';
    c.addEventListener('click', () => { draft.confidence = cv; [...confRow.children].forEach((x) => x.classList.remove('sel')); c.classList.add('sel'); });
    confRow.appendChild(c);
  }
  body.appendChild(confRow);

  // ③ 候选身份（≤3）：只列"仍可能"的身份；再点一次取消
  body.appendChild(el('h4', null, '候选身份（最多 3 个）'));
  const candRow = el('div');
  candRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;';
  for (const rid of roles) {
    const r = state.meta.roles[rid];
    const sel = () => draft.candidateRoleIds.includes(rid);
    const c = el('button', 'chip' + (sel() ? ' sel' : ''), `${r.emoji} ${r.name}`);
    c.type = 'button';
    c.addEventListener('click', () => {
      if (sel()) draft.candidateRoleIds = draft.candidateRoleIds.filter((x) => x !== rid);
      else { if (draft.candidateRoleIds.length >= A_.MAX_CANDIDATES) { c.title = `最多 ${A_.MAX_CANDIDATES} 个`; return; } draft.candidateRoleIds.push(rid); }
      c.classList.toggle('sel');
    });
    candRow.appendChild(c);
  }
  body.appendChild(candRow);

  // ④ 自称身份（TA 声称的，不等于你信的）
  body.appendChild(el('h4', null, '自称身份（TA 声称的，不一定信）'));
  const claimSel = el('select');
  claimSel.appendChild(el('option', null, '（未声称）')).value = '';
  for (const rid of roles) {
    const r = state.meta.roles[rid];
    claimSel.appendChild(el('option', null, `${r.emoji} ${r.name}`)).value = rid;
  }
  claimSel.value = draft.claimedRoleId || '';
  claimSel.addEventListener('change', () => { draft.claimedRoleId = claimSel.value || null; });
  body.appendChild(claimSel);

  // ⑤ 笔记正文 + 依据出处（事件序号）
  const noteL = el('label', null, `<span>笔记（最多 ${A_.MAX_NOTE} 字；可记录"依据第几条发言"）</span>`);
  const noteI = el('textarea');
  noteI.maxLength = A_.MAX_NOTE;
  noteI.rows = 3;
  noteI.value = draft.note;
  noteI.placeholder = '例：跳预言家但查杀方向存疑，依据第 12 条发言';
  noteL.appendChild(noteI);
  body.appendChild(noteL);
  const evL = el('label', null, '<span>依据事件序号（选填，发言流里每条前的 #号）</span>');
  const evI = el('input');
  evI.type = 'number';
  evI.min = '1';
  evI.value = draft.evidenceSeq || '';
  evL.appendChild(evI);
  body.appendChild(evL);

  const err = el('p', 'hint'); err.style.color = '#ff8080';
  const br = el('div', 'btnrow');
  const save = el('button', 'btn', '保存笔记');
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
    if (okFlag) $('#modal-root').innerHTML = '';
    else save.disabled = false;
  });
  br.appendChild(save);
  if (cur && (cur.leaning !== 'neutral' || (cur.candidateRoleIds || []).length || cur.claimedRoleId || cur.note)) {
    const clr = el('button', 'btn danger', '清除此座位笔记');
    clr.addEventListener('click', async () => {
      save.disabled = true;
      const okFlag = await saveAnnotations(seat, A_.normalizeSeatAnnotation({}));
      if (okFlag) $('#modal-root').innerHTML = '';
      else save.disabled = false;
    });
    br.appendChild(clr);
  }
  body.append(br, err);
  wrap.append(head, body);
  openModal(wrap);
}

// ---------------- 笔记抽屉（NOTE-03）：常显入口顶栏 📝 ----------------
function toggleNotesDrawer() {
  const d = $('#notes-drawer');
  const opening = d.classList.contains('hidden');
  $('#god-drawer').classList.add('hidden'); // 两个抽屉互斥
  d.classList.toggle('hidden');
  if (opening) renderNotesList();
}

function renderNotesList() {
  const box = $('#notes-list');
  if (!box) return;
  box.innerHTML = '';
  const v = state.view;
  if (!state.anno.loaded) { box.appendChild(el('p', 'hint', '标注加载中…')); return; }
  if (!v) { box.appendChild(el('p', 'hint', '对局尚未开始')); return; }
  const entries = Object.entries(state.anno.seats || {})
    .filter(([, a]) => a && (a.leaning !== 'neutral' || (a.candidateRoleIds || []).length || a.claimedRoleId || a.note));
  if (!entries.length) {
    box.appendChild(el('p', 'hint', '还没有笔记。点击圆桌座位上的 🏷 开始标注；这里是全部笔记的汇总列表。'));
    return;
  }
  entries.sort((x, y) => Number(x[0]) - Number(y[0])).forEach(([seat, a]) => {
    const p = v.players.find((pl) => pl.seat === Number(seat));
    const row = el('div', 'pm-row');
    const main = el('div', 'pm-main');
    const nm = elText('div', 'pm-name', `${seat}号 ${p ? p.name : ''}${p && !p.alive ? '（出局）' : ''}`);
    main.appendChild(nm);
    const sum = seatTagSummary(Number(seat));
    if (sum) main.appendChild(elText('div', 'hint', sum));
    if (a.claimedRoleId && state.meta.roles[a.claimedRoleId]) main.appendChild(elText('div', 'hint', `自称：${state.meta.roles[a.claimedRoleId].name}`));
    if (a.note) main.appendChild(elText('div', 'hint', a.note));
    if (a.day) main.appendChild(elText('div', 'hint', `记录于第${a.day}天${a.phase ? ` · ${PHASE_LABEL[a.phase] || a.phase}` : ''}`));
    row.appendChild(main);
    const ops = el('div', 'pm-ops');
    const b = el('button', 'btn ghost small', '编辑');
    b.addEventListener('click', () => openTagModal(Number(seat)));
    ops.appendChild(b);
    row.appendChild(ops);
    box.appendChild(row);
  });
}

async function terminateGame() {
  if (!confirm('确定要结束本局游戏吗？所有玩家将亮牌，本局记为终止。')) return;
  try {
    await api('POST', `/api/games/${state.game.gameId}/terminate`, { token: state.game.playerToken || state.game.godToken });
    // 原地亮牌结算：立即拉取，不等下一次轮询
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 350));
      try { await poll(); } catch (_) {}
      if (state.view && state.view.finished) break;
    }
    $('#pending-hint').textContent = '对局已终止，全场亮牌 ✓';
    // 终止是终态：立刻把"当前对局"从 localStorage 里清掉。
    // 以前只在 poll 循环里根据 view.finished 清，而中止那一刻循环可能已经 break 了，
    // 于是残留下来，下次进页面会被当成活局恢复（P2-c，桌面/移动双端都复现过）。
    localStorage.removeItem('ww_current');
  } catch (e) { $('#pending-hint').textContent = `✗ ${e.message}`; }
}

function backHome() {
  stopPolling();
  if (!state.view || !state.view.finished) localStorage.setItem('ww_current', JSON.stringify(state.game));
  else localStorage.removeItem('ww_current');
  location.reload();
}

function startPolling() {
  stopPolling();
  if (startStream()) return; // 优先 SSE 推送
  startPollFallback();
}
function startPollFallback() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(poll, 1200);
  // 降级不是终态（P2-a）：每 30s 试着重连推送，成功就撤掉提示、回到推送通道。
  // 原来一旦降级就再也回不去，横幅还会永久挂在事件流里。
  if (!state.streamRetry) {
    state.streamRetry = setInterval(() => {
      if (state.stream || !state.game) return;
      if (state.view && state.view.finished) return;
      if (startStream()) setStreamStatus(null);
    }, 30000);
  }
  poll();
}
function stopPolling() {
  if (state.streamRetry) { clearInterval(state.streamRetry); state.streamRetry = null; }
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  stopStream();
}

/**
 * SSE 推送（P2-2）：服务端只在**真的有变化**时推一帧，省掉 1.2s 轮询的空转往返。
 *
 * 关键设计：推送是**优化而不是依赖**。浏览器不支持、反代缓冲、连接被断——
 * 任一情况下都自动回退到轮询，游戏照常进行（服务端两条通道共用同一份视图负载，
 * 所以两种模式的渲染结果逐字段一致，不会出现"刷新一下才对"的差异）。
 */
function startStream() {
  if (typeof window === 'undefined' || !window.EventSource) return false;
  const g = state.game;
  if (!g || !g.gameId) return false;
  try {
    const playerToken = g.playerToken || g.godToken;
    state.stream = openViewStream('player', playerToken, () => state.playerAfter || 0);
    if (state.godMode && g.godToken) {
      state.godStream = openViewStream('god', g.godToken, () => state.godAfter || 0);
    }
    // 心跳/断流兜底：若超过 STREAM_DEAD_MS 既没有帧也没有心跳，视为连接已死 → 回退轮询。
    // ⚠ 这个阈值必须**大于服务端心跳周期的 2 倍**（src/api.js：STREAM_TICK_MS 500ms × STREAM_PING_TICKS 32 ≈ 16s）。
    //   原来写死 8s < 16s：正常空闲（等人类玩家输入时一个事件都没有）就会被误判成断线，
    //   于是横幅常驻"已切换为轮询"、推送白白降级 —— 真实对局里反复复现（P1）。
    //   36s = 16s × 2 + 余量，容忍丢一次心跳。test/stream-consistency.test.js 会锁死这个关系。
    state.streamWatchdog = setInterval(() => {
      if (!state.stream) return;
      if (Date.now() - (state.lastStreamAt || 0) > STREAM_DEAD_MS) {
        setStreamStatus('⚠️ 推送连接无响应，已转为轮询（每 30s 自动尝试恢复推送）');
        stopStream();
        startPollFallback();
      }
    }, 4000);
    setStreamStatus(null); // 连上了就把降级提示撤掉（P2-a）
    return true;
  } catch (e) {
    stopStream();
    return false;
  }
}

function openViewStream(kind, token, cursorOf) {
  const g = state.game;
  const es = new EventSource(`/api/games/${g.gameId}/stream?token=${token}&after=${cursorOf()}`);
  const st = { kind, es };
  es.addEventListener('view', (ev) => {
    state.lastStreamAt = Date.now();
    let v;
    try { v = JSON.parse(ev.data); } catch (_) { return; }
    // 玩家流传玩家视图，上帝流传上帝视图；applyView 会沿用另一侧的上一帧
    if (kind === 'god') applyView(null, v);
    else applyView(v, null);
  });
  es.addEventListener('ping', () => { state.lastStreamAt = Date.now(); });
  es.addEventListener('end', () => {
    state.lastStreamAt = Date.now();
    stopStream();
    // 对局结束/被清理：拉一次终局状态（结算分数、终局事件）后停更
    poll();
  });
  es.addEventListener('error', () => {
    // 服务端明确报错（视图构造失败等）：不能静默卡死，回退轮询并把原因显示出来
    if (es.readyState === 2) {
      stopStream();
      setStreamStatus('⚠️ 推送通道中断，已转为轮询（每 30s 自动尝试恢复推送）');
      startPollFallback();
    }
  });
  return st;
}

function stopStream() {
  for (const key of ['stream', 'godStream']) {
    const st = state[key];
    if (st && st.es) { try { st.es.close(); } catch (_) { /* ignore */ } }
    state[key] = null;
  }
  if (state.streamWatchdog) { clearInterval(state.streamWatchdog); state.streamWatchdog = null; }
}

async function poll() {
  const g = state.game;
  if (!g) return;
  try {
    // 玩家视图：始终拉取（提供 pending 操作与"我"的信息）
    const pv = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=${state.playerAfter || 0}`);
    // 上帝视图：开启时另拉全量事件
    let gv = null;
    if (state.godMode) gv = await api('GET', `/api/games/${g.gameId}/view?token=${g.godToken}&after=${state.godAfter || 0}`);
    applyView(pv, gv);
  } catch (e) {
    appendSys(`⚠️ 拉取失败：${e.message}`);
  }
}

/**
 * 渲染一份视图。**SSE 与轮询共用**，所以两条通道的表现逐字段一致——
 * 这是"推送失败就回退轮询"能放心做的前提。
 *
 * pv/gv 允许传 null，含义是"这一侧沿用上一帧"：SSE 分两条流（玩家流 / 上帝流），
 * 任意一条来帧都要用最新的两份视图重渲染，与轮询每次拿两份的行为完全对应。
 *
 * 事件按 seq 游标过滤：SSE 断线重连时服务端可能重发旧事件（浏览器会带 Last-Event-ID，
 * 服务端也会据此续传），过滤后天然幂等，同一句话不会被画两遍。
 */
function applyView(pv, gv) {
  if (pv) state.playerView = pv;
  if (gv) state.godView = gv;
  const P = state.playerView || null;
  const G = state.godView || null;
  const primary = state.godMode ? (G || P) : P;
  if (!primary) return;
  state.view = state.godMode ? { ...primary, me: P && P.me, pending: P && P.pending } : P;
  const fresh = (list, cursor) => (list || []).filter((e) => e.seq > (cursor || 0));
  const playerEvents = fresh(P && P.events, state.playerAfter);
  const godEvents = fresh(G && G.events, state.godAfter);
  if ((state.godMode ? state.godAfter : state.playerAfter) === 0) {
    $('#stream').innerHTML = '';
    state.seatNames = {};
    for (const p of primary.players) state.seatNames[p.seat] = p.name;
  }
  appendEvents(state.godMode ? godEvents : playerEvents);
  if (godEvents.length) state.godAfter = Math.max(state.godAfter || 0, ...godEvents.map((e) => e.seq));
  if (playerEvents.length) state.playerAfter = Math.max(state.playerAfter || 0, ...playerEvents.map((e) => e.seq));
  const mine = P || primary; // 与"我"相关的面板（角色卡/操作栏/暂停横幅）需要玩家视角
  state.view.me = mine.me;
  state.view.pending = mine.pending;
  updateHeader(state.view);
  updateSeats(state.godMode ? { ...primary, me: mine.me } : primary);
  renderMyRoleCard(mine);
  updateActionbar(mine);
  updatePausedBanner(mine);
  updateMemoryChip(mine);
  renderLive(state.godMode ? state.view : primary);
  maybeShowRole(mine);
  renderCoach(state.view); // 终局后的教练面板（含"正在生成/失败原因"）
  if (mine.error) appendSys(`⚠️ 对局异常：${mine.error}`);
  if (state.godMode) renderGodStats();
}

/**
 * 暂停横幅：配额耗尽 / 套餐受限等外部原因导致对局暂停时，
 * 明示原因与重置时间，并提供"继续对局"（从锚点续跑，不重复发言）。
 */
function updatePausedBanner(v) {
  const box = $('#paused-banner');
  if (!box) return;
  const p = v && v.paused;
  if (!p) {
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; }
    return;
  }
  const sig = `${p.kind}|${p.code}|${p.nextFlushTime || ''}`;
  if (box.dataset.sig === sig) return; // 每次轮询都会调用：内容没变就不重建 DOM
  box.dataset.sig = sig;
  const title = p.kind === 'quota' ? '账户额度已用尽' : '套餐 / 权限受限';
  const when = p.nextFlushTime
    ? `预计 <b>${escapeHtml(String(p.nextFlushTime))}</b> 重置`
    : '请到服务商控制台确认额度与套餐状态';
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="pb-title">⏸ 对局已暂停（不是结束）</div>` +
    `<div class="pb-msg">${title}${p.code ? `（业务码 ${escapeHtml(String(p.code))}）` : ''}：${escapeHtml(String(p.message || ''))}</div>` +
    `<div class="pb-hint">${when}。当前进度已完整保存，额度恢复后点「继续对局」即可从断点续跑，已发生的发言不会重来。</div>` +
    `<div class="pb-actions">` +
    `<button class="btn primary" id="btn-resume-paused">继续对局</button>` +
    `<button class="btn ghost" id="btn-terminate-paused">终止本局</button>` +
    `</div>`;
  $('#btn-resume-paused').addEventListener('click', resumePausedGame);
  $('#btn-terminate-paused').addEventListener('click', terminateGame);
}

/** 从暂停态恢复：令牌沿用，前端只需重拉事件流 */
async function resumePausedGame() {
  const g = state.game;
  if (!g) return;
  const btn = $('#btn-resume-paused');
  if (btn) { btn.disabled = true; btn.textContent = '恢复中…'; }
  try {
    const r = await api('POST', `/api/games/${g.gameId}/resume`, { token: g.playerToken || g.godToken });
    state.game = { gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken };
    localStorage.setItem('ww_current', JSON.stringify(state.game));
    state.playerAfter = 0; state.godAfter = 0;
    state.playerView = null; state.godView = null; // 换了新对局，缓存帧作废
    $('#stream').innerHTML = '';
    const box = $('#paused-banner');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; }
    await poll();
  } catch (e) {
    alert(`恢复失败：${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '继续对局'; }
  }
}

/**
 * "打字中"气泡：把模型 41s 的空白等待变成即时可见的增量文本。
 * 公开发言直接显示；私密决策只显示"正在思考"（不泄露目标），上帝视角可见原始增量与独白。
 *
 * 秒表（2026-09 加）：实测发言平均等 103.6s、最长 362s，而普通模式下这段时间屏幕**完全不动**
 * —— 体感上"卡死"和"在跑"的差别比实际耗时更伤人。这里只加"已 N 秒"和公开发言的字数，
 * 不泄露任何私密内容（秒数进入 sig，让既有的 1.2s 轮询把秒表走起来）。
 */
function liveSince(key) {
  if (!state.liveSince || state.liveSince.key !== key) state.liveSince = { key, at: Date.now() };
  return state.liveSince.at;
}

function renderLive(v) {
  const node0 = document.getElementById('live-typing');
  const l = v && v.live;
  // 私密投票期间：没有公开发言，但服务端会播报"已收集几票"——
  // 那是这个阶段唯一能让玩家知道"在跑"的信号（不泄露任何目标），不能因为 live 为空就收掉。
  const vpRaw = v && !v.finished ? state.voteProgress : null;
  const vp = vpRaw && vpRaw.done < vpRaw.total ? vpRaw : null; // 收齐即收工，不依赖事件顺序
  if (!l && !vp) {
    if (node0) node0.remove();
    state.liveSig = '';
    state.liveSince = null; // 下一段直播重新计时，避免沿用上一个人的秒表
    return;
  }
  const text = l ? l.text || '' : '';
  const reasoning = l ? l.reasoning || '' : '';
  const canSeeText = !!l && (!!l.public || !!state.godMode);
  const secs = l ? Math.max(0, Math.round((Date.now() - liveSince(`${l.seat}|${l.task || ''}`)) / 1000))
    : Math.max(0, Math.round((Date.now() - vp.at) / 1000));
  const sig = `${l ? l.seat : 0}|${l ? l.task : ''}|${text.length}|${reasoning.length}|${state.godMode ? 1 : 0}|${secs}|${vp ? `${vp.done}/${vp.total}` : ''}`;
  if (node0 && state.liveSig === sig) return; // 1.2s 轮询且内容未增长：不重建 DOM
  state.liveSig = sig;
  let node = node0;
  if (!node) {
    node = el('div', 'msg typing');
    node.id = 'live-typing';
    $('#stream').appendChild(node);
  }
  const who = l ? seatLabel(l.seat) : '';
  const counter = vp
    ? ` <span class="typing-tag">已思考 ${vp.done}/${vp.total} · ${secs}s</span>`
    : (l ? ` <span class="typing-tag">已 ${secs}s${canSeeText && text ? ` · ${text.length} 字` : ''}${state.godMode && reasoning ? ` · 思考 ${reasoning.length} 字` : ''}</span>` : '');
  if (!l) {
    let only = '<div class="meta"><span class="typing-tag">… 正在收集投票</span></div>';
    only += `<div class="typing-body muted">已思考 ${vp.done}/${vp.total} · ${secs}s</div>`;
    node.innerHTML = only;
    autoScroll();
    return;
  }
  const tag = canSeeText && text ? '✍ 正在发言' : (text ? '… 正在决策' : '… 正在思考');
  let html = `<div class="meta"><span class="who">${who}</span> <span class="typing-tag">${tag}</span>${counter}</div>`;
  if (canSeeText && text) html += `<div class="typing-body">${escapeHtml(text)}<span class="caret"></span></div>`;
  else html += '<div class="typing-body muted">正在思考…<span class="caret"></span></div>';
  if (state.godMode && reasoning) html += `<div class="typing-reason">💭 ${escapeHtml(reasoning.slice(-400))}</div>`;
  node.innerHTML = html;
  autoScroll();
}

/** 日切反思进度：日切边界后台整理记忆时给个可见进度（对局不会被它阻塞） */
function updateMemoryChip(v) {
  const node = $('#g-memory');
  if (!node) return;
  const m = v && v.memory;
  if (!m) { node.classList.add('hidden'); return; }
  node.classList.remove('hidden');
  node.textContent = `🧠 AI 正在整理记忆…（${m.done}/${m.total}）`;
}

function seatLabel(seat) {
  const raw = state.seatNames[seat] || '';
  // 默认昵称就是"N号"时避免重复显示。
  // 安全（整改 SEC-02）：昵称是用户可控输入，seatLabel 的返回值只用于 innerHTML 模板，
  // 必须在源头转义，否则一个 <img onerror=...> 昵称就是持久化 DOM XSS。
  const name = escapeHtml(raw);
  return `${seat}号${name && name !== `${seat}号` ? ' ' + name : ''}`;
}

function roleInfo(rid) { return state.meta.roles[rid]; }

/** 角色卡图：assets/roles/<id>.<ext> 存在则用图，否则回退内置哥特占位卡。
 *  两种都套同一套手绘 SVG 金属框（card-frame.js）—— 缺图时也不该是一张没有装饰的裸框。 */
function roleArtHtml(rid) {
  const r = roleInfo(rid);
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  const face = ext
    ? `<img class="role-art" src="assets/roles/${rid}${ext}" alt="${r.name}">`
    : `<div class="role-art-fallback"><div class="fa-emoji">${r.emoji}</div><div class="fa-name">${r.name}</div></div>`;
  return `<div class="card-frame"${window.CardFrame.roleAttr(rid)}>${window.CardFrame.html()}${face}</div>`;
}

/** 检视模式：大卡 + 指针 3D 倾斜（复用 .card-frame，不再单独维护一份金属框 CSS） */
function openInspect(rid) {
  const r = roleInfo(rid);
  const stage = el('div', 'inspect-stage');
  const card = el('div', 'inspect-card card-frame');
  // 走 roleAttrs 原语而不是手写 data-role：它同时给出阵营（徽记按阵营换图形），
  // 只写 data-role 的话检视大卡会一直露狼爪
  Object.assign(card.dataset, window.CardFrame.roleAttrs(rid));
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  const frame = window.CardFrame.html();
  if (ext) {
    card.innerHTML = `${frame}<div class="inner"><img class="role-art" src="assets/roles/${rid}${ext}" alt="${r.name}">
      <div class="in-overlay"><div class="in-name gilt-name">${r.name}</div><div class="in-desc">${escapeHtml(r.short)}</div></div></div>`;
  } else {
    card.innerHTML = `${frame}<div class="in-body"><div class="in-emoji">${r.emoji}</div>
      <div class="in-name gilt-name">${r.name}</div>
      <div class="in-desc">${escapeHtml(r.short)}</div></div>`;
  }
  stage.appendChild(card);
  stage.appendChild(el('div', 'inspect-hint', '移动指针检视 · 点击任意处关闭'));
  stage.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / rect.width;
    const dy = (e.clientY - rect.top - rect.height / 2) / rect.height;
    card.style.transform = `rotateY(${(dx * 16).toFixed(2)}deg) rotateX(${(-dy * 14).toFixed(2)}deg)`;
  });
  stage.addEventListener('click', () => stage.remove());
  document.body.appendChild(stage);
}

/* ============================================================
   角色图鉴（渲染在共享模块 web/codex.js 里，桌面与手机同一份）
   ------------------------------------------------------------
   这里只负责：挂载点、开/关这一屏、把 meta 与本局在场人数递进去。
   为什么单独一屏而不是塞进规则书弹窗（弹窗里那一版仍在，只是简表）：
   图鉴是"边玩边查"的东西 —— 左边翻牌、右边看细节，不用在弹窗里滚动找；
   对局中从齿轮菜单进来也不会盖住牌桌。
   ============================================================ */
function showScreen(id) {
  document.querySelectorAll('#app > .screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
}

/** 本局在场人数：优先当前对局的板子，其次设置页选中的板子（都没有就返回空表 = 不加角标） */
function codexBoardCounts() {
  const v = state.view;
  if (v && v.board && v.board.roles) return v.board.roles;
  return state.setup.boardCounts || {};
}

function openCodex() {
  const cur = document.querySelector('#app > .screen:not(.hidden)');
  state.codexFrom = cur && cur.id !== 'screen-codex' ? cur.id : 'screen-setup';
  showScreen('screen-codex');
  window.Codex.mount({
    meta: state.meta,
    mode: 'panel',
    counts: codexBoardCounts,
    onInspect: openInspect,
    onRulebook: openRulebook,
  });
}

function closeCodex() {
  showScreen(state.codexFrom || 'screen-setup');
  // 回到对局时事件流要贴回底部：中间离开过一会儿，回来后停在半空很别扭
  if (state.codexFrom === 'screen-game') autoScroll();
}

function codexVisible() { return !$('#screen-codex').classList.contains('hidden'); }

function autoScroll() {
  const s = $('#stream');
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (nearBottom) s.scrollTop = s.scrollHeight;
}

function appendSys(text) { $('#stream').appendChild(el('div', 'sysline', text)); autoScroll(); }

/**
 * 推送通道状态条（P2-a）：唯一且会被更新的一个元素。
 * 原来断线时 appendSys 追加一条"已切换为轮询"，既不会被撤掉、重连成功也无从体现 ——
 * 横幅永久留在事件流里，玩家分不清"现在到底走的是推送还是轮询"。
 */
function setStreamStatus(text) {
  let n = document.getElementById('stream-status');
  if (!text) { if (n) n.remove(); return; }
  if (!n) { n = el('div', 'sysline'); n.id = 'stream-status'; $('#stream').appendChild(n); }
  if (n.textContent !== text) n.textContent = text;
  autoScroll();
}

function roleChipHtml(rid) {
  const r = roleInfo(rid);
  return `<span class="role-tag" style="color:${r.color}">${r.emoji} ${r.name}</span>`;
}

/**
 * 夜晚播报的"播放器"：服务端已把整夜的步骤**一次性**发来（播报与行动解耦，见
 * src/engine/flow.js 的 nightPhase），这里按固定间隔一条一条播，节奏与真实行动耗时无关。
 * 队列播完而夜晚还没结束（天没亮）→ 显示"等待其他玩家行动中"。
 */
// 夜间播报的间隔：用户实测反馈"播报太快了"，要求落在 10~30 秒之间并让**总播报时长不超过夜里
// 的实际行动时长**。默认板子一夜 6~8 步，12 秒/步 ≈ 72~96 秒；而一次真实的夜晚要跑 6~8 次
// 模型调用（实测整局约 28 分钟、单夜常在 2~5 分钟），所以 12 秒既够"一条条来"的仪式感，
// 又几乎不会播到天亮还没播完。要更慢就改这一个数。
const NIGHT_BROADCAST_GAP = 12000;

function clearNightWait() {
  const w = $('#night-wait');
  if (w) w.remove();
}

function showNightWait() {
  if ($('#night-wait')) return;
  const stream = $('#stream');
  const node = el('div', 'sysline', '⏳ 等待其他玩家行动中…');
  node.id = 'night-wait';
  stream.appendChild(node);
  autoScroll();
}

async function playNightBroadcast() {
  if (state.nightPlaying) return;
  state.nightPlaying = true;
  const stream = $('#stream');
  while (state.nightQueue && state.nightQueue.length) {
    const e = state.nightQueue.shift();
    state.lastNightStep = e.data; // 调试面板/观战要看"当前第几步"，随播放推进
    clearNightWait();
    const node = renderEventNode(e);
    if (node) stream.appendChild(node);
    autoScroll();
    await new Promise((r) => setTimeout(r, NIGHT_BROADCAST_GAP));
  }
  state.nightPlaying = false;
  // 播完但天没亮 → 行动还在跑（并发时很常见），如实告诉玩家在等谁
  if (state.nightOpen) showNightWait();
}

/**
 * 只读调试钩子（与现成的 window.__f5 同类）：给 ui-check 断言"播报是逐条播的、
 * 不是一次全出来"用。故意只读 —— 测试不许通过它改状态。
 */
window.__nightInfo = () => ({
  queue: (state.nightQueue || []).length,
  playing: !!state.nightPlaying,
  open: !!state.nightOpen,
  rendered: document.querySelectorAll('#stream .msg.event').length,
});

/**
 * 天亮时把还没播完的夜间播报立刻补齐。
 * 间隔改成 12 秒后，理论上存在"天亮了播报还没播完"的可能（真实夜晚通常 2~5 分钟，
 * 而 6~8 步 × 12 秒 ≈ 72~96 秒，所以极少触发）；一旦触发就立刻补完，
 * 宁可让补的几条排在"天亮"横幅之后，也不让夜间信息漏播或阴魂不散地一条条冒到白天。
 */
function flushNightBroadcast() {
  if (!state.nightQueue || !state.nightQueue.length) return;
  const stream = $('#stream');
  for (const e of state.nightQueue) {
    state.lastNightStep = e.data;
    const node = renderEventNode(e);
    if (node) stream.appendChild(node);
  }
  state.nightQueue = [];
  clearNightWait();
  autoScroll();
}

function appendEvents(events) {
  const stream = $('#stream');
  for (const e of events) {
    // 夜晚步骤先入队、不直接渲染：节奏归客户端管（旧版直接渲染 → 并发后几条同时冒出来）
    if (e.type === 'night_step') {
      state.nightQueue = state.nightQueue || [];
      state.nightQueue.push(e);
      continue;
    }
    // 私密投票进度：不渲染成消息（会刷屏），只更新状态供 renderLive 显示"已思考 N/M"。
    // 服务端只播报计数，不含任何目标/座位 —— 这里也不许把它写进聊天流。
    if (e.type === 'vote_progress') {
      const d = e.data || {};
      state.voteProgress = d.done < d.total ? { done: d.done, total: d.total, at: Date.now() } : null;
      continue;
    }
    if (e.type === 'vote_reveal' || e.type === 'phase' || e.type === 'game_over') state.voteProgress = null;
    const node = renderEventNode(e);
    if (node) stream.appendChild(node);
  }
  if (state.nightQueue && state.nightQueue.length) playNightBroadcast();
  autoScroll();
}

function renderEventNode(e) {
  const d = e.data || {};
  const priv = Array.isArray(e.visibleTo);
  const isMine = (ev) => state.view && state.view.me && ev.actor === state.view.me.seat;
  switch (e.type) {
    case 'phase': {
      const night = (d.title || '').includes('夜');
      // nightOpen 决定"夜晚播报播完后要不要显示等待其他玩家行动中"（天一亮就该收掉）
      state.nightOpen = night;
      if (!night) { clearNightWait(); flushNightBroadcast(); }
      state.voteTally = {}; // 进入新阶段：上一轮的票数不再有意义（否则桌角会挂着过期的票）
      if (state.lastView) updateSeats(state.lastView);
      return el('div', `banner ${night ? 'night' : ''}`, d.title || '');
    }
    case 'night_step': {
      const icons = { admirer: '💗', guard: '🛡️', dreamer: '🌙', wolf: '🐺', wolfbeauty: '💃', seer: '🔮', witch: '⚗️', crow: '🐦' };
      return el('div', 'msg event', `🕯 第${d.index}/${d.total}步 · ${icons[d.step] || ''} ${escapeHtml(d.label)}`);
    }
    case 'system':
      // 安全（SEC-02）：system 事件文本可能透传服务端消息，一律按文本转义
      return d.title ? el('div', 'sysline', `【${escapeHtml(d.title)}】${escapeHtml(e.text || '')}`) : el('div', 'sysline', escapeHtml(e.text || d.text || ''));
    case 'deaths': {
      const deaths = d.deaths || [];
      const rules = state.view && state.view.rules;
      const showCause = !rules || rules.revealOnDeath !== false; // 暗牌局只报死亡不报死因
      const text = deaths.length
        ? `天亮了。昨夜死亡：${deaths.map((x) => `${x.seat}号${showCause ? `（${causeLabel(x.cause)}）` : ''}`).join('、')}。`
        : '天亮了。昨夜是平安夜，无人死亡。';
      return el('div', `msg event ${deaths.length ? 'red' : 'green'}`, text);
    }
    case 'speech': {
      const tag = { wolf: '🔒 狼聊', lastwords: '🕯 遗言', sheriff: '🎩 警上', pk: '⚔️ PK' }[d.context] || '';
      const mine = state.view && state.view.me && e.actor === state.view.me.seat;
      const m = el('div', `msg ${d.context === 'wolf' ? 'wolf' : ''} ${priv ? 'private' : ''} ${mine ? 'right' : ''}`);
      m.appendChild(el('div', 'meta', `<span class="who">${seatLabel(e.actor)}</span> ${tag}`));
      m.appendChild(el('div', null, escapeHtml(d.text || '')));
      return m;
    }
    case 'role_reveal':
      return el('div', 'msg event', `${seatLabel(d.seat)} 的身份是 ${roleChipHtml(d.role)}`);
    case 'vote_reveal': {
      const detail = (d.votes || []).map((v) => `${v.seat}→${v.target || '弃'}${v.weight !== 1 ? `<small>×${v.weight}</small>` : ''}`).join('，');
      const tally = Object.entries(d.tally || {}).map(([s, n]) => `${s === '0' ? '弃票' : s + '号'}:${n}票`).join('，');
      const curse = d.curseBonus && Object.keys(d.curseBonus).length
        ? `（🐦 ${Object.keys(d.curseBonus).map((s) => s + '号').join('、')} 受乌鸦诅咒 +0.5）` : '';
      // 票数同时挂到圆桌上（座位角标 + 圆心合计）：亮票那一下直接"看得见"，不用回滚日志数
      state.voteTally = Object.assign({}, d.tally || {});
      if (state.lastView) setTimeout(() => { if (state.lastView) updateSeats(state.lastView); }, 0);
      return el('div', 'msg event', `🗳 亮票：${detail}<br><span class="hint">${tally}${curse}</span>`);
    }
    case 'sheriff_run':
      return d.run ? el('div', 'msg event', `🎩 ${seatLabel(e.actor)} 举手，上警竞选警长！`) : null;
    case 'sheriff_elected':
      return el('div', 'msg event green', `🎩 ${seatLabel(d.seat)} 当选警长！`);
    case 'sheriff_none':
      return el('div', 'msg event', '本局没有产生警长。');
    case 'duel':
      return el('div', 'msg event red', `⚔️ ${seatLabel(e.actor)}（骑士）翻牌发起决斗，指定 ${seatLabel(d.target)}！`);
    case 'explode':
      return el('div', 'msg event red', `💥 ${seatLabel(e.actor)} 自爆（狼人）${d.target ? `，带走了 ${seatLabel(d.target)}` : '，天黑了'}！`);
    case 'shoot':
      return d.target ? el('div', 'msg event red', `🔫 ${seatLabel(e.actor)} 开枪带走了 ${seatLabel(d.target)}！`)
        : el('div', 'msg event', `🔫 ${seatLabel(e.actor)} 没有开枪。`);
    case 'idiot_save':
      return el('div', 'msg event', `🃏 ${seatLabel(d.seat)} 是白痴，翻牌免疫放逐（之后不可投票）。`);
    case 'direction':
      return el('div', 'sysline', `${seatLabel(d.by)}（警长）决定从 ${d.startSeat}号 开始${d.direction === 'cw' ? '顺时针' : '逆时针'}发言`);
    case 'game_over': {
      if (d.winner === 'none') {
        const b = el('div', 'banner', `⏹ ${escapeHtml(d.reason || '对局已终止')}`);
        b.style.fontSize = '15px';
        return b;
      }
      const draw = d.winner === 'draw';
      const good = d.winner === 'good';
      const wrap = el('div');
      const b = el('div', `banner ${draw || good ? '' : 'night'}`, draw ? '🤝 平局（未分胜负）' : good ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
      b.style.fontSize = '16px';
      wrap.appendChild(b);
      const score = state.view && state.view.score;
      if (score && score.title) {
        const m = el('div', 'msg event', `🏆 ${escapeHtml(score.title)}`);
        const detail = score.rows.slice(0, 3).map((r) => `${r.seat}号 ${r.score}分`).join('，');
        m.appendChild(el('div', 'hint', `前三：${detail}`));
        wrap.appendChild(m);
      }
      return wrap;
    }
    // ---- 私密事件（只出现在自己/上帝视野；上帝视角按行动者显示） ----
    case 'deal': {
      const r = roleInfo(d.role);
      const mine = isMine(e);
      return el('div', 'msg private', `${mine ? '🔒 你的身份牌' : `🔒 ${seatLabel(d.seat || e.actor)} 的身份牌`}：${roleChipHtml(d.role)}<div class="hint" style="margin-top:4px">${r.short}</div>`);
    }
    case 'teammates': {
      const who = isMine(e) ? '你的' : `${seatLabel(e.actor)} 的`;
      return el('div', 'msg private wolf', `🔒 ${who}狼队：${(d.seats || []).map((s) => seatLabel(s)).join('、') || '无'}`);
    }
    case 'wolf_propose': {
      const suggest = d.target ? `（建议刀 ${d.target} 号）` : '';
      return el('div', 'msg private wolf', `🔒 ${seatLabel(e.actor)}${d.human ? '（你）' : ''}：${escapeHtml(d.text || '')}<span class="hint">${suggest}</span>`);
    }
    case 'wolf_kill_vote':
      return el('div', 'msg private wolf', `🔒 ${seatLabel(e.actor)} 投刀：${d.target ? seatLabel(d.target) : '空刀'}`);
    case 'wolf_kill':
      return el('div', 'msg private wolf', `🔒 狼队决定今晚袭击 ${d.target ? seatLabel(d.target) : '无人（空刀）'}`);
    case 'seer_check': {
      const who = isMine(e) ? '你' : seatLabel(e.actor);
      return el('div', 'msg private', `🔒 ${who}查验 ${seatLabel(d.target)}：${d.isWolf ? '🐺 狼人' : '✅ 好人'}`);
    }
    case 'witch_info': {
      const who = isMine(e) ? '今晚被袭击的是' : `${seatLabel(e.actor)}（女巫）得知被袭击的是`;
      return el('div', 'msg private', `🔒 ${who}：${d.killTarget ? seatLabel(d.killTarget) : '无人（空刀）'}`);
    }
    case 'witch_action': {
      const who = isMine(e) ? '用药' : `${seatLabel(e.actor)} 用药`;
      return el('div', 'msg private', `🔒 ${who}：${d.antidote ? `解药→${seatLabel(d.killTarget)}；` : ''}${d.poison ? `毒药→${seatLabel(d.poison)}` : ''}${!d.antidote && !d.poison ? '空过' : ''}`);
    }
    case 'night_guard': {
      const who = isMine(e) ? '你守护了' : `${seatLabel(e.actor)} 守护了`;
      return el('div', 'msg private', `🔒 ${who} ${d.target ? seatLabel(d.target) : '无人（空守）'}`);
    }
    case 'night_dream': {
      const who = isMine(e) ? '你摄梦了' : `${seatLabel(e.actor)}（摄梦人）摄梦了`;
      const warn = d.consecutive ? ' ⚠️ 连续两晚摄梦，他今夜将死亡' : '';
      return el('div', 'msg private', `🔒 ${who} ${seatLabel(d.target)}（梦游者当夜免疫刀/毒）${warn}`);
    }
    case 'wolfbeauty_charm': {
      const who = isMine(e) ? '你魅惑了' : `${seatLabel(e.actor)}（狼美人）魅惑了`;
      return el('div', 'msg private', `🔒 ${who} ${seatLabel(d.target)}`);
    }
    case 'crow_curse': {
      const who = isMine(e) ? '你诅咒了' : `${seatLabel(e.actor)}（乌鸦）诅咒了`;
      return el('div', 'msg private', `🔒 ${who} ${seatLabel(d.target)}（明日放逐投票 +0.5 票）`);
    }
    case 'admirer_crush': {
      const who = isMine(e) ? '你暗恋上了' : `${seatLabel(e.actor)}（暗恋者）暗恋上了`;
      return el('div', 'msg private', `🔒 ${who} ${seatLabel(d.target)}（胜负阵营终身绑定）`);
    }
    case 'vote_cast': {
      const who = isMine(e) ? '你' : seatLabel(e.actor);
      return el('div', 'msg private', `🔒 ${who}投给了 ${d.target ? seatLabel(d.target) : '弃票'}`);
    }
    case 'ai_reasoning': {
      const text = (d.text || '').slice(0, 900);
      return el('div', 'msg private', `💭 ${seatLabel(e.actor)} 的内心独白（${escapeHtml(d.task || '')}）<div class="hint" style="margin-top:4px;white-space:pre-wrap">${escapeHtml(text)}${(d.text || '').length > 900 ? '…' : ''}</div>`);
    }
    case 'ai_thinking':
    case 'await_input':
    case 'llm_error':
      return null;
    default:
      return e.text ? el('div', 'sysline', e.text) : null;
  }
}

function causeLabel(cause) {
  return { wolf_kill: '被袭击', poison: '被毒杀', vote_out: '被放逐', shot: '被枪带走', explode_self: '自爆', explode_target: '被自爆带走', dream: '被连摄而亡', dream_follow: '梦随出局', charm_follow: '殉情出局', duel_win: '被决斗出局', duel_fail: '决斗谢罪' }[cause] || cause;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** 阶段 → 氛围配色（body[data-phase]）。CSS 据此切换天空/月亮/提示色。
 *  这是**功能指示**而不只是装饰：白天暖、夜晚冷、投票血红，玩家不必读文字就知道现在是什么阶段。 */
const PHASE_AMBIENT = {
  night: 'night', dawn: 'day', day: 'day', vote: 'vote', pk: 'vote',
  sheriff: 'vote', night_action: 'night', dusk: 'dusk', over: 'dusk',
};

function updateHeader(v) {
  $('#g-day').textContent = `第${v.day}天`;
  $('#g-phase').textContent = PHASE_LABEL[v.phase] || v.phase;
  document.body.dataset.phase = PHASE_AMBIENT[v.phase] || 'dusk';
  // 天数牌下沿的 DAY/NIGHT：与氛围同源，避免"画面是白天、文字说夜晚"的自相矛盾
  const kick = $('#g-day-kicker');
  if (kick) {
    const night = document.body.dataset.phase === 'night';
    kick.textContent = v.day === 0 ? 'SETUP' : (night ? 'NIGHT' : 'DAY');
  }
  const me = v.me;
  $('#g-me').innerHTML = me && me.role
    ? `你是 ${me.seat}号 ${escapeHtml(me.name)} · ${roleChipHtml(me.role)}${me.isSheriff ? ' 👑警长' : ''}${me.alive ? '' : ' 💀'}`
    : (state.godMode ? '上帝视角' : '');
  // 存活计：剩 3 人以下变红闪（那是"要收尾了"的强信号）
  const meter = $('#g-alive');
  if (meter && Array.isArray(v.players)) {
    const alive = v.players.filter((p) => p.alive).length;
    meter.innerHTML = `存活 <b>${alive}</b> / ${v.players.length}`;
    meter.classList.toggle('low', alive <= 3);
  }
}

function updateSeats(v) {
  const box = $('#seats');
  const mySeat = v.me ? v.me.seat : 0;
  // 同步上帝面板的座位下拉（AI 座位）
  const godSel = $('#god-seat');
  if (state.godMode && Number(godSel.dataset.count) !== v.players.length) {
    godSel.dataset.count = v.players.length;
    godSel.innerHTML = '';
    for (const p of v.players) {
      if (p.isHuman) continue;
      // 安全（SEC-02）：昵称用户可控，option 文本也要转义
      godSel.appendChild(el('option', null, `${p.seat}号 ${escapeHtml(p.name)}`)).value = p.seat;
    }
  }
  // ---- 圆桌 ----
  box.innerHTML = '';   // 必须先清空：漏掉这一行会每帧追加一张新桌子，圆心文字叠成一团（踩过）
  //
  // 布局：座位按椭圆均分，坐标在 JS 里算好写成 --x/--y（百分比）。
  // 为什么不用 CSS 的 sin()/cos()：部分 WebView 没有这两个函数，退化后所有座位会叠在圆心
  // （"看着像只有一个人"这种错最难查）。JS 算一次、CSS 只负责摆，任何环境都是同一张桌子。
  //
  // 圆心放"阶段牌"：天数/阶段/轮到谁/亮票票数。视线中心是当前状态，而不是一片空白。
  state.lastView = v;
  const liveSeat = v.live && v.live.seat ? Number(v.live.seat) : 0;
  const tally = state.voteTally || {};
  const voteChips = Object.entries(tally)
    .filter(([, k]) => k > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([s, k]) => `<span>${s === '0' ? '弃票' : s + '号'} ${k}</span>`);
  const ring = el('div', 'ring-stage');
  ring.appendChild(ringSvg());
  const core = el('div', 'ring-core');
  const aliveNow = v.players.filter((p) => p.alive).length;
  const liveWho = liveSeat ? `${liveSeat}号 ${escapeHtml(String(state.seatNames[liveSeat] || '').trim())} 正在行动…` : '';
  core.innerHTML = `<div class="rc-phase">第${v.day}天</div>`
    + `<div class="rc-sub">${escapeHtml(PHASE_LABEL[v.phase] || v.phase || '')} · 存活 ${aliveNow}/${v.players.length}</div>`
    + (liveWho ? `<div class="rc-live">${liveWho}</div>` : '')
    + (voteChips.length ? `<div class="rc-vote">${voteChips.join('')}</div>` : '');
  ring.appendChild(core);

  const n = v.players.length || 1;
  const portraits = window.AICast ? window.AICast.assignPortraits(v.players) : new Map();
  v.players.forEach((p, i) => {
    // -90° 起（正上方），顺时针铺开；半径按人数微调（人越多越贴边，避免互相压住）
    const ang = (-90 + (360 / n) * i) * Math.PI / 180;
    const rad = n > 10 ? 43 : 40;
    const s = el('div', 'seat');
    s.style.setProperty('--x', `${(Math.cos(ang) * rad).toFixed(2)}%`);
    s.style.setProperty('--y', `${(Math.sin(ang) * rad).toFixed(2)}%`);
    s.dataset.seat = p.seat;
    if (!p.alive) s.classList.add('dead');
    if (p.seat === mySeat) s.classList.add('mine');
    if (p.isSheriff) s.classList.add('sheriff');
    // 当前正在行动/发言的人：让"轮到谁"一眼可见（这一条替代了原来那行"等待 5 号思考"的文字）
    if (liveSeat && liveSeat === p.seat) s.classList.add('speaking');
    // 选目标状态：可选的人给虚线环 + 手型；已选的给血红实环
    const canPick = actionState.needTarget && actionState.candidates.includes(p.seat);
    if (canPick) s.classList.add('targetable');
    if (canPick && actionState.target === p.seat) s.classList.add('picked');
    // 已知身份：头像**右下角**一枚小徽记（整块文字 chip 会把座位撑高 18px，12 人局直接撞成一团；
    // 挂在 .snum 里面而不是座位外层，才不会压住下面的昵称），同时把头像圆染成阵营色。
    const info = p.role ? roleInfo(p.role) : null;
    const roleHtml = info
      ? `<span class="role-chip" style="color:${info.color}" title="${info.emoji}${info.name}">${info.emoji}</span>` : '';
    const badges = `${p.isSheriff ? '<span class="badge" title="警长">👑</span>' : ''}${p.lostVote ? '<span class="badge" title="失去投票权">🚫</span>' : ''}`;
    const votes = tally[p.seat];
    s.innerHTML = `<span class="snum"${info ? ` style="border-color:${info.color}"` : ''}><span class="seat-index">${p.seat}</span>${badges}${roleHtml}${votes ? `<span class="votecount">${votes}</span>` : ''}</span>`
      + `<span class="sname">${escapeHtml(p.name)}${p.seat === mySeat ? '（你）' : ''}</span>`;
    if (window.AICast) window.AICast.decorate(s.querySelector('.snum'), portraits.get(p.seat));
    s.title = `${p.seat}号 ${p.name}${p.alive ? '' : '（已出局）'}${p.isSheriff ? ' · 警长' : ''}${info ? ` · ${info.name}` : ''}${canPick ? ' · 点击选为目标' : ''}`;
    // 点座位 = 选目标（与手机端同一套交互：目标类任务时座位本身就是按钮）
    if (canPick) s.addEventListener('click', () => selectTarget(p.seat));
    // 身份标注（NOTE-03）：常显入口（不能只在 hover 出现——计划 §4.3），与目标选择是兄弟节点并阻止冒泡
    const taggable = v.me && !state.godMode && p.alive && !p.revealed && p.seat !== v.me.seat;
    if (taggable) {
      const btn = el('button', 'btn small ghost tag-btn', '🏷');
      btn.title = '编辑 TA 的私人笔记（AI 看不到）';
      btn.setAttribute('aria-label', `${p.seat}号私人笔记`);
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); openTagModal(p.seat); });
      s.appendChild(btn);
    }
    // 我的标注角标：倾向/候选摘要（真身公开后 role-chip 已展示真身，不重复）
    if (!p.role) {
      const sum = seatTagSummary(p.seat);
      if (sum) {
        const chip = el('span', 'role-chip tag-chip', `🏷${escapeHtml(sum)}`);
        chip.title = '我的私人笔记摘要（AI 看不到）';
        s.appendChild(chip);
      }
    }
    ring.appendChild(s);
  });
  box.appendChild(ring);
}

/** 桌沿内侧的刻度盘（纯装饰）。
 *  半径必须落在**圆心牌之外、座位之内**：座位圆心在 43%，圆心牌约占 23%，
 *  所以刻度取 30~33%。早先画在 42~44.5% 时，72 根刻线正好穿过每个头像和名字，整张桌子很脏。 */
function ringSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ring-line');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 72; i++) {
    const a = (i * 5) * Math.PI / 180;
    const r1 = 33, r2 = i % 6 === 0 ? 30.5 : 32; // 每 30° 一根长刻线，其余短刻线
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', (50 + Math.cos(a) * r1).toFixed(2));
    ln.setAttribute('y1', (50 + Math.sin(a) * r1).toFixed(2));
    ln.setAttribute('x2', (50 + Math.cos(a) * r2).toFixed(2));
    ln.setAttribute('y2', (50 + Math.sin(a) * r2).toFixed(2));
    ln.setAttribute('stroke', i % 6 === 0 ? 'rgba(216,178,95,.3)' : 'rgba(146,174,235,.12)');
    ln.setAttribute('stroke-width', i % 6 === 0 ? '0.45' : '0.26');
    svg.appendChild(ln);
  }
  return svg;
}

/** 点圆桌选目标。必须先校验候选范围 —— 越界的座位会提交非法目标（与手机端 onSeatTap 同一约定）。 */
function selectTarget(seat) {
  if (!actionState.needTarget || !actionState.candidates.includes(seat)) return;
  actionState.target = seat;
  if (state.lastView) updateSeats(state.lastView);
  // 同步底部胶囊的高亮：两处选择器必须永远一致，否则会出现"桌上选了 5 号、底下还亮着 3 号"
  document.querySelectorAll('#action-controls .chip').forEach((c) => {
    c.classList.toggle('sel', Number(c.dataset.seat) === seat);
  });
}

// ---------------- 操作区 ----------------
// needTarget/candidates：让圆桌上的座位也能当目标按钮用（与底部胶囊共享同一份候选范围）
let actionState = { target: 0, explode: false, withdraw: false, antidote: false, poison: 0, needTarget: false, candidates: [] };

function updateActionbar(v) {
  const hint = $('#pending-hint');
  const box = $('#action-controls');
  const p = v.pending;
  // 每一帧先撤销"可点目标"状态：真正带目标的控件会在 targetPicker 里重新置上。
  // 不清会导致上一轮的目标（比如"守护 3 号"）残留在这一轮，圆桌上出现一堆不该点亮的虚线环。
  actionState.needTarget = false;
  actionState.candidates = [];
  if (!p && v.wolfTalk && v.wolfTalk.active) {
    // 狼队讨论进行中：常驻插话栏（不因轮询重建，保护正在输入的文字）
    const sig = `wt:${v.wolfTalk.round}/${v.wolfTalk.rounds}`;
    if (box.dataset.task !== sig) {
      box.dataset.task = sig;
      box.innerHTML = '';
      hint.className = 'pending-hint';
      hint.textContent = `🌙 狼队频道讨论中（第 ${v.wolfTalk.round}/${v.wolfTalk.rounds} 轮）：你可以随时插话，或给 AI 队友加一轮（立即生效）`;
      const ta = el('textarea');
      ta.placeholder = '插话给狼队队友…（例如：都别空刀，我建议刀 8 号，他像是女巫）';
      ta.style.minHeight = '44px';
      const btnRow = el('div', 'btnrow');
      const say = el('button', 'btn primary', '插话');
      say.addEventListener('click', () => wolfTalkAction('say', ta.value.trim(), ta));
      const extra = el('button', 'btn', `+1 轮（当前 ${v.wolfTalk.rounds} 轮）`);
      extra.addEventListener('click', () => wolfTalkAction('extra'));
      const end = el('button', 'btn danger', '结束讨论，开始投刀');
      end.addEventListener('click', () => wolfTalkAction('end'));
      btnRow.append(say, extra, end);
      box.append(ta, btnRow);
    } else {
      // 仅刷新按钮上的轮数文案
      const extra = box.querySelector('.btnrow button:nth-child(2)');
      if (extra) extra.textContent = `+1 轮（当前 ${v.wolfTalk.rounds} 轮）`;
    }
    return;
  }
  if (!p) {
    const finished = v.finished;
    hint.className = 'pending-hint waiting';
    hint.textContent = finished ? '对局已结束。' : (queuedInterruptText(v) || waitingText(v));
    box.innerHTML = '';
    mountExplodeBtn(v, box);
    mountDuelBtn(v, box);
    if (finished && !box.dataset.done) {
      box.dataset.done = '1';
      const b = el('button', 'btn primary', '回到首页');
      b.addEventListener('click', backHome);
      box.appendChild(b);
    }
    return;
  }
  box.dataset.done = '';
  hint.className = 'pending-hint';
  hint.textContent = '⏳ 轮到你了（无时间限制，想好再发）';
  if (box.dataset.task === p.task + JSON.stringify(p.candidates || '') + String(p.extra ? p.extra.killTarget : '')) return;
  actionState = { target: 0, explode: false, withdraw: false, antidote: false, poison: 0, needTarget: false, candidates: [] };
  box.innerHTML = '';
  box.dataset.task = p.task + JSON.stringify(p.candidates || '') + String(p.extra ? p.extra.killTarget : '');
  buildActionUI(v, p, box);
  if (p.task !== 'speech') mountExplodeBtn(v, box);
  mountDuelBtn(v, box);
}

// ---------------- 常驻角色卡（我的身份/任务/策略） ----------------
function renderMyRoleCard(v) {
  const box = $('#my-role-card');
  if (!box) return;
  if (!v.me || !v.me.role || v.phase === 'setup') { box.classList.add('hidden'); return; }
  const sig = `${v.me.role}/${v.me.alive}/${v.me.isSheriff}`;
  if (box.dataset.sig === sig) { box.classList.remove('hidden'); return; }
  box.dataset.sig = sig;
  const r = roleInfo(v.me.role);
  box.classList.remove('hidden');
  const ext = state.meta.roleArt && state.meta.roleArt[v.me.role];
  // 与翻牌 / 检视 / 图鉴共用同一套手绘 SVG 框。
  // 这里原来直接塞一张裸 <img>（全站唯一没有卡框的角色卡），同一个"角色卡"有两套视觉。
  const face = ext
    ? `<img class="role-art" src="assets/roles/${v.me.role}${ext}" alt="">`
    : `<div class="role-art-fallback"><div class="fa-emoji">${r.emoji}</div></div>`;
  box.innerHTML = `
    <div class="mrc-art"><div class="card-frame"${window.CardFrame.roleAttr(v.me.role)}>${window.CardFrame.html()}${face}</div></div>
    <div class="mrc-info">
      <div class="mrc-role" style="color:${r.color}">${r.emoji} ${r.name}</div>
      <div class="mrc-sub">${v.me.seat}号 · ${v.me.alive ? '存活' : '出局'}${v.me.isSheriff ? ' · 👑警长' : ''}</div>
      <div class="btnrow">
        <button class="btn small ghost" id="mrc-inspect" title="检视卡牌">🔍</button>
        <button class="btn small ghost" id="mrc-task" title="查看任务">📋</button>
        <button class="btn small ghost" id="mrc-strategy" title="查看策略卡">🧭</button>
      </div>
    </div>`;
  $('#mrc-inspect').addEventListener('click', () => openInspect(v.me.role));
  $('#mrc-task').addEventListener('click', () => openMyTask(v));
  $('#mrc-strategy').addEventListener('click', () => openStrategy(v.me.role));
}

function openMyTask(v) {
  const me = v.me; const r = roleInfo(me.role);
  const win = r.team === 'wolf'
    ? '🐺 狼阵营目标：屠边获胜——把所有神职或所有平民都送出局。'
    : '🌱 好人阵营目标：放逐场上所有狼人即获胜。';
  const mates = me.teammates && me.teammates.length ? `<p>🐺 你的狼队队友：${me.teammates.join('、')} 号（夜晚狼队频道可商议）</p>` : '';
  const wrap = el('div');
  wrap.innerHTML = `<div class="mhead"><h2>📋 你的任务</h2></div><div class="mbody">
    <p><b style="color:${r.color}">${r.emoji} ${r.name}</b> · 你是 ${me.seat} 号（${me.alive ? '存活' : '出局'}${me.isSheriff ? ' · 警长' : ''}）</p>
    <p>${escapeHtml(r.description)}</p>${mates}
    <p>${win}</p>
    <p class="hint">小贴士：点角色卡上的 🧭 策略 可查看参考打法。</p>
  </div>`;
  openModal(wrap);
}

function openStrategy(rid) {
  const list = (state.meta.roleStrategies || {})[rid] || [];
  const r = roleInfo(rid);
  const wrap = el('div');
  wrap.innerHTML = `<div class="mhead"><h2>🧭 ${r.name} · 策略参考</h2></div><div class="mbody">
    <p class="hint">以下打法供参考，可灵活应变，不必照搬。</p>
    ${list.map((t) => `<p><b>【${t.name}】</b>${escapeHtml(t.text)}</p>`).join('') || '<p>暂无策略卡。</p>'}
  </div>`;
  openModal(wrap);
}

// ---------------- 骑士随时决斗（白天任意时刻） ----------------
function canDuelNow(v) {
  return !!(v && v.me && v.me.alive && !v.finished && v.me.role === 'knight'
    && !v.pending // 轮到自己操作时不显示打断按钮（引擎正等你的操作，打断不会生效）
    && ['speech', 'vote', 'pk'].includes(v.phase)); // 白天任意时刻，警长竞选不可
}

/** 已排队未生效的打断请求提示（优先级高于普通等待文案，防误以为没提交上/卡死） */
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
    $('#pending-hint').textContent = '⚔️ 决斗请求已提交，将在当前发言结束后的间隙生效…';
  } catch (e) { $('#pending-hint').textContent = `✗ ${e.message}`; }
}

function mountDuelBtn(v, box) {
  if (!canDuelNow(v) || box.querySelector('.duel-now-btn')) return;
  const b = el('button', 'btn danger duel-now-btn', '⚔️ 随时决斗');
  b.title = '骑士白天随时可决斗：决中狼人入夜，决错以死谢罪';
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
  const g = state.game;
  let target = 0;
  if (v.me.role === 'whitewolfking') {
    const aliveSeats = v.players.filter((p) => p.alive && p.seat !== v.me.seat).map((p) => p.seat);
    const t = Number(window.prompt('白狼王自爆将带走一名玩家。请输入座位号：' + aliveSeats.join('、')));
    if (!aliveSeats.includes(t)) return;
    target = t;
  } else if (!window.confirm('确定随时自爆？将公开狼人身份并立即进入黑夜（在当前发言结束后的间隙生效）。')) return;
  try {
    await api('POST', `/api/games/${g.gameId}/explode`, { token: g.playerToken, target });
    $('#pending-hint').textContent = '🔮 自爆请求已提交，将在当前发言结束后的间隙生效…';
  } catch (e) { $('#pending-hint').textContent = '✗ ' + e.message; }
}

function mountExplodeBtn(v, box) {
  if (!canExplodeNow(v) || box.querySelector('.explode-now-btn')) return;
  const b = el('button', 'btn danger explode-now-btn', '🔮 随时自爆');
  b.title = '狼人白天随时可自爆：公开身份、立即天黑';
  b.addEventListener('click', () => confirmExplode(v));
  box.appendChild(b);
}

function waitingText(v) {
  if (v.phase === 'night' && state.lastNightStep) {
    return `🌙 夜晚 · ${state.lastNightStep.label}（${state.lastNightStep.index}/${state.lastNightStep.total}）—— AI 们正在行动…`;
  }
  switch (v.phase) {
    case 'night': return '🌙 夜晚进行中，AI 们正在行动…';
    case 'sheriff': return '🎩 警长竞选进行中…';
    case 'speech': return '💬 白天发言进行中…';
    case 'vote': case 'pk': return '🗳 投票进行中…';
    case 'dawn': return '🌅 天亮结算中…';
    default: return '等待游戏推进…';
  }
}

function chipSeat(seat, extraCls) {
  const nm = state.seatNames[seat] || '';
  const label = nm && nm !== `${seat}号` ? `${seat}<small>${escapeHtml(nm)}</small>` : `${seat}号`;
  const c = el('button', `chip ${extraCls || ''}`, label);
  c.dataset.seat = seat;
  c.addEventListener('click', () => {
    actionState.target = seat;
    [...c.parentElement.children].forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
    if (state.lastView) updateSeats(state.lastView); // 圆桌同步点亮（见 selectTarget）
  });
  return c;
}

function targetPicker(candidates, opts = {}) {
  const wrap = el('div', null);
  wrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  for (const s of candidates || []) wrap.appendChild(chipSeat(s));
  if (opts.noneLabel) {
    const none = el('button', 'chip', opts.noneLabel);
    none.addEventListener('click', () => {
      actionState.target = 0;
      [...wrap.children].forEach((x) => x.classList.remove('sel'));
      none.classList.add('sel');
      if (state.lastView) updateSeats(state.lastView);
    });
    wrap.appendChild(none);
  }
  // 候选范围上交给 actionState：圆桌上的座位据此变成可点目标（两处入口，一份状态）
  actionState.needTarget = true;
  actionState.candidates = (candidates || []).slice();
  if (state.lastView) updateSeats(state.lastView);
  return wrap;
}

/**
 * 目标必选的决策：没选就提交会静默变成 target=0（空刀/空守/空枪），而玩家以为自己投过了。
 * 实测踩过：狼队"投刀"时有人没点座位，只剩 2:1 才保住刀口 —— 提交的是空刀，界面上却看不出。
 * confirmBtn 会捕获这里抛出的错误并显示在提示行，所以玩家得到的是明确的"请先选目标"，而不是一次假提交。
 */
function pickedTarget(label) {
  if (!actionState.target) throw new Error(`请先点一个座位选出${label || '目标'}`);
  return actionState.target;
}

function confirmBtn(text, buildPayload) {
  const b = el('button', 'btn primary', text || '确认');
  b.addEventListener('click', async () => {
    try {
      const payload = buildPayload();
      await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload });
      $('#action-controls').innerHTML = '';
      $('#action-controls').dataset.task = '';
      $('#pending-hint').textContent = '已提交 ✓';
    } catch (e) {
      $('#pending-hint').textContent = `✗ ${e.message}`;
    }
  });
  return b;
}

function speechArea(placeholder) {
  const ta = el('textarea');
  ta.placeholder = placeholder || '输入你的发言…（无时间限制）';
  return ta;
}

function buildActionUI(v, p, box) {
  const me = v.me || {};
  switch (p.task) {
    case 'speech':
    case 'pk_speech':
    case 'lastwords':
    case 'sheriff_speech': {
      const labels = { speech: '轮到你发言', pk_speech: '平票 PK 发言', lastwords: '请留遗言', sheriff_speech: '警长竞选演讲' };
      $('#pending-hint').textContent = `⏳ ${labels[p.task]}（无时间限制）`;
      const ta = speechArea();
      box.appendChild(ta);
      if (p.canExplode) {
        const ex = el('label', 'checkline', '<input type="checkbox"> 自爆（公开狼身份，立即天黑）');
        const cb = ex.querySelector('input');
        let targetPick = null;
        cb.addEventListener('change', () => {
          actionState.explode = cb.checked;
          if (cb.checked && me.role === 'whitewolfking') {
            targetPick = targetPicker(v.players.filter((x) => x.alive && x.seat !== me.seat).map((x) => x.seat));
            box.insertBefore(targetPick, btnRow);
          } else if (targetPick) { targetPick.remove(); targetPick = null; }
        });
        box.appendChild(ex);
      }
      if (p.canWithdraw) {
        const wd = el('label', 'checkline', '<input type="checkbox"> 退水（退出竞选）');
        wd.querySelector('input').addEventListener('change', (e) => { actionState.withdraw = e.target.checked; });
        box.appendChild(wd);
      }
      const btnRow = el('div', 'btnrow');
      const send = confirmBtn(p.task === 'lastwords' ? '留下遗言' : '发送发言', () => {
        const payload = { text: ta.value.trim() };
        if (p.canExplode && actionState.explode) {
          payload.explode = true;
          if (me.role === 'whitewolfking') payload.target = actionState.target;
        }
        if (p.task === 'sheriff_speech') payload.withdraw = actionState.withdraw;
        return payload;
      });
      btnRow.appendChild(send);
      box.appendChild(btnRow);
      break;
    }
    case 'wolf_propose': {
      $('#pending-hint').textContent = '⏳ 狼队频道：表态今晚刀谁（仅狼队可见）';
      const ta = speechArea('简短表态，如：刀 5 号，他发言太差…');
      box.appendChild(ta);
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('发送', () => ({ text: ta.value.trim() })));
      box.appendChild(btnRow);
      break;
    }
    case 'wolf_say': {
      // 按序轮到玩家的发言轮：可发言，可跳过
      $('#pending-hint').textContent = '⏳ 狼队讨论·轮到你发言（可以选择不发言，无时间限制）';
      const ta = speechArea('轮到你了：表态/带节奏/统一刀口…（留空或点跳过=不发话）');
      box.appendChild(ta);
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('发言', () => ({ text: ta.value.trim() })));
      const skip = el('button', 'btn', '跳过本轮');
      skip.addEventListener('click', () => submitSimple({ text: '' }));
      btnRow.appendChild(skip);
      box.appendChild(btnRow);
      break;
    }
    case 'night_guard': {
      $('#pending-hint').textContent = '⏳ 守卫行动：选择今晚守护对象';
      box.appendChild(targetPicker(p.candidates, { noneLabel: '空守' }));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认守护', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    case 'night_dream': {
      $('#pending-hint').textContent = '⏳ 摄梦人：选择今晚的摄梦对象（梦游者当夜免疫刀/毒；连摄两晚同一人则其死亡）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认摄梦', () => ({ target: pickedTarget('摄梦对象') })));
      box.appendChild(btnRow);
      break;
    }
    case 'wolfbeauty_charm': {
      $('#pending-hint').textContent = '⏳ 狼美人：选择今晚的魅惑对象（你出局时他殉情，骑士决斗除外）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认魅惑', () => ({ target: pickedTarget('魅惑对象') })));
      box.appendChild(btnRow);
      break;
    }
    case 'crow_curse': {
      $('#pending-hint').textContent = '⏳ 乌鸦：选择今晚的诅咒对象（明日放逐投票他+0.5票）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认诅咒', () => ({ target: pickedTarget('诅咒对象') })));
      box.appendChild(btnRow);
      break;
    }
    case 'admirer_crush': {
      $('#pending-hint').textContent = '⏳ 暗恋者：暗选你的暗恋对象（胜负阵营与他终身绑定，对方不知情）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认心动', () => ({ target: pickedTarget('暗恋对象') })));
      box.appendChild(btnRow);
      break;
    }
    case 'wolf_kill': {
      $('#pending-hint').textContent = '⏳ 狼队投票：选择今晚的刀口';
      box.appendChild(targetPicker(p.candidates, { noneLabel: p.allowNone ? '空刀' : null }));
      const btnRow = el('div', 'btnrow');
      // F5 修复（P4 实测缺口）：allowNone 时原先直接提交 actionState.target，
      // 于是"什么都没选"（null/undefined）与"显式点空刀"（0）无法区分 ——
      // 玩家点「投刀」既不报错也没有任何提示，只能干瞪眼。
      // 现在：未选目标 → 抛出可读提示（由 confirmBtn 的 catch 显示到 #pending-hint）；
      //       显式空刀（0）与正常目标照旧提交，空刀按钮的行为完全不变。
      btnRow.appendChild(confirmBtn('投刀', () => {
        if (actionState.target === null || actionState.target === undefined) {
          throw new Error(p.allowNone ? '请先点一个座位选出刀口（想放弃本夜就点「空刀」）' : '请先点一个座位选出刀口');
        }
        return { target: actionState.target };
      }));
      box.appendChild(btnRow);
      break;
    }
    case 'seer_check': {
      $('#pending-hint').textContent = '⏳ 预言家：选择今晚查验对象';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('查验', () => ({ target: pickedTarget('查验对象') })));
      box.appendChild(btnRow);
      break;
    }
    case 'witch': {
      const ex = p.extra || {};
      $('#pending-hint').textContent = `⏳ 女巫用药（每晚限一瓶）`;
      if (ex.canAntidote) {
        const saveBtn = el('button', 'btn', `💊 用解药救 ${ex.killTarget} 号`);
        saveBtn.addEventListener('click', async () => {
          try {
            await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload: { antidote: true, poison: 0 } });
            $('#action-controls').innerHTML = ''; $('#action-controls').dataset.task = '';
          } catch (e) { $('#pending-hint').textContent = `✗ ${e.message}`; }
        });
        box.appendChild(saveBtn);
      }
      if (ex.canPoison) {
        box.appendChild(el('span', 'hint', '或选择毒杀：'));
        box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat)));
        const btnRow = el('div', 'btnrow');
        btnRow.appendChild(confirmBtn('☠️ 使用毒药', () => ({ antidote: false, poison: actionState.target })));
        box.appendChild(btnRow);
      }
      const skip = el('button', 'btn ghost', '空过（都不用）');
      skip.addEventListener('click', async () => {
        try {
          await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload: { antidote: false, poison: 0 } });
          $('#action-controls').innerHTML = ''; $('#action-controls').dataset.task = '';
        } catch (e) { $('#pending-hint').textContent = `✗ ${e.message}`; }
      });
      box.appendChild(skip);
      break;
    }
    case 'sheriff_run': {
      $('#pending-hint').textContent = '⏳ 警长竞选：是否上警？';
      const run = el('button', 'btn primary', '🎩 上警');
      const norun = el('button', 'btn', '不上警');
      run.addEventListener('click', () => submitSimple({ run: true }));
      norun.addEventListener('click', () => submitSimple({ run: false }));
      box.append(run, norun);
      break;
    }
    case 'direction': {
      $('#pending-hint').textContent = '⏳ 警长：决定今天发言方向';
      const cw = el('button', 'btn primary', '顺时针');
      const ccw = el('button', 'btn', '逆时针');
      cw.addEventListener('click', () => submitSimple({ direction: 'cw' }));
      ccw.addEventListener('click', () => submitSimple({ direction: 'ccw' }));
      box.append(cw, ccw);
      break;
    }
    case 'badge_pass': {
      $('#pending-hint').textContent = '⏳ 警长离场：移交警徽或撕毁';
      box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat)));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('移交给该玩家', () => ({ target: pickedTarget('接任警长') })));
      const tear = el('button', 'btn danger', '撕毁警徽');
      tear.addEventListener('click', () => submitSimple({ target: 0 }));
      btnRow.appendChild(tear);
      box.appendChild(btnRow);
      break;
    }
    case 'vote': case 'pk_vote': case 'sheriff_vote': {
      const labels = { vote: '放逐投票', pk_vote: 'PK 投票（限投 PK 者）', sheriff_vote: '警长竞选投票' };
      $('#pending-hint').textContent = `⏳ ${labels[p.task]}（互相保密）`;
      box.appendChild(targetPicker(p.candidates, { noneLabel: p.allowNone ? '弃票' : null }));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('投票', () => ({ target: p.allowNone ? actionState.target : pickedTarget('投票对象') })));
      box.appendChild(btnRow);
      break;
    }
    case 'shoot': {
      $('#pending-hint').textContent = '⏳ 开枪技能：选择带走目标';
      box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat), { noneLabel: '不开枪' }));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('开枪', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    default:
      box.appendChild(el('span', 'hint', `未知任务：${p.task}`));
  }
}

async function wolfTalkAction(kind, text, ta) {
  try {
    if (kind === 'say' && !text) { $('#pending-hint').textContent = '✗ 插话内容不能为空'; return; }
    const r = await api('POST', `/api/games/${state.game.gameId}/wolftalk`, { token: state.game.playerToken, kind, text });
    if (kind === 'say' && ta) ta.value = '';
    $('#pending-hint').textContent = kind === 'say' ? '已发送 ✓'
      : kind === 'extra' ? `已追加，当前 ${r.wolfTalk.rounds} 轮 ✓` : '已通知结束讨论 ✓';
  } catch (e) { $('#pending-hint').textContent = `✗ ${e.message}`; }
}

async function submitSimple(payload) {
  try {
    await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload });
    $('#action-controls').innerHTML = ''; $('#action-controls').dataset.task = '';
    $('#pending-hint').textContent = '已提交 ✓';
  } catch (e) { $('#pending-hint').textContent = `✗ ${e.message}`; }
}

// ---------------- 身份翻牌 ----------------
function maybeShowRole(v) {
  if (state.roleShown || !v.me || !v.me.role || v.finished || v.phase === 'setup') return; // 已结束的对局直接看结算，不再播翻牌
  if (v.day === 0 && !v.events.length) return;
  state.roleShown = true;
  const r = roleInfo(v.me.role);
  $('#flip-front').innerHTML = `
    ${roleArtHtml(v.me.role)}
    <div class="r-name gilt-name">${r.name}</div>`;
  $('#flip-caption').innerHTML = `
    <div class="r-desc">${r.short}</div>
    ${v.me.teammates && v.me.teammates.length ? `<div class="r-desc tm">狼队：${v.me.teammates.join('、')} 号</div>` : ''}`;
  const overlay = $('#role-overlay');
  overlay.classList.remove('hidden');
  const card = $('#flip-card');
  card.classList.remove('flipped');
  card.onclick = () => card.classList.add('flipped');
  $('#btn-flip-done').onclick = () => overlay.classList.add('hidden');
  $('#btn-inspect').onclick = () => openInspect(v.me.role);
}

// ---------------- 规则书 ----------------
function openModal(inner) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal');
  // ⚠ 与手机端同样的坑：把调用方的容器整包塞进来，会让 .mhead/.mbody 变成"孙子"，
  // flex 高度约束传不到正文，正文撑到真实高度后滚不动（规则书实测上万像素）。
  // 无类名的普通容器一律拆开挂到 .modal 下。
  if (inner && !inner.className && inner.children.length) {
    while (inner.firstChild) modal.appendChild(inner.firstChild);
  } else {
    modal.appendChild(inner);
  }
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) root.innerHTML = ''; });
  root.appendChild(mask);
  return modal;
}

/**
 * 规则书：正文来自 web/rulebook.js（与手机端同一份内容与渲染器）。
 * 桌面端额外保留两个标签：角色图鉴（可视化卡牌）与本局生效的规则开关。
 */
function openRulebook() {
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>📖 规则书</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
  head.appendChild(close);
  const tabs = el('div', 'tabs');
  const body = el('div', 'mbody');
  const tabDefs = [
    ['规则书', renderBookTab],
    ['角色图鉴', renderCodexTab],
    ['本局规则', renderRulesTab],
  ];
  tabDefs.forEach(([label, fn], i) => {
    const b = el('button', i === 0 ? 'on' : '', label);
    b.addEventListener('click', () => {
      [...tabs.children].forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      body.innerHTML = '';
      fn(body);
    });
    tabs.appendChild(b);
  });
  wrap.append(head, tabs, body);
  openModal(wrap);
  body.innerHTML = '';
  renderBookTab(body);
}

/** 完整规则书（8 章，与手机端同源） */
function renderBookTab(box) {
  box.parentElement.classList.add('rulebook');
  if (window.Rulebook && window.Rulebook.render) {
    window.Rulebook.render(box);
  } else {
    box.appendChild(el('p', 'hint', '规则书资源未加载（rulebook.js 缺失）。'));
  }
}

function renderCodexTab(box) {
  const grid = el('div', 'codex');
  for (const r of Object.values(state.meta.roles)) {
    const c = el('div', 'r-card');
    c.innerHTML = `${roleArtHtml(r.id)}
      <h4>${r.emoji} ${r.name} <small style="color:${r.color}">${{ wolf: '狼人阵营', god: '神职', villager: '平民' }[r.category]}</small></h4>
      <p>${r.short}</p>
      <button class="btn small ghost">🔍 检视</button>`;
    c.querySelector('.btn').addEventListener('click', (e) => { e.stopPropagation(); openInspect(r.id); });
    grid.appendChild(c);
  }
  box.innerHTML = '';
  box.appendChild(grid);
}

function renderRulesTab(box) {
  const v = state.view;
  const rules = v && v.rules ? v.rules : state.setup.rules;
  box.innerHTML = '';
  box.parentElement.classList.add('rulebook');
  const h = el('h3', null, '本局生效的规则开关');
  box.appendChild(h);
  for (const m of state.meta.ruleMeta) {
    let val;
    const raw = getPath(rules, m.path || m.key);
    if (m.type === 'bool') val = raw ? '开' : '关';
    else if (m.type === 'enum') val = (m.options.find((o) => String(o.value) === String(raw)) || {}).label || String(raw);
    else if (m.type === 'nightOrder') {
      const labels = { admirer: '暗恋者', guard: '守卫', dreamer: '摄梦人', wolf: '狼人', wolfbeauty: '狼美人', seer: '预言家', witch: '女巫', crow: '乌鸦' };
      val = raw.map((s) => labels[s] || s).join(' → ');
    }
    box.appendChild(el('p', null, `<b>${m.label}</b>：${val}<br><span class="hint">${m.desc || ''}</span>`));
  }
}

// ---------------- 上帝面板 ----------------
function toggleGod() {
  state.godMode = !state.godMode;
  $('#god-drawer').classList.toggle('hidden', !state.godMode);
  // 重建消息流：上帝视角从 0 重新拉全量事件
  state.godAfter = 0;
  state.playerAfter = 0;
  state.playerView = null; state.godView = null;
  $('#stream').innerHTML = '';
  if (state.godMode) { startLogPolling(); } else stopLogPolling();
  // SSE 模式下要相应地开/关上帝流；轮询模式由下面的 poll() 自己处理
  if (state.stream || state.godStream) {
    if (state.godStream) { try { state.godStream.es.close(); } catch (_) { /* ignore */ } state.godStream = null; }
    if (state.godMode && state.game && state.game.godToken) {
      state.godStream = openViewStream('god', state.game.godToken, () => state.godAfter || 0);
      state.lastStreamAt = Date.now();
    }
  }
  poll();
}

/**
 * 局后 AI 教练面板（P2-4）。
 *
 * 只在终局后出现；**不自动触发**调用（要花一次 LLM 调用，由用户点），
 * 且必须一眼看出这段点评是 AI 写的还是规则生成的 —— 失败就明说原因，
 * 不做"看起来像 AI 点评、其实是模板"的静默降级。
 */
function renderCoach(v) {
  const box = $('#coach-panel');
  if (!box) return;
  // 复盘面板占一列：布局由 #screen-game.has-coach 决定（CSS 里就两条 grid 定义，不靠 JS 算宽）
  const screen = document.getElementById('screen-game');
  if (!v || !v.finished) {
    box.classList.add('hidden'); box.innerHTML = ''; state.coachSig = null;
    if (screen) screen.classList.remove('has-coach');
    return;
  }
  const r = v.review || null;
  // 签名：内容没变就不重绘，否则每次视图更新都会把用户正在读的文本重建一遍
  const sig = `${r ? r.status : 'none'}|${r ? r.mode || '' : ''}|${r ? (r.text || '').length : 0}|${r ? r.fallbackReason || '' : ''}|${v.day}|${(v.players || []).filter((p) => p.alive).length}`;
  if (sig === state.coachSig) return;
  state.coachSig = sig;
  box.classList.remove('hidden');
  if (screen) screen.classList.add('has-coach'); // 复盘面板出现时让出第三列
  box.innerHTML = '';

  const head = el('div', 'coach-head');
  head.appendChild(el('h3', '', '🎓 AI 教练点评'));
  if (r && r.status === 'done') {
    const again = el('button', 'btn ghost small', r.mode === 'ai' ? '重新生成' : '用 AI 重新点评');
    again.addEventListener('click', () => requestCoach(true));
    head.appendChild(again);
  }
  box.appendChild(head);

  // 本局速览：终局后这一列原本只有一颗按钮、大片留白。把"谁赢了/打了几天/还剩几人/我这局是什么"
  // 摆在这里 —— 复盘时最先想知道的四件事，且全部来自服务端视图，不是推测。
  const winners = { wolf: '🐺 狼人阵营获胜', good: '🕊 好人阵营获胜', third: '🎭 第三方获胜', draw: '🤝 平局（未分胜负）', none: '对局终止' };
  const me = v.me || null;
  const facts = [
    `<div class="cs-row"><span>结果</span><b>${winners[v.winner] || (v.winner ? escapeHtml(String(v.winner)) : '—')}</b></div>`,
    `<div class="cs-row"><span>天数</span><b>第 ${v.day} 天</b></div>`,
    `<div class="cs-row"><span>存活</span><b>${(v.players || []).filter((p) => p.alive).length} / ${(v.players || []).length}</b></div>`,
  ];
  if (me && me.role) {
    const info = roleInfo(me.role);
    facts.push(`<div class="cs-row"><span>我的身份</span><b style="color:${info.color}">${info.emoji}${info.name}${me.alive ? '' : ' · 已出局'}</b></div>`);
  }
  const stat = el('div', 'coach-stat', facts.join(''));
  box.appendChild(stat);

  if (!r) {
    const btn = el('button', 'btn', '让教练点评这一局');
    const row = el('div', 'btnrow');
    row.appendChild(btn);
    box.append(row, el('div', 'hint', '会调用一次 AI（占用同一通道，约十几秒到一分钟）；点评会存档，重复打开不会重复花钱。'));
    btn.addEventListener('click', () => requestCoach(false));
    return;
  }
  if (r.status === 'running') {
    box.appendChild(el('div', 'coach-body', '教练正在看这局的记录…（同一时间只跑一个 AI 调用，其他对局会稍等一下）'));
    return;
  }
  if (r.status === 'error') {
    box.appendChild(elText('div', 'coach-body coach-warn', `点评失败：${r.fallbackReason || '未知原因'}`));
    const retry = el('button', 'btn', '重试');
    retry.addEventListener('click', () => requestCoach(true));
    box.appendChild(retry);
    return;
  }
  // 安全（审核 P1-5）：复盘文本是模型输出，必须 textContent；el() 的第三参走 innerHTML
  box.appendChild(elText('div', 'coach-body', r.text || '（空点评）'));
  const tag = r.mode === 'ai'
    ? '由 AI 生成；事实来自服务端统计，不含推测。'
    : `规则点评，未使用 AI${r.fallbackReason ? `（原因：${r.fallbackReason}）` : ''}。`;
  // tag 含 fallbackReason（服务端详情）→ 也走 textContent
  box.appendChild(elText('div', `coach-tag${r.mode === 'ai' ? '' : ' coach-warn'}`, tag));
}

async function requestCoach(regenerate) {
  const g = state.game;
  if (!g) return;
  const box = $('#coach-panel');
  const btn = box && box.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = '请求中…'; }
  try {
    // 显式带座位：全 AI 局（观战/试玩）没有"人类座位"，服务端需要知道点评谁
    const me = state.view && state.view.me;
    const godSel = $('#god-seat');
    const godSeat = godSel && godSel.value ? Number(godSel.value) : 1;
    await api('POST', `/api/games/${g.gameId}/review`, {
      token: g.playerToken || g.godToken,
      seat: (me && me.seat) || godSeat || 1,
      regenerate: !!regenerate,
    });
    appendSys(regenerate ? '🎓 已请求重新生成教练点评…' : '🎓 已请求教练点评，完成后显示在下方。');
    state.coachSig = null; // 强制下次视图更新重绘
    poll(); // 立刻刷一次；后续更新走 SSE（没有 SSE 时走轮询）
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '让教练点评这一局'; }
    appendSys(`⚠ 教练点评请求失败：${e.message}`);
  }
}

function renderGodStats() {
  const v = state.view;
  const s = v && v.llmStats;
  if (!s) { $('#god-stats').innerHTML = '<span class="hint">等待对局数据…</span>'; return; }
  const hit = s.promptTokens ? Math.round(100 * s.cachedTokens / s.promptTokens) : 0;
  const ttft = s.ttftCount ? `${Math.round(s.ttftMsTotal / s.ttftCount)}ms（最大 ${(s.ttftMsMax / 1000).toFixed(1)}s）` : '-';
  const tierNames = { minimal: '极简', low: '低', normal: '常规', high: '高', critical: '关键', flat: '按任务名' };
  const tierStr = s.byTier
    ? Object.entries(s.byTier).map(([k, n]) => `${tierNames[k] || k} ${n}`).join(' · ')
    : '-';
  const sched = v.scheduler
    ? `<div class="gs-row"><span>调度器</span><b>队列 ${v.scheduler.depth}${v.scheduler.busy ? ' · 忙' : ' · 闲'}`
      + `${v.scheduler.current ? ` · ${escapeHtml(String(v.scheduler.current.label || ''))}` : ''}`
      + ` ｜ 等待 ${v.scheduler.avgWaitMs}ms / 峰值 ${v.scheduler.maxWaitMs}ms</b></div>`
    : '';
  // 一行一项的键值表：原来是一串 <p> 塞进网格，"LLM 调用：0 次 ｜ 报错 0 次…" 会各自折行成一大坨读不下去
  $('#god-stats').innerHTML = `
    <div class="gs-row"><span>LLM 调用</span><b>${s.calls} 次</b></div>
    <div class="gs-row"><span>报错 / 流式</span><b>${s.errors} / ${s.streamedCalls || 0}</b></div>
    <div class="gs-row"><span>输入 tokens</span><b>${s.promptTokens}<i>缓存命中 ${hit}%</i></b></div>
    <div class="gs-row"><span>输出 tokens</span><b>${s.completionTokens}</b></div>
    <div class="gs-row"><span>首字延迟 TTFT</span><b>${ttft}</b></div>
    <div class="gs-row"><span>思考预算档位</span><b>${tierStr}</b></div>${sched}`;
}

let logTimer = null;
function startLogPolling() {
  stopLogPolling();
  logTimer = setInterval(pollLogs, 2000);
  pollLogs();
}
function stopLogPolling() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

async function pollLogs() {
  if (!state.godMode || !state.game) return;
  const level = $('#log-level').value;
  const mod = $('#log-module').value;
  try {
    const r = await api('GET', `/api/games/${state.game.gameId}/logs?token=${state.game.godToken}&after=${state.godLogAfter}${level ? `&level=${level}` : ''}${mod ? `&module=${mod}` : ''}`);
    const box = $('#log-rows');
    for (const row of r.rows) {
      state.godLogAfter = Math.max(state.godLogAfter, row.seq);
      // 三个显式单元格（级别 / 模块 / 正文）：CSS 网格是 3 列，正文必须是**独立元素**——
      // 之前 `[模块] 正文` 是一段连续文本，会被当成同一个网格项塞进窄列，长行折成一条竖线
      const line = el('div', 'log-row',
        `<span class="lv-${row.level.toUpperCase()}">${row.level.toUpperCase()}</span>`
        + `<span class="lm">[${escapeHtml(String(row.module || ''))}]</span>`
        + `<span class="lmsg">${escapeHtml(row.msg)}${row.data && row.data.stack ? `<br><span class="lstk">${escapeHtml(String(row.data.stack).slice(0, 400))}</span>` : ''}</span>`);
      box.appendChild(line);
    }
    while (box.children.length > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    renderGodStats();
  } catch (_) { /* ignore */ }
}

$('#god-agent-refresh').addEventListener('click', pollAgent);
async function pollAgent() {
  if (!state.game) return;
  const seat = Number($('#god-seat').value || 1);
  try {
    const r = await api('GET', `/api/games/${state.game.gameId}/agent?token=${state.game.godToken}&seat=${seat}`);
    $('#god-agent').textContent = `座位${seat} · 轮次${r.turns} · 上下文消息数 ${r.contextLen}\n\n` +
      r.tail.map((m) => `【${m.role}】${m.content}`).join('\n\n———\n\n');
  } catch (e) { $('#god-agent').textContent = `✗ ${e.message}`; }
}

// ---------------- 启动 ----------------
/** 牌背（.flip-back）是静态 HTML，框层在这里注入 —— 保持"卡框只有一份实现" */
function ensureCardBacks() {
  for (const node of document.querySelectorAll('.flip-back')) {
    if (!node.querySelector('.fr-svg')) node.insertAdjacentHTML('afterbegin', window.CardFrame.html());
  }
}
ensureCardBacks();
initSetup().then(() => {
  const saved = localStorage.getItem('ww_current');
  if (saved) {
    try {
      const g = JSON.parse(saved);
      return api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=0`).then((v) => {
        if (v && !v.finished) {
          state.game = g;
          enterGameScreen();
        }
      });
    } catch (_) { /* noop */ }
  }
}).catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;color:#ff8080">初始化失败：${escapeHtml(e.message)}<br>请确认服务已启动（node server.js）</div>`;
});
