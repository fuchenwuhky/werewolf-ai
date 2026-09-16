/**
 * app.js — AI 狼人杀前端（原生 JS，无依赖）
 */
'use strict';

// ---------------- 全局状态 ----------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };

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
  tags: {},              // 身份标记（仅玩家自己的笔记）：{seat: roleId}
};

const PHASE_LABEL = { setup: '开局', night: '夜晚', dawn: '天亮', sheriff: '警长竞选', speech: '白天发言', vote: '放逐投票', pk: 'PK 环节', over: '结算' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------- 设置页 ----------------
async function initSetup() {
  state.meta = await api('GET', '/api/meta');
  const cfg = await api('GET', '/api/config');
  $('#cfg-baseurl').value = cfg.baseUrl || '';
  $('#cfg-model').value = cfg.model || '';
  $('#cfg-temp').value = cfg.temperature;
  $('#cfg-maxtokens').value = cfg.maxTokens;
  $('#cfg-effort').value = cfg.reasoningEffort || 'high';
  $('#cfg-fasteffort').value = cfg.fastEffort || 'low';
  $('#cfg-budget').value = cfg.contextBudget || 12000;
  $('#cfg-cachecontrol').checked = !!cfg.cacheControl;
  $('#cfg-keepalive').checked = cfg.keepAlive !== false; // 默认开
  renderPaceSelect(cfg.pace);
  if (cfg.hasKey) $('#cfg-key').placeholder = `已保存（${cfg.apiKeyMasked}），留空则不修改`;

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
  }));
  $('#my-seat').addEventListener('change', () => {
    state.setup.mySeat = $('#my-seat').value;
    persistSeatChoice(state.setup.mySeat);
    renderAiNames(true); renderPersonas();
  });
  $('#btn-rand-names').addEventListener('click', () => { renderAiNames(true); renderPersonas(); });
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
  $('#btn-god-close').addEventListener('click', toggleGod);
  $('#board-template').addEventListener('change', (e) => {
    state.setup.boardId = e.target.value;
    if (e.target.value !== 'custom') { applyBoardTemplate(e.target.value); renderBoardEditor(); renderRulesEditor(); }
  });
  $('#btn-start').addEventListener('click', startGame);
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
    input.placeholder = `留空＝随机性格（可选：毒舌贵妇、十年老油条…）`;
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
  try {
    const r = await api('PUT', '/api/config', body);
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = `已保存（${r.apiKeyMasked}），留空则不修改`;
    $('#cfg-test-result').textContent = '✓ 已保存';
    // 保存后按服务端反查结果回显档位：不以客户端的想法为准，避免"界面显示 A、磁盘是 B"
    const after = await api('GET', '/api/config').catch(() => null);
    if (after) renderPaceSelect(after.pace);
  } catch (e) { $('#cfg-test-result').textContent = `✗ ${e.message}`; }
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
      if (v && !v.finished && v.started && v.inMemory) { $('#resume-box').classList.remove('hidden'); return; }
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
        $('#resume-box h2').textContent = '发现进行中的对局（已自动找回会话）';
        return;
      }
    }
    // 服务重启后内存丢失的对局：有断点锚点，可从存档恢复续跑
    const resumable = rows.find((r) => r.resumable);
    if (resumable) {
      localStorage.setItem('ww_resumable', JSON.stringify({ gameId: resumable.id, day: resumable.day }));
      $('#resume-box').classList.remove('hidden');
      $('#resume-box h2').textContent = `发现中断的对局（进行到第 ${resumable.day} 天，服务重启过）`;
      $('#btn-resume').textContent = '从断点恢复对局';
      return;
    }
  } catch (_) { /* 无可恢复对局 */ }
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

// ---------------- 游戏页 ----------------
function enterGameScreen() {
  $('#screen-setup').classList.add('hidden');
  $('#screen-game').classList.remove('hidden');
  state.playerAfter = 0;
  state.godAfter = 0;
  state.playerView = null; state.godView = null; // 清掉上一局的缓存帧，避免切换对局后渲染残留
  state.roleShown = false;
  try { state.tags = JSON.parse(localStorage.getItem(`ww_tags_${state.game.gameId}`)) || {}; } catch (_) { state.tags = {}; }
  $('#stream').innerHTML = '';
  $('#btn-gear').addEventListener('click', openGearMenu);
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
    ['🎴 我的身份牌', () => { if (v && v.me && v.me.role) openInspect(v.me.role); }],
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
}

function saveTags() {
  try { localStorage.setItem(`ww_tags_${state.game.gameId}`, JSON.stringify(state.tags)); } catch (_) {}
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
  const roles = possibleRolesFor(v, seat);
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>🏷 标记 ${seat} 号的可疑身份</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', '只是你自己的笔记，AI 看不到；已不可能的身份不会出现在列表（如唯一女巫已暴露、你自己就是该身份）。允许多名玩家标同一身份。'));
  const chips = el('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
  for (const rid of roles) {
    const r = roleInfo(rid);
    const c = el('button', 'chip', `${r.emoji} ${r.name}`);
    if (state.tags[seat] === rid) c.classList.add('sel');
    c.addEventListener('click', () => {
      state.tags[seat] = rid;
      saveTags();
      $('#modal-root').innerHTML = '';
      updateSeats(state.view);
    });
    chips.appendChild(c);
  }
  body.appendChild(chips);
  if (state.tags[seat]) {
    const clr = el('button', 'btn danger', '清除标记');
    clr.style.marginTop = '12px';
    clr.addEventListener('click', () => {
      delete state.tags[seat];
      saveTags();
      $('#modal-root').innerHTML = '';
      updateSeats(state.view);
    });
    body.appendChild(clr);
  }
  wrap.append(head, body);
  openModal(wrap);
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
  poll();
}
function stopPolling() {
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
    // 心跳/断流兜底：若 8s 内既没有帧也没有心跳，视为连接已死 → 回退轮询
    state.streamWatchdog = setInterval(() => {
      if (!state.stream) return;
      if (Date.now() - (state.lastStreamAt || 0) > 8000) {
        appendSys('⚠️ 推送连接无响应，已切换为轮询');
        stopStream();
        startPollFallback();
      }
    }, 4000);
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
      appendSys('⚠️ 推送通道中断，已切换为轮询');
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
 */
function renderLive(v) {
  const node0 = document.getElementById('live-typing');
  const l = v && v.live;
  if (!l) {
    if (node0) node0.remove();
    state.liveSig = '';
    return;
  }
  const text = l.text || '';
  const reasoning = l.reasoning || '';
  const canSeeText = !!l.public || !!state.godMode;
  const sig = `${l.seat}|${l.task}|${text.length}|${reasoning.length}|${state.godMode ? 1 : 0}`;
  if (node0 && state.liveSig === sig) return; // 1.2s 轮询且文本未增长：不重建 DOM
  state.liveSig = sig;
  let node = node0;
  if (!node) {
    node = el('div', 'msg typing');
    node.id = 'live-typing';
    $('#stream').appendChild(node);
  }
  const who = seatLabel(l.seat);
  const tag = canSeeText && text ? '✍ 正在发言' : '… 正在思考';
  let html = `<div class="meta"><span class="who">${who}</span> <span class="typing-tag">${tag}</span></div>`;
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
  const name = state.seatNames[seat] || '';
  // 默认昵称就是"N号"时避免重复显示
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
  card.dataset.role = rid;
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

function autoScroll() {
  const s = $('#stream');
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (nearBottom) s.scrollTop = s.scrollHeight;
}

function appendSys(text) { $('#stream').appendChild(el('div', 'sysline', text)); autoScroll(); }

function roleChipHtml(rid) {
  const r = roleInfo(rid);
  return `<span class="role-tag" style="color:${r.color}">${r.emoji} ${r.name}</span>`;
}

function appendEvents(events) {
  const stream = $('#stream');
  for (const e of events) {
    if (e.type === 'night_step') state.lastNightStep = e.data;
    const node = renderEventNode(e);
    if (node) stream.appendChild(node);
  }
  autoScroll();
}

function renderEventNode(e) {
  const d = e.data || {};
  const priv = Array.isArray(e.visibleTo);
  const isMine = (ev) => state.view && state.view.me && ev.actor === state.view.me.seat;
  switch (e.type) {
    case 'phase': {
      const night = (d.title || '').includes('夜');
      return el('div', `banner ${night ? 'night' : ''}`, d.title || '');
    }
    case 'night_step': {
      const icons = { admirer: '💗', guard: '🛡️', dreamer: '🌙', wolf: '🐺', wolfbeauty: '💃', seer: '🔮', witch: '⚗️', crow: '🐦' };
      return el('div', 'msg event', `🕯 第${d.index}/${d.total}步 · ${icons[d.step] || ''} ${escapeHtml(d.label)}`);
    }
    case 'system':
      return d.title ? el('div', 'sysline', `【${d.title}】${e.text}`) : el('div', 'sysline', e.text || d.text || '');
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
        const b = el('div', 'banner', `⏹ ${d.reason || '对局已终止'}`);
        b.style.fontSize = '15px';
        return b;
      }
      const good = d.winner === 'good';
      const wrap = el('div');
      const b = el('div', `banner ${good ? '' : 'night'}`, good ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
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

function updateHeader(v) {
  $('#g-day').textContent = `第${v.day}天`;
  $('#g-phase').textContent = PHASE_LABEL[v.phase] || v.phase;
  const me = v.me;
  $('#g-me').innerHTML = me && me.role
    ? `你是 ${me.seat}号 ${escapeHtml(me.name)} · ${roleChipHtml(me.role)}${me.isSheriff ? ' 👑警长' : ''}${me.alive ? '' : ' 💀'}`
    : (state.godMode ? '上帝视角' : '');
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
      godSel.appendChild(el('option', null, `${p.seat}号 ${p.name}`)).value = p.seat;
    }
  }
  box.innerHTML = '';
  for (const p of v.players) {
    const s = el('div', `seat ${p.alive ? '' : 'dead'} ${p.seat === mySeat ? 'mine' : ''}`);
    const roleHtml = p.role ? `<span class="role-chip" style="color:${roleInfo(p.role).color}">${roleInfo(p.role).emoji}${roleInfo(p.role).name}</span>` : '';
    s.innerHTML = `<span class="snum">${p.seat}</span><span class="sname">${escapeHtml(p.name)}${p.seat === mySeat ? '（你）' : ''}</span>${p.isSheriff ? '<span class="badge">👑</span>' : ''}${p.lostVote ? '<span class="badge" title="失去投票权">🚫</span>' : ''}${roleHtml}`;
    // 身份标记（玩家视角：存活、未翻牌、非自己）
    const taggable = v.me && !state.godMode && p.alive && !p.revealed && p.seat !== v.me.seat;
    if (taggable) {
      const btn = el('button', 'btn small ghost tag-btn', '🏷');
      btn.title = '标记 TA 的可疑身份（仅自己可见）';
      btn.addEventListener('click', () => openTagModal(p.seat));
      s.appendChild(btn);
    }
    const tag = state.tags[p.seat];
    if (!p.role && tag && roleInfo(tag)) { // 身份已亮出 → 真身覆盖手动标注
      const chip = el('span', 'role-chip tag-chip', `🏷${roleInfo(tag).emoji}${roleInfo(tag).name}`);
      chip.style.color = roleInfo(tag).color;
      s.appendChild(chip);
    }
    box.appendChild(s);
  }
}

// ---------------- 操作区 ----------------
let actionState = { target: 0, explode: false, withdraw: false, antidote: false, poison: 0 };

function updateActionbar(v) {
  const hint = $('#pending-hint');
  const box = $('#action-controls');
  const p = v.pending;
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
  actionState = { target: 0, explode: false, withdraw: false, antidote: false, poison: 0 };
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
  c.addEventListener('click', () => {
    actionState.target = seat;
    [...c.parentElement.children].forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
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
    });
    wrap.appendChild(none);
  }
  return wrap;
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
      btnRow.appendChild(confirmBtn('确认摄梦', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    case 'wolfbeauty_charm': {
      $('#pending-hint').textContent = '⏳ 狼美人：选择今晚的魅惑对象（你出局时他殉情，骑士决斗除外）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认魅惑', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    case 'crow_curse': {
      $('#pending-hint').textContent = '⏳ 乌鸦：选择今晚的诅咒对象（明日放逐投票他+0.5票）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认诅咒', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    case 'admirer_crush': {
      $('#pending-hint').textContent = '⏳ 暗恋者：暗选你的暗恋对象（胜负阵营与他终身绑定，对方不知情）';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('确认心动', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    case 'wolf_kill': {
      $('#pending-hint').textContent = '⏳ 狼队投票：选择今晚的刀口';
      box.appendChild(targetPicker(p.candidates, { noneLabel: p.allowNone ? '空刀' : null }));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('投刀', () => ({ target: actionState.target })));
      box.appendChild(btnRow);
      break;
    }
    case 'seer_check': {
      $('#pending-hint').textContent = '⏳ 预言家：选择今晚查验对象';
      box.appendChild(targetPicker(p.candidates));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('查验', () => ({ target: actionState.target })));
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
      btnRow.appendChild(confirmBtn('移交给该玩家', () => ({ target: actionState.target })));
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
      btnRow.appendChild(confirmBtn('投票', () => ({ target: actionState.target })));
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
  if (!v || !v.finished) { box.classList.add('hidden'); box.innerHTML = ''; state.coachSig = null; return; }
  const r = v.review || null;
  // 签名：内容没变就不重绘，否则每次视图更新都会把用户正在读的文本重建一遍
  const sig = `${r ? r.status : 'none'}|${r ? r.mode || '' : ''}|${r ? (r.text || '').length : 0}|${r ? r.fallbackReason || '' : ''}`;
  if (sig === state.coachSig) return;
  state.coachSig = sig;
  box.classList.remove('hidden');
  box.innerHTML = '';

  const head = el('div', 'coach-head');
  head.appendChild(el('h3', '', '🎓 AI 教练点评'));
  if (r && r.status === 'done') {
    const again = el('button', 'btn ghost small', r.mode === 'ai' ? '重新生成' : '用 AI 重新点评');
    again.addEventListener('click', () => requestCoach(true));
    head.appendChild(again);
  }
  box.appendChild(head);

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
    box.appendChild(el('div', 'coach-body coach-warn', `点评失败：${r.fallbackReason || '未知原因'}`));
    const retry = el('button', 'btn', '重试');
    retry.addEventListener('click', () => requestCoach(true));
    box.appendChild(retry);
    return;
  }
  box.appendChild(el('div', 'coach-body', r.text || '（空点评）'));
  const tag = r.mode === 'ai'
    ? '由 AI 生成；事实来自服务端统计，不含推测。'
    : `规则点评，未使用 AI${r.fallbackReason ? `（原因：${r.fallbackReason}）` : ''}。`;
  box.appendChild(el('div', `coach-tag${r.mode === 'ai' ? '' : ' coach-warn'}`, tag));
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
    ? `<p>调度器：队列 <b>${v.scheduler.depth}</b>${v.scheduler.busy ? ' · 忙' : ' · 闲'}${v.scheduler.current ? ` · 当前 ${escapeHtml(String(v.scheduler.current.label || ''))}` : ''} ｜ 平均等待 <b>${v.scheduler.avgWaitMs}ms</b> / 最大 <b>${v.scheduler.maxWaitMs}ms</b></p>`
    : '';
  $('#god-stats').innerHTML = `
    <p>LLM 调用：<b>${s.calls}</b> 次 ｜ 报错 ${s.errors} 次 ｜ 流式 ${s.streamedCalls || 0} 次</p>
    <p>输入 tokens：<b>${s.promptTokens}</b>（其中缓存命中 <b style="color:var(--accent2)">${s.cachedTokens}</b>，命中率 <b>${hit}%</b>）</p>
    <p>输出 tokens：<b>${s.completionTokens}</b></p>
    <p>首字延迟 TTFT：<b>${ttft}</b></p>
    <p>思考预算档位：<b>${tierStr}</b></p>${sched}`;
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
      const line = el('div', 'log-row', `<span class="lv-${row.level.toUpperCase()}">${row.level.toUpperCase()}</span> [${row.module}] ${escapeHtml(row.msg)}${row.data && row.data.stack ? `<br><span style="color:var(--muted)">${escapeHtml(String(row.data.stack).slice(0, 400))}</span>` : ''}`);
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
