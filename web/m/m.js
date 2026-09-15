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
  roleShown: false, seatNames: {}, tags: {}, lastNightStep: null,
  speakingSeat: 0, stage: null,
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
const seatLabel = (seat) => { const n = state.seatNames[seat] || ''; return `${seat}号${n && n !== `${seat}号` ? ' ' + n : ''}`; };
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
  $('#m-rulebook-btn').addEventListener('click', openRulebook);
  $('#m-terminate-btn').addEventListener('click', terminateGame);
  $('#m-my-seat').addEventListener('change', () => renderSeatSelect());
  $('#m-inspect-btn').addEventListener('click', () => state.view && state.view.me && openInspect(state.view.me.role));
  $('#m-flip-card').addEventListener('click', () => $('#m-flip-card').classList.add('flipped'));
  $('#m-flip-done').addEventListener('click', () => $('#m-flip').classList.add('hidden'));
  $('#m-log-btn').addEventListener('click', () => openDrawer('log'));
  $('#m-me-btn').addEventListener('click', showMyCard);
  $('#m-drawer-close').addEventListener('click', closeDrawer);
  $('#m-drawer-mask').addEventListener('click', closeDrawer);
  document.querySelectorAll('.dtab[data-tab]').forEach((b) => b.addEventListener('click', () => selectDrawerTab(b.dataset.tab)));
  tryResume();
}

// ---------------- 记录抽屉 ----------------
function openDrawer(tab) {
  $('#m-drawer').classList.remove('hidden');
  selectDrawerTab(tab);
  if (tab === 'me') renderMeTab();
  else autoScroll();
}
function closeDrawer() { $('#m-drawer').classList.add('hidden'); }
function selectDrawerTab(tab) {
  document.querySelectorAll('.dtab[data-tab]').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
  $('#m-drawer-log').classList.toggle('hidden', tab !== 'log');
  $('#m-drawer-me').classList.toggle('hidden', tab !== 'me');
}
function renderMeTab() {
  const v = state.view;
  const box = $('#m-drawer-me');
  if (!v || !v.me || !v.me.role) { box.innerHTML = '<p class="hint">尚未获得身份。</p>'; return; }
  const r = roleInfo(v.me.role);
  const mates = v.me.teammates && v.me.teammates.length ? `<p style="color:#e89ba4">🐺 你的狼队队友：${v.me.teammates.join('、')} 号</p>` : '';
  box.innerHTML = `
    <div class="me-card">
      <div class="me-art">${roleArtHtml(v.me.role)}</div>
      <div class="me-info">
        <div class="me-role" style="color:${r.color}">${r.emoji} ${r.name}</div>
        <div class="hint">${v.me.seat}号 · ${v.me.alive ? '存活' : '出局'}${v.me.isSheriff ? ' · 👑警长' : ''}</div>
        <p style="margin:8px 0 0;font-size:13px;line-height:1.8">${escapeHtml(r.description)}</p>
        ${mates}
        <div class="btnrow" style="margin-top:10px">
          <button class="btn" id="me-inspect">🔍 检视卡牌</button>
        </div>
      </div>
    </div>`;
  $('#me-inspect').addEventListener('click', () => openInspect(v.me.role));
}
function showMyCard() {
  if (!state.view || !state.view.me || !state.view.me.role) return;
  $('#m-flip').classList.remove('hidden');
  $('#m-flip-card').classList.add('flipped'); // 直接亮正面
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

function wireSettings() {
  $('#m-settings-btn').addEventListener('click', async () => {
    const cfg = await api('GET', '/api/config').catch(() => ({}));
    const wrap = el('div');
    const head = el('div', 'mhead', '<h2>⚙ AI 设置</h2>');
    const close = el('button', 'btn ghost small', '✕');
    close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
    head.appendChild(close);
    const body = el('div', 'mbody');
    body.innerHTML = `
      <label>接口地址 base_url<input id="ms-baseurl" value="${escapeHtml(cfg.baseUrl || '')}"></label>
      <label>模型 model<input id="ms-model" value="${escapeHtml(cfg.model || '')}"></label>
      <label>API Key<input id="ms-key" type="password" placeholder="${cfg.hasKey ? '已保存（' + cfg.apiKeyMasked + '），留空不改' : 'sk-...'}"></label>
      <div class="row2">
        <label>最大回复 tokens（建议 16000）<input id="ms-maxtokens" type="number" value="${cfg.maxTokens || 16000}"></label>
      <div class="row2">
        <label>发言思考强度<select id="ms-effort">
          <option value="low"${(cfg.reasoningEffort || 'high') === 'low' ? ' selected' : ''}>最低 low（最快）</option>
          <option value="high"${cfg.reasoningEffort !== 'low' ? ' selected' : ''}>普通 high（默认）</option>
        </select></label>
        <label>快速任务强度<select id="ms-fasteffort">
          <option value="low"${(cfg.fastEffort || 'low') === 'low' ? ' selected' : ''}>最低 low（默认）</option>
          <option value="high"${cfg.fastEffort === 'high' ? ' selected' : ''}>普通 high</option>
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
    $('#ms-mock').addEventListener('change', (e) => { state.mock = e.target.checked; });
    $('#ms-save').addEventListener('click', async () => {
      const b = { baseUrl: $('#ms-baseurl').value.trim(), model: $('#ms-model').value.trim(), maxTokens: Number($('#ms-maxtokens').value), temperature: Number($('#ms-temp').value), reasoningEffort: $('#ms-effort').value || 'high', fastEffort: $('#ms-fasteffort').value || 'low', contextBudget: Number($('#ms-budget').value) || 12000 };
      const key = $('#ms-key').value.trim();
      if (key) b.apiKey = key;
      try {
        const r = await api('PUT', '/api/config', b);
        $('#ms-key').value = '';
        $('#ms-key').placeholder = `已保存（${r.apiKeyMasked}）`;
        $('#ms-result').textContent = '✓ 已保存';
      } catch (e) { $('#ms-result').textContent = `✗ ${e.message}`; }
    });
    $('#ms-test').addEventListener('click', async () => {
      $('#ms-result').textContent = '测试中…';
      await $('#ms-save').click();
      try {
        const r = await api('POST', '/api/config/test');
        $('#ms-result').textContent = r.ok ? `✓ 连接成功（${r.latencyMs}ms）` : `✗ ${(r.error || '').slice(0, 120)}`;
      } catch (e) { $('#ms-result').textContent = `✗ ${e.message}`; }
    });
  });
}

// ---------------- 屏2：规则确认 ----------------
function showScreen(id) {
  ['m-boards', 'm-rules', 'm-game'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
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

function renderSeatSelect() {
  const sel = $('#m-my-seat');
  const total = Object.values(state.boardCounts).reduce((a, b) => a + b, 0);
  const cur = Number(sel.value || 1);
  sel.innerHTML = '';
  for (let i = 1; i <= total; i++) sel.appendChild(el('option', null, `${i} 号`)).value = i;
  if (cur <= total) sel.value = cur;
}

async function startGame() {
  $('#m-err').textContent = '';
  try {
    const counts = state.boardCounts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const wolves = Object.entries(counts).filter(([r]) => state.meta.roles[r].team === 'wolf').reduce((a, [, n]) => a + n, 0);
    if (total < 4 || wolves < 1 || wolves >= total - wolves) { $('#m-err').textContent = '⚠ 板子配置不合法'; return; }
    const useMock = !!state.mock;
    const cfg = await api('GET', '/api/config');
    if (!useMock && !cfg.hasKey) { $('#m-err').textContent = '⚠ 请先在 ⚙ 设置 里填写 API Key（或勾选 Mock 试玩）'; return; }
    const mySeat = Number($('#m-my-seat').value || 1);
    const pool = shuffle(state.meta.names || []);
    const players = [];
    let ni = 0;
    for (let i = 1; i <= total; i++) {
      players.push(i === mySeat
        ? { name: $('#m-my-name').value.trim() || '我', isHuman: true }
        : { name: pool[ni++ % pool.length], isHuman: false });
    }
    const created = await api('POST', '/api/games', {
      boardId: state.boardId !== 'custom' ? state.boardId : null,
      board: state.boardId === 'custom' ? { ...counts } : undefined,
      rules: state.rules, players, mock: useMock,
    });
    state.game = { gameId: created.gameId, playerToken: created.playerToken, godToken: created.godToken };
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
    if (v && !v.finished && v.started && v.live) { state.game = g; enterGame(); }
    else localStorage.removeItem('mww_current'); // 已结束或从未开局 → 不恢复
  } catch (_) { localStorage.removeItem('mww_current'); }
}

// ---------------- 屏3：对局 ----------------
function enterGame() {
  localStorage.setItem('mww_current', JSON.stringify(state.game));
  showScreen('m-game');
  state.playerAfter = 0; state.roleShown = false; state.lastNightStep = null;
  state.speakingSeat = 0; state.stage = null;
  try { state.tags = JSON.parse(localStorage.getItem(`mww_tags_${state.game.gameId}`)) || {}; } catch (_) { state.tags = {}; }
  $('#m-drawer-log').innerHTML = '';
  startPolling();
}

function startPolling() { stopPolling(); state.pollTimer = setInterval(poll, 1200); poll(); }
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

async function poll() {
  const g = state.game;
  if (!g) return;
  try {
    const v = await api('GET', `/api/games/${g.gameId}/view?token=${g.playerToken || g.godToken}&after=${state.playerAfter}`);
    state.view = v;
    const freshFrom = state.playerAfter; // 只有新事件才触发横幅/闪光
    if (state.playerAfter === 0) {
      $('#m-drawer-log').innerHTML = '';
      state.seatNames = {}; for (const p of v.players) state.seatNames[p.seat] = p.name;
      state.speakingSeat = 0; state.stage = null;
    }
    for (const e of v.events) {
      if (e.type === 'night_step') state.lastNightStep = e.data;
      const node = renderEventNode(e);
      if (node) $('#m-drawer-log').appendChild(node);
      feedStage(e, e.seq > freshFrom);
    }
    if (v.events.length) state.playerAfter = Math.max(state.playerAfter, ...v.events.map((e) => e.seq));
    autoScroll();
    updateHeader(v);
    updateSeats(v);
    updateStage(v);
    updateActionbar(v);
    maybeShowRole(v);
  } catch (e) { appendSys(`⚠ 拉取失败：${e.message}`); }
}

function autoScroll() { const s = $('#m-drawer-log'); if (s.scrollHeight - s.scrollTop - s.clientHeight < 160) s.scrollTop = s.scrollHeight; }
function appendSys(text) { $('#m-drawer-log').appendChild(el('div', 'sysline', text)); autoScroll(); }

function renderEventNode(e) {
  const d = e.data || {};
  const priv = Array.isArray(e.visibleTo);
  switch (e.type) {
    case 'phase': { const night = (d.title || '').includes('夜'); return el('div', `banner ${night ? 'night' : ''}`, d.title || ''); }
    case 'night_step': return el('div', 'msg event', `🕯 ${escapeHtml(d.label)}（${d.index}/${d.total}）`);
    case 'system': return el('div', 'sysline', e.text || d.text || '');
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
      const m = el('div', `msg ${d.context === 'wolf' ? 'wolf' : ''} ${priv ? 'private' : ''} ${mine ? 'right' : ''}`);
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
      if (d.winner === 'none') return el('div', 'banner', `⏹ ${d.reason || '对局已终止'}`);
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
  $('#m-phase').textContent = PHASE_LABEL[v.phase] || v.phase;
  $('#m-terminate-btn').style.display = v.finished ? 'none' : '';
  const night = v.phase === 'night';
  $('#m-table').classList.toggle('night', night);
  $('#tc-icon').textContent = v.finished ? '✠' : night ? '🌙' : (v.phase === 'vote' || v.phase === 'pk' ? '🗳' : '☀️');
  $('#tc-day').textContent = v.finished ? '终 局' : `第 ${v.day} 天`;
  const step = state.lastNightStep;
  $('#tc-step').textContent = night && step && !v.finished ? `${step.label} ${step.index}/${step.total}` : '';
  $('#m-actionbar').classList.toggle('mine', !!v.pending);
}

// ---------------- 圆桌座位层 ----------------
function updateSeats(v) {
  const table = $('#m-table');
  table.querySelectorAll('.tseat').forEach((n) => n.remove());
  const ps = v.players;
  const n = ps.length;
  if (!n) return;
  const mySeat = v.me ? v.me.seat : 0;
  const myIdx = Math.max(0, ps.findIndex((p) => p.seat === mySeat));
  const rect = table.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const rx = Math.max(88, rect.width / 2 - 38);
  const ry = Math.max(78, rect.height / 2 - 46);
  for (let i = 0; i < n; i++) {
    const p = ps[(myIdx + i) % n]; // 我的座位固定在 6 点位，顺时针排布
    const ang = Math.PI / 2 + (i / n) * Math.PI * 2;
    const x = cx + rx * Math.cos(ang);
    const y = cy + ry * Math.sin(ang);
    const showRole = p.role && p.revealed;
    const tag = !p.role ? state.tags[p.seat] : null;
    const tagR = tag && roleInfo(tag);
    const s = el('div', 'tseat'
      + (p.seat === mySeat ? ' mine' : '')
      + (p.alive ? '' : ' dead')
      + (p.alive && p.seat === state.speakingSeat ? ' speaking' : ''));
    s.style.left = `${x.toFixed(1)}px`;
    s.style.top = `${y.toFixed(1)}px`;
    const ring = el('div', 'ts-ring', showRole ? roleInfo(p.role).emoji : String(p.seat));
    if (p.isSheriff) ring.appendChild(el('span', 'ts-badge', '👑'));
    if (tagR) {
      const b = el('span', 'ts-badge b2', '🏷');
      b.style.color = tagR.color;
      ring.appendChild(b);
      const rc = el('span', 'ts-role', tagR.emoji);
      rc.style.color = tagR.color;
      ring.appendChild(rc);
    }
    if (showRole) {
      const rr = roleInfo(p.role);
      const rc = el('span', 'ts-role', rr.emoji);
      rc.style.color = rr.color;
      ring.appendChild(rc);
    }
    s.appendChild(ring);
    s.appendChild(el('div', 'ts-name', escapeHtml(p.name)));
    if (v.me && p.alive && !p.revealed && p.seat !== mySeat) {
      s.classList.add('taggable');
      s.addEventListener('click', () => openTagModal(p.seat));
    } else if (showRole) {
      s.addEventListener('click', () => openInspect(p.role));
    }
    table.appendChild(s);
  }
}

// ---------------- 当前发言舞台 & 全屏横幅 ----------------
function feedStage(e, fresh) {
  const d = e.data || {};
  const priv = Array.isArray(e.visibleTo);
  switch (e.type) {
    case 'phase': {
      state.speakingSeat = 0; state.stage = null;
      const night = (d.title || '').includes('夜');
      if (fresh) flash(d.title || (night ? '天黑请闭眼' : '天亮了'), night ? 'night' : '');
      break;
    }
    case 'speech': {
      if (priv || d.context === 'wolf') break;
      state.stage = { kind: 'speech', seat: e.actor, text: d.text || '', ctx: d.context || '' };
      state.speakingSeat = e.actor;
      break;
    }
    case 'deaths': {
      const ds = d.deaths || [];
      const rules = state.view && state.view.rules;
      const showCause = !rules || rules.revealOnDeath !== false; // 暗牌局只报死亡不报死因
      state.stage = { kind: 'event', important: ds.length > 0, html: ds.length
        ? `🌅 天亮了。昨夜死亡：${ds.map((x) => `${x.seat}号${showCause ? `（${causeLabel(x.cause)}）` : ''}`).join('、')}。`
        : '🌅 天亮了。昨夜是平安夜，无人死亡。' };
      if (fresh) flash(ds.length ? '昨夜有人死去' : '平安夜', ds.length ? 'red' : 'night');
      break;
    }
    case 'vote_reveal': {
      const detail = (d.votes || []).map((x) => `${x.seat}→${x.target || '弃'}${x.weight !== 1 ? `×${x.weight}` : ''}`).join('，');
      const tally = Object.entries(d.tally || {}).map(([s, n]) => `${s === '0' ? '弃票' : s + '号'}:${n}票`).join('，');
      const curse = d.curseBonus && Object.keys(d.curseBonus).length
        ? `（🐦 ${Object.keys(d.curseBonus).map((s) => s + '号').join('、')} 受诅咒+0.5）` : '';
      state.stage = { kind: 'event', html: `🗳 亮票：${detail}<br><span class="hint">${tally}${curse}</span>` };
      break;
    }
    case 'role_reveal':
      state.stage = { kind: 'event', important: true, html: `${seatLabel(d.seat)} 翻牌：${roleChipHtml(d.role)}` };
      if (fresh) flash(`${d.seat}号 翻牌`, '');
      break;
    case 'duel':
      state.stage = { kind: 'event', important: true, html: `⚔️ ${seatLabel(e.actor)}（骑士）翻牌发起决斗，指定 ${seatLabel(d.target)}！` };
      if (fresh) flash('骑士决斗！', 'red');
      break;
    case 'explode':
      state.stage = { kind: 'event', important: true, html: `💥 ${seatLabel(e.actor)} 自爆${d.target ? `，带走 ${seatLabel(d.target)}` : ''}！` };
      if (fresh) flash('自 爆', 'red');
      break;
    case 'shoot':
      if (d.target) {
        state.stage = { kind: 'event', important: true, html: `🔫 ${seatLabel(e.actor)} 开枪带走了 ${seatLabel(d.target)}！` };
        if (fresh) flash('枪响人亡', 'red');
      }
      break;
    case 'idiot_save':
      state.stage = { kind: 'event', important: true, html: `🃏 ${seatLabel(d.seat)} 是白痴，免疫放逐（不可投票）` };
      break;
    case 'sheriff_elected':
      state.stage = { kind: 'event', html: `🎩 ${seatLabel(d.seat)} 当选警长！` };
      if (fresh) flash('警长诞生', '');
      break;
    case 'game_over': {
      const won = d.winner === 'good' ? '好人阵营获胜' : d.winner === 'wolf' ? '狼人阵营获胜' : '对局结束';
      state.stage = { kind: 'event', important: true, html: d.winner === 'none'
        ? `⏹ ${d.reason || '对局已终止'}`
        : d.winner === 'good' ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！' };
      if (fresh) flash(won, d.winner === 'wolf' ? 'night' : 'red');
      break;
    }
  }
}

function updateStage(v) {
  const head = $('#m-stage-head'), body = $('#m-stage-body'), st = $('#m-stage');
  const s = state.stage;
  st.classList.toggle('important', !!(s && s.important));
  if (s && s.kind === 'speech') {
    const p = v.players.find((x) => x.seat === s.seat);
    const ctxTag = { lastwords: '🕯 遗言', sheriff: '🎩 警上', pk: '⚔ PK' }[s.ctx] || '💬 发言';
    head.innerHTML = `<span class="stage-ava">${s.seat}</span>`
      + `<span class="stage-who">${escapeHtml(p ? p.name : '')} · ${s.seat}号</span>`
      + `<span class="stage-tag">${ctxTag}${p && !p.alive ? ' · 💀' : ''}</span>`;
    body.textContent = s.text;
  } else if (s && s.kind === 'event') {
    head.innerHTML = '<span class="stage-ava">✠</span><span class="stage-who">钟楼播报</span>';
    body.innerHTML = s.html;
  } else {
    head.innerHTML = '<span class="stage-ava">✠</span><span class="stage-who">暗夜钟声</span>';
    body.innerHTML = `<span class="hint">${escapeHtml(waitingText(v))}</span>`;
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
  modal.appendChild(inner);
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) root.innerHTML = ''; });
  root.appendChild(mask);
}

// ---------------- 操作区 ----------------
let actionState = { target: 0, explode: false, withdraw: false };

function updateActionbar(v) {
  const hint = $('#m-pending-hint');
  const box = $('#m-controls');
  const p = v.pending;
  if (!p && v.wolfTalk && v.wolfTalk.active) {
    const sig = `wt:${v.wolfTalk.round}/${v.wolfTalk.rounds}`;
    if (box.dataset.task !== sig) {
      box.dataset.task = sig; box.innerHTML = '';
      hint.className = 'pending-hint';
      hint.textContent = `🌙 狼队讨论（第 ${v.wolfTalk.round}/${v.wolfTalk.rounds} 轮）：可插话 / 加一轮 / 提前结束`;
      const ta = el('textarea'); ta.placeholder = '插话给狼队队友…';
      const row = el('div', 'btnrow');
      const say = el('button', 'btn primary', '插话');
      say.addEventListener('click', () => wolfTalkAction('say', ta.value.trim(), ta));
      const extra = el('button', 'btn', '+1 轮');
      extra.addEventListener('click', () => wolfTalkAction('extra'));
      const end = el('button', 'btn danger', '结束讨论');
      end.addEventListener('click', () => wolfTalkAction('end'));
      row.append(say, extra, end);
      box.append(ta, row);
    }
    return;
  }
  if (!p) {
    hint.className = 'pending-hint waiting';
    hint.textContent = v.finished ? '对局已结束。' : waitingText(v);
    mountExplodeBtn(v, box);
    mountDuelBtn(v, box);
    if (v.finished && !box.dataset.done) {
      box.dataset.done = '1'; box.innerHTML = '';
      const b = el('button', 'btn primary', '回到首页');
      b.addEventListener('click', () => { localStorage.removeItem('mww_current'); location.reload(); });
      box.appendChild(b);
    }
    return;
  }
  box.dataset.done = '';
  hint.className = 'pending-hint';
  if (box.dataset.task === p.task + JSON.stringify(p.candidates || '')) return;
  actionState = { target: 0, explode: false, withdraw: false };
  box.dataset.task = p.task + JSON.stringify(p.candidates || '');
  box.innerHTML = '';
  buildActionUI(v, p, box);
  if (p.task !== 'speech') mountExplodeBtn(v, box);
  mountDuelBtn(v, box);
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

function chipSeat(seat) {
  const nm = state.seatNames[seat] || '';
  const label = nm && nm !== `${seat}号` ? `${seat}<small>${escapeHtml(nm)}</small>` : `${seat}号`;
  const c = el('button', 'chip', label);
  c.addEventListener('click', () => {
    actionState.target = seat;
    [...c.parentElement.children].forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
  });
  return c;
}
function targetPicker(candidates, noneLabel) {
  const wrap = el('div'); wrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  (candidates || []).forEach((s) => wrap.appendChild(chipSeat(s)));
  if (noneLabel) {
    const none = el('button', 'chip', noneLabel);
    none.addEventListener('click', () => { actionState.target = 0; [...wrap.children].forEach((x) => x.classList.remove('sel')); none.classList.add('sel'); });
    wrap.appendChild(none);
  }
  return wrap;
}
function confirmBtn(text, build) {
  const b = el('button', 'btn primary', text);
  b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload: build() });
      $('#m-controls').innerHTML = ''; $('#m-controls').dataset.task = '';
      $('#m-pending-hint').textContent = '已提交 ✓';
    } catch (e) { $('#m-pending-hint').textContent = `✗ ${e.message}`; }
  });
  return b;
}
async function submitSimple(payload) {
  try {
    await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload });
    $('#m-controls').innerHTML = ''; $('#m-controls').dataset.task = '';
  } catch (e) { $('#m-pending-hint').textContent = `✗ ${e.message}`; }
}
async function wolfTalkAction(kind, text, ta) {
  try {
    const r = await api('POST', `/api/games/${state.game.gameId}/wolftalk`, { token: state.game.playerToken, kind, text });
    if (kind === 'say' && ta) ta.value = '';
    hint(`已发送 ✓`);
  } catch (e) { $('#m-pending-hint').textContent = `✗ ${e.message}`; }
}
function hint(t) { $('#m-pending-hint').textContent = t; }

function buildActionUI(v, p, box) {
  const me = v.me || {};
  const tasks = {
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
  hint(`⏳ ${tasks[p.task] || p.task}（无时间限制）`);
  const ta = () => { const t = el('textarea'); t.placeholder = '输入…'; return t; };
  if (['speech', 'pk_speech', 'lastwords', 'sheriff_speech', 'wolf_say'].includes(p.task)) {
    const t = ta(); box.appendChild(t);
    if (p.canExplode) {
      const ex = el('label', 'checkline', '<input type="checkbox"> 自爆（公开狼身份，立即天黑）');
      ex.querySelector('input').addEventListener('change', (e2) => { actionState.explode = e2.target.checked; });
      box.appendChild(ex);
    }
    if (p.canWithdraw) {
      const wd = el('label', 'checkline', '<input type="checkbox"> 退水');
      wd.querySelector('input').addEventListener('change', (e2) => { actionState.withdraw = e2.target.checked; });
      box.appendChild(wd);
    }
    const row = el('div', 'btnrow');
    const label = { lastwords: '留下遗言', wolf_say: '发言' }[p.task] || '发送发言';
    row.appendChild(confirmBtn(label, () => {
      const payload = { text: t.value.trim() };
      if (p.canExplode && actionState.explode) { payload.explode = true; if (me.role === 'whitewolfking') payload.target = actionState.target; }
      if (p.task === 'sheriff_speech') payload.withdraw = actionState.withdraw;
      return payload;
    }));
    if (p.task === 'wolf_say') {
      const skip = el('button', 'btn', '跳过本轮');
      skip.addEventListener('click', () => submitSimple({ text: '' }));
      row.appendChild(skip);
    }
    box.appendChild(row);
    return;
  }
  const targetTasks = {
    night_guard: ['确认守护', p.allowNone ? '空守' : null],
    night_dream: ['确认摄梦', null],
    wolfbeauty_charm: ['确认魅惑', null],
    crow_curse: ['确认诅咒', null],
    admirer_crush: ['确认心动', null],
    wolf_kill: ['投刀', p.allowNone ? '空刀' : null],
    seer_check: ['查验', null],
    vote: ['投票', p.allowNone ? '弃票' : null],
    pk_vote: ['投票', p.allowNone ? '弃票' : null],
    sheriff_vote: ['投票', '弃票'],
    shoot: ['开枪', '不开枪'],
    badge_pass: ['移交', '撕毁警徽'],
  };
  if (targetTasks[p.task]) {
    const [label, none] = targetTasks[p.task];
    box.appendChild(targetPicker(p.candidates, none));
    const row = el('div', 'btnrow');
    row.appendChild(confirmBtn(label, () => ({ target: actionState.target })));
    box.appendChild(row);
    return;
  }
  switch (p.task) {
    case 'witch': {
      const ex = p.extra || {};
      if (ex.canAntidote) {
        const save = el('button', 'btn', `💊 用解药救 ${ex.killTarget} 号`);
        save.addEventListener('click', () => submitSimple({ antidote: true, poison: 0 }));
        box.appendChild(save);
      }
      if (ex.canPoison) {
        box.appendChild(el('span', 'hint', '或毒杀：'));
        box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat)));
        box.appendChild(confirmBtn('☠ 用毒', () => ({ antidote: false, poison: actionState.target })));
      }
      const skip = el('button', 'btn ghost', '空过');
      skip.addEventListener('click', () => submitSimple({ antidote: false, poison: 0 }));
      box.appendChild(skip);
      break;
    }
    case 'sheriff_run': {
      const run = el('button', 'btn primary', '🎩 上警');
      const norun = el('button', 'btn', '不上警');
      run.addEventListener('click', () => submitSimple({ run: true }));
      norun.addEventListener('click', () => submitSimple({ run: false }));
      box.append(run, norun);
      break;
    }
    case 'direction': {
      const cw = el('button', 'btn primary', '顺时针');
      const ccw = el('button', 'btn', '逆时针');
      cw.addEventListener('click', () => submitSimple({ direction: 'cw' }));
      ccw.addEventListener('click', () => submitSimple({ direction: 'ccw' }));
      box.append(cw, ccw);
      break;
    }
    default:
      box.appendChild(el('span', 'hint', `未知任务：${p.task}`));
  }
}

// ---------------- 翻牌 / 检视 / 规则书 ----------------
function roleArtHtml(rid) {
  const r = roleInfo(rid);
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  const corners = '<span class="fr-corner c1"></span><span class="fr-corner c2"></span><span class="fr-corner c3"></span><span class="fr-corner c4"></span><span class="fr-gem"></span><span class="fr-orn">✠</span>';
  if (ext) return `<div class="card-frame">${corners}<img class="role-art" src="../assets/roles/${rid}${ext}" alt="${r.name}"></div>`;
  return `<div class="role-art-fallback"><div class="fa-emoji">${r.emoji}</div><div class="fa-name">${r.name}</div></div>`;
}
function openInspect(rid) {
  const r = roleInfo(rid);
  const stage = el('div', 'inspect-stage');
  const card = el('div', 'inspect-card');
  const ext = state.meta.roleArt && state.meta.roleArt[rid];
  if (ext) {
    card.innerHTML = `<img class="role-art" src="../assets/roles/${rid}${ext}" alt="${r.name}"><div class="in-overlay"><div class="in-name gilt-name">${r.name}</div><div class="in-desc">${escapeHtml(r.short)}</div></div>`;
  } else {
    card.innerHTML = `<div class="in-body"><div class="in-emoji">${r.emoji}</div><div class="in-name gilt-name">${r.name}</div><div class="in-desc">${escapeHtml(r.short)}</div></div>`;
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
function openRulebook() {
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>📖 规则书</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { $('#m-modal').innerHTML = ''; });
  head.appendChild(close);
  const body = el('div', 'mbody rulebook');
  body.innerHTML = `
    <h3>流程</h3><p>发牌 → 夜晚（守卫→狼人→预言家→女巫）→ ${state.meta.defaultRules.sheriff ? '警长竞选 → ' : ''}死讯/遗言 → 依次发言 → 秘密投票 → 平票PK → 结算 → 下一夜。</p>
    <h3>胜负</h3><p>好人杀光狼人获胜；狼人杀光所有神职或所有平民（屠边）获胜。</p>
    <h3>本局规则</h3><p>${formatRules()}</p>
    <h3>角色</h3>`;
  for (const r of Object.values(state.meta.roles)) {
    body.appendChild(el('p', null, `${r.emoji} <b>${r.name}</b>：${r.short}`));
  }
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

init().catch((e) => { document.body.innerHTML = `<div style="padding:40px;color:#e89ba4">初始化失败：${escapeHtml(e.message)}</div>`; });
