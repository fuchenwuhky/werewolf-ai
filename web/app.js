/**
 * app.js — AI 狼人杀前端（原生 JS，无依赖）
 */
'use strict';

// ---------------- 全局状态 ----------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };

const state = {
  meta: null,            // {roles, boards, ruleMeta, defaultRules}
  setup: { boardCounts: null, boardId: 'adv12', rules: null, mode: 'play', mySeat: 1 },
  game: null,            // {gameId, playerToken, godToken, mock}
  view: null,            // 最近一次 view 响应
  afterSeq: 0,
  pollTimer: null,
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
  if (cfg.hasKey) $('#cfg-key').placeholder = `已保存（${cfg.apiKeyMasked}），留空则不修改`;

  state.setup.rules = JSON.parse(JSON.stringify(state.meta.defaultRules));
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
  $('#my-seat').addEventListener('change', () => { renderAiNames(true); renderPersonas(); });
  $('#btn-rand-names').addEventListener('click', () => { renderAiNames(true); renderPersonas(); });
  $('#btn-discard').addEventListener('click', () => {
    if (confirm('确定放弃当前进行中的对局？该对局将无法继续。')) {
      localStorage.removeItem('ww_current');
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
  $('#btn-resume').addEventListener('click', () => resumeGame());
  await checkResume();
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

function renderSeatsSelect() {
  const sel = $('#my-seat');
  const total = boardTotal();
  const cur = Number(sel.value || state.setup.mySeat);
  sel.innerHTML = '';
  for (let i = 1; i <= total; i++) sel.appendChild(el('option', null, `${i} 号座位`)).value = i;
  if (cur >= 1 && cur <= total) sel.value = cur;
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
      item.innerHTML = '<span class="rlabel"><b>夜晚行动顺序</b></span>';
      item.appendChild(wrap);
      item.style.flexDirection = 'column';
      item.style.alignItems = 'stretch';
    }
    box.appendChild(item);
  }
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }
function setPath(obj, path, val) { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((o, k) => o[k], obj); t[last] = val; }

function aiSeats() {
  const total = boardTotal();
  const mySeat = state.setup.mode === 'play' ? Number($('#my-seat').value || 1) : 0;
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

async function saveConfig() {
  const body = {
    baseUrl: $('#cfg-baseurl').value.trim(),
    model: $('#cfg-model').value.trim(),
    temperature: Number($('#cfg-temp').value),
    maxTokens: Number($('#cfg-maxtokens').value),
    reasoningEffort: $('#cfg-effort').value,
    fastEffort: $('#cfg-fasteffort').value,
    contextBudget: Number($('#cfg-budget').value),
    cacheControl: $('#cfg-cachecontrol').checked,
  };
  const key = $('#cfg-key').value.trim();
  if (key) body.apiKey = key;
  try {
    const r = await api('PUT', '/api/config', body);
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = `已保存（${r.apiKeyMasked}），留空则不修改`;
    $('#cfg-test-result').textContent = '✓ 已保存';
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
    const mySeat = state.setup.mode === 'play' ? Number($('#my-seat').value || 1) : 0;
    const nameInputs = [...document.querySelectorAll('#ai-names input')];
    const personaInputs = [...document.querySelectorAll('#ai-personas input')];
    const players = [];
    for (let i = 1; i <= total; i++) {
      if (i === mySeat) {
        players.push({ name: $('#my-name').value.trim() || '我', isHuman: true, personality: '' });
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
    const created = await api('POST', '/api/games', body);
    state.game = { gameId: created.gameId, playerToken: created.playerToken, godToken: created.godToken };
    localStorage.setItem('ww_current', JSON.stringify(state.game));
    await api('POST', `/api/games/${created.gameId}/start`, { token: created.godToken });
    enterGameScreen();
  } catch (e) {
    $('#setup-error').textContent = `✗ ${e.message}`;
  }
}

/** 恢复/找回进行中的对局：优先用本地令牌；令牌丢失则从最近未结束存档找回 */
async function checkResume() {
  const saved = localStorage.getItem('ww_current');
  if (saved) {
    try {
      const g = JSON.parse(saved);
      const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=0`);
      if (v && !v.finished && v.started && v.live) { $('#resume-box').classList.remove('hidden'); return; }
      localStorage.removeItem('ww_current'); // 已结束/从未开局（设置页放弃的创建残留）→ 不恢复
    } catch (_) { localStorage.removeItem('ww_current'); }
  }
  // 令牌丢失（如清了浏览器缓存/误点清除）：从最近未结束的对局找回令牌
  try {
    const { rows } = await api('GET', '/api/games');
    const unfinished = rows.find((r) => !r.finished && r.started && r.live); // 未开局或已随服务器重启失活的对局不可恢复
    if (!unfinished) return;
    const tokens = await api('GET', `/api/games/${unfinished.id}/tokens`);
    const g = { gameId: unfinished.id, playerToken: tokens.player, godToken: tokens.god };
    const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=0`);
    if (v && !v.finished) {
      localStorage.setItem('ww_current', JSON.stringify(g));
      $('#resume-box').classList.remove('hidden');
      $('#resume-box h2').textContent = '发现进行中的对局（已自动找回会话）';
    }
  } catch (_) { /* 无可恢复对局 */ }
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
  state.roleShown = false;
  try { state.tags = JSON.parse(localStorage.getItem(`ww_tags_${state.game.gameId}`)) || {}; } catch (_) { state.tags = {}; }
  $('#stream').innerHTML = '';
  $('#btn-god').addEventListener('click', toggleGod);
  $('#btn-rulebook').addEventListener('click', openRulebook);
  $('#btn-home').addEventListener('click', backHome);
  $('#btn-terminate').addEventListener('click', terminateGame);
  startPolling();
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
  state.pollTimer = setInterval(poll, 1200);
  poll();
}
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

async function poll() {
  const g = state.game;
  if (!g) return;
  try {
    // 玩家视图：始终拉取（提供 pending 操作与"我"的信息）
    const pv = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=${state.playerAfter || 0}`);
    // 上帝视图：开启时另拉全量事件
    let gv = null;
    if (state.godMode) gv = await api('GET', `/api/games/${g.gameId}/view?token=${g.godToken}&after=${state.godAfter || 0}`);
    const primary = state.godMode ? gv : pv;
    state.view = state.godMode ? { ...gv, me: pv.me, pending: pv.pending } : pv;
    if ((state.godMode ? state.godAfter : state.playerAfter) === 0) {
      $('#stream').innerHTML = '';
      state.seatNames = {};
      for (const p of primary.players) state.seatNames[p.seat] = p.name;
    }
    appendEvents(primary.events);
    if (state.godMode) state.godAfter = Math.max(state.godAfter || 0, ...gv.events.map((e) => e.seq));
    state.playerAfter = Math.max(state.playerAfter || 0, ...pv.events.map((e) => e.seq));
    updateHeader(state.view);
    updateSeats(state.godMode ? { ...gv, me: pv.me } : pv);
    renderMyRoleCard(pv);
    updateActionbar(pv);
    maybeShowRole(pv);
    if (pv.error) appendSys(`⚠️ 对局异常：${pv.error}`);
    if (state.godMode) renderGodStats();
  } catch (e) {
    appendSys(`⚠️ 拉取失败：${e.message}`);
  }
}

function seatLabel(seat) {
  const name = state.seatNames[seat] || '';
  // 默认昵称就是"N号"时避免重复显示
  return `${seat}号${name && name !== `${seat}号` ? ' ' + name : ''}`;
}

function roleInfo(rid) { return state.meta.roles[rid]; }

/** 角色卡图：assets/roles/<id>.<ext> 存在则用图，否则回退内置哥特占位卡 */
function roleArtHtml(rid) {
  const r = roleInfo(rid);
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  const corners = '<span class="fr-corner c1"></span><span class="fr-corner c2"></span><span class="fr-corner c3"></span><span class="fr-corner c4"></span><span class="fr-gem"></span><span class="fr-orn">✠</span>';
  if (ext) {
    return `<div class="card-frame">${corners}<img class="role-art" src="assets/roles/${rid}${ext}" alt="${r.name}"></div>`;
  }
  return `<div class="role-art-fallback"><div class="fa-emoji">${r.emoji}</div><div class="fa-name">${r.name}</div></div>`;
}

/** 检视模式：大卡 + 指针 3D 倾斜 + 雾气流光 */
function openInspect(rid) {
  const r = roleInfo(rid);
  const stage = el('div', 'inspect-stage');
  const card = el('div', 'inspect-card');
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  if (ext) {
    card.innerHTML = `<img class="role-art" src="assets/roles/${rid}${ext}" alt="${r.name}">
      <div class="in-overlay"><div class="in-name gilt-name">${r.name}</div><div class="in-desc">${escapeHtml(r.short)}</div></div>`;
  } else {
    card.innerHTML = `<div class="in-body"><div class="in-emoji">${r.emoji}</div>
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

function renderAll(v) {
  $('#stream').innerHTML = '';
  state.seatNames = {};
  for (const p of v.players) state.seatNames[p.seat] = p.name;
  appendEvents(v.events);
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
      const b = el('div', `banner ${good ? '' : 'night'}`, good ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
      b.style.fontSize = '16px';
      return b;
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
  $('#btn-terminate').style.display = v.finished ? 'none' : '';
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
    hint.textContent = finished ? '对局已结束。' : waitingText(v);
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
  const art = ext ? `<img src="assets/roles/${v.me.role}${ext}" alt="">` : `<span class="mrc-emoji">${r.emoji}</span>`;
  box.innerHTML = `
    <div class="mrc-art">${art}</div>
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
    && v.phase === 'speech'); // 决斗仅发言阶段
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
    && v.phase === 'speech' && r && r.selfExplode); // 自爆仅发言阶段
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
  modal.appendChild(inner);
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) root.innerHTML = ''; });
  root.appendChild(mask);
  return modal;
}

function openRulebook() {
  const v = state.view;
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>📖 规则书</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#modal-root').innerHTML = ''; });
  head.appendChild(close);
  const tabs = el('div', 'tabs');
  const body = el('div', 'mbody');
  const tabDefs = [
    ['游戏流程', renderFlowTab],
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
  renderFlowTab(body);
}

function renderFlowTab(box) {
  box.parentElement.classList.add('rulebook');
  box.innerHTML = `
  <h3>一局游戏的完整流程</h3>
  <p>① 随机发牌，查看身份 → ② 首夜行动 → ③（若有）警长竞选 → ④ 天亮公布死讯/遗言 → ⑤ 白天轮流发言（轮到你时打字发送，无时间限制）→ ⑥ 放逐投票（互相保密，亮票结算）→ ⑦ 平票 PK → ⑧ 遗言/开枪结算 → ⑨ 判定胜负，进入下一夜。</p>
  <h3>夜晚顺序（本局可调）</h3>
  <p>守卫 → 狼人（狼队频道讨论后投票定刀口）→ 预言家 → 女巫。</p>
  <h3>胜负</h3>
  <p>好人：杀光所有狼人。狼人：屠边——杀光所有神职，或杀光所有平民。</p>
  <h3>关键细则（默认按网易官方 12 人守卫局）</h3>
  <li>同守同救（守卫+解药同夜作用于同一人）＝ 奶穿，仍死亡，视同被刀。</li>
  <li>守卫不能连续两晚守同一人；盾不防毒。</li>
  <li>女巫每晚限一瓶药，夜间始终知晓刀口；12 人局不可自救。</li>
  <li>猎人被刀/被放逐可开枪，被毒不可。</li>
  <li>警长竞选：警上报名 → 演讲（可退水）→ 警下投票 → 平票 PK；竞选阶段狼自爆按吞警徽模式处理。</li>
  <li>警长：1.5 票、每天定发言方向、压轴发言、死亡移交/撕毁警徽。</li>
  <li>遗言：首夜死者与被放逐者有遗言；被枪带走者默认无。</li>
  <li>狼人白天轮到自己发言时可自爆立即天黑；白狼王自爆可带走一人（无遗言）。</li>`;
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
  $('#stream').innerHTML = '';
  if (state.godMode) { startLogPolling(); } else stopLogPolling();
  poll();
}

function renderGodStats() {
  const v = state.view;
  const s = v && v.llmStats;
  if (!s) { $('#god-stats').innerHTML = '<span class="hint">等待对局数据…</span>'; return; }
  const hit = s.promptTokens ? Math.round(100 * s.cachedTokens / s.promptTokens) : 0;
  $('#god-stats').innerHTML = `
    <p>LLM 调用：<b>${s.calls}</b> 次 ｜ 报错 ${s.errors} 次</p>
    <p>输入 tokens：<b>${s.promptTokens}</b>（其中缓存命中 <b style="color:var(--accent2)">${s.cachedTokens}</b>，命中率 <b>${hit}%</b>）</p>
    <p>输出 tokens：<b>${s.completionTokens}</b></p>`;
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
