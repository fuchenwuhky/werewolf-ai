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

/**
 * 产品版本（「关于」分组展示用）。
 * TODO(FIN-04)：版本单一来源是 release-version.json（FIN-11）；/api/meta 目前不下发版本字段，
 * 前端先展示与 package.json / release-version.json 一致的常量，待轻量版本接口就绪后改为读取。
 */
const APP_VERSION = '1.5.2';

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
  // ---- FIN-05/10：局中布局与增量渲染状态 ----
  seatNodes: new Map(),  // 圆桌座位节点（以 seat 为 key 复用，发言字块更新不清空重建）
  seatListNodes: new Map(), // 列表视图座位行节点（与圆桌共用同一份选择状态）
  seatStructKey: '',     // 座位结构签名（人数/我的座位/视角）：变化才全量重建，否则逐座位补丁
  seatView: 'ring',      // 座位视图：'ring' 圆桌 | 'list' 列表（记住选择，切换不清草稿）
  notesCollapsed: false, // 右侧笔记栏在宽屏（≥1280）下是否被用户收起
  newMsgCount: 0,        // 用户上翻历史期间累计的新发言条数（新消息胶囊）
  modalReturnFocus: null,// 最上层模态的焦点来源（关闭后焦点回来源）
  gameMeta: null,        // 懒加载的当前局元数据（mock 等，视图负载里没有；结算标识用）
  lastErrSig: null,      // 上一条已提示的对局异常（避免每帧重复追加）
  notesModeBound: false, // 笔记右栏的媒体查询监听只注册一次
  // ---- M2-d §5.2/§8.2：切档守卫要读的两个"未保存"信号（判据留在各自的弹层里，这里只存引用）----
  noteDirty: null,        // 笔记弹层的 dirty()（弹层关闭即清空，避免关闭后仍报"有草稿"）
  profileFormOpen: false, // 资料编辑弹层是否还开着
  profileFormDirty: null, // 资料编辑弹层的 dirty()（同上）
  setupDraftProfileId: null, // 当前 state.setup 的**归属档案**（切档不继承上一档案草稿的判定依据）
};

/**
 * M2-d（计划书 §5.2/§5.3/§8.2）五条共享纯逻辑模块的**薄接线**。
 * 判断与状态机全部在 `web/shared/` 里（Node 单测直接覆盖），这里只做"谁触发、画哪块 DOM"：
 *   · prefs-queue.js   —— 偏好写入串行 + 合并 + 409 恢复；
 *   · request-guard.js —— 异步请求的档案绑定与代次（迟到响应不得覆盖新档案页面）；
 *   · switch-guard.js  —— 切档确认/延后、归档阻止原因、返回首页≠终止；
 *   · draft-store.js   —— 草稿按档案隔离 / 按 owner+gameId+seat 归属 / 不含密钥；
 *   · stats-bucket.js  —— 战绩分桶与胜率（分母为零显示"暂无"）。
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

/** §5.2 本窗口是否有未保存的**资料或笔记**（切档先确认；别的窗口切档只提示、不销毁） */
function hasUnsavedDraft() {
  try {
    if (typeof state.noteDirty === 'function' && state.noteDirty()) return true;
    if (state.profileFormOpen && typeof state.profileFormDirty === 'function' && state.profileFormDirty()) return true;
  } catch (_) { /* 守卫自身不许把切档弄卡 */ }
  return false;
}

// ---------------- §8.2 开局草稿：按档案保存到**会话存储**，切档不继承 ----------------
/** 当前设置屏的值（只收开局参数；**不收**任何 Key/令牌 —— 写入前还会再过一道 sanitizeDraft） */
function setupDraftOf() {
  const s = state.setup || {};
  return { boardId: s.boardId, mode: s.mode, mySeat: s.mySeat, boardCounts: s.boardCounts, rules: s.rules };
}

/** 把设置屏当前的值落到"它所属档案"的草稿键上（事件委托统一调它，见 init） */
function persistSetupDraft() {
  if (!state.setupDraftProfileId || !state.meta) return;
  window.WWDraftStore.writeSetupDraft(sessionStorage, state.setupDraftProfileId, setupDraftOf());
}

/**
 * 把某份草稿画到设置屏上（draft 为 null ⇒ 回到该档案的默认值）。
 * 顺序与 init 里的初始渲染一致：先落 state，再按既有渲染函数重画 ——
 * 不新增第二套渲染路径（否则"草稿恢复后的界面"和"正常界面"会长成两个样子）。
 */
function applySetupDraft(draft) {
  if (!state.meta) return;
  const d = draft || {};
  state.setup.rules = JSON.parse(JSON.stringify(state.meta.defaultRules));
  state.setup.mySeat = savedSeatChoice();
  // §8.2 :262 新草稿默认试玩；恢复既有草稿时保持它原来的模式（不许静默切换）
  state.setup.mode = window.WWDraftStore.resolveMode({ existingMode: d.mode });
  applyBoardTemplate(d.boardId && state.meta.boards[d.boardId] ? d.boardId : 'adv12');
  if (d.boardId === 'custom' && d.boardCounts) {
    state.setup.boardId = 'custom';
    state.setup.boardCounts = Object.assign({}, d.boardCounts);
  }
  if (d.rules && typeof d.rules === 'object') Object.assign(state.setup.rules, JSON.parse(JSON.stringify(d.rules)));
  if (d.mySeat) state.setup.mySeat = d.mySeat;
  renderBoardTemplateSelect();
  renderBoardEditor();
  renderRulesEditor();
  renderSeatsSelect();
  const radio = document.querySelector(`input[name=mode][value="${state.setup.mode}"]`);
  if (radio) radio.checked = true;
  const playOptions = $('#play-options');
  if (playOptions) playOptions.classList.toggle('hidden', state.setup.mode !== 'play');
  const seatSel = $('#my-seat');
  if (seatSel) seatSel.value = state.setup.mySeat;
  renderAiNames(true);
  renderPersonas(false);
  renderSetupDigest();
}

/** 切档/首次加载统一入口：换草稿归属 + 画该档案自己的草稿（没有则回默认值） */
function loadSetupDraftFor(profileId) {
  state.setupDraftProfileId = profileId || null;
  applySetupDraft(window.WWDraftStore.readSetupDraft(sessionStorage, profileId));
}

/**
 * 阶段值 → 中文名：**唯一真值在 web/shared/phase-label.js**（与手机端 m.js 引用的是同一个文件、
 * 同一个对象，不是两份拷贝）。两端原来各写一张逐字相同的表，单边改一个文案不会有任何测试发现；
 * 现在改成引用，键集合与文案由 test/phase-label.test.js 的冻结台账逐字钉住。
 * 这里只保留这个名字，是为了不动下面 4 处使用点（`PHASE_LABEL[phase] || phase` 的兜底语义不变）。
 */
const PHASE_LABEL = window.WWPhaseLabel.PHASE_LABEL;

// 座位视图偏好（FIN-05）：圆桌 / 列表记住上一次选择
// AC-10：左栏 240px 塞 12 人圆桌（座位 56px/姓名 10px）不可读——默认用列表视图；
// 圆桌作为可切换的展示模式保留，用户显式选过就记住（含 ring）。
try {
  const savedSeatView = localStorage.getItem('ww_seat_view');
  state.seatView = savedSeatView === 'ring' ? 'ring' : 'list';
} catch (_) { state.seatView = 'list'; }

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

/**
 * 头像三接口（§4.3）的请求体是**原始 PNG 字节**，而 api() 只发 JSON、只会带
 * `Content-Type: application/json` —— 服务端对头像上传要求 Content-Type 精确等于 `image/png`
 * （带参数即 415），所以这里必须另走一次 fetch。错误口径与 api() 对齐：
 * 401 仍然弹局域网配对门（LAN 模式下未配对），其余按状态码抛给调用方。
 */
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

/**
 * 核心导航/操作图标的接线（计划书 §3 第 78 行前半句）。
 *
 * 图标本身只有一份定义：`web/shared/icons.js` 里的 39 个 `<symbol>`（每个使用点一行 `<use>`）。
 * 这里两个函数只负责"把徽记和文案拼到一起"：
 *   · ico(id)             → 一枚徽记（currentColor，不写死色值）
 *   · icoLabel(id, text)  → 徽记 + **去掉前导图标字形**的文案（`⚙ 设置` → 徽记 + `设置`）
 * 去掉的只是**标签开头那个图标位**，文案内部与之后的 emoji 一律不动 —— 聊天内容、
 * 玩家姓名、角色/状态语义字形都不经过这两个函数（见 icons.js 文件头的位置判据）。
 */
function ico(id) { return window.WWIcons.iconMarkup(id); }
function icoLabel(id, text) { return window.WWIcons.labelMarkup(id, text); }

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
  // 中文输入法 composing 期间 Enter 不触发（FIN-03）：数字键盘下罕见，但守卫必须一致
  wrap.querySelector('#pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposing(e)) go(); });
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
  // 「设备与数据」分组里的状态行也来自这同一个真实接口，不做假状态。
  api('GET', '/api/auth/pairing').then((p) => {
    const pairStatus = $('#pairing-status');
    if (pairStatus) {
      pairStatus.textContent = p && p.needed && p.code
        ? `🌐 局域网配对进行中：配对码 ${p.code}（${Math.ceil((p.expiresInMs || 0) / 1000)}s 内有效，手机打开本页需输入）`
        : '局域网配对：当前无需配对，手机直接访问本服务地址即可。';
    }
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
  // ---- 首页次级入口与分组（FIN-04 §8.1/8.3）：都是真实存在的能力，不做假开关 ----
  const entryCodex = $('#entry-codex');
  if (entryCodex) entryCodex.addEventListener('click', openCodex);
  const entryRulebook = $('#entry-rulebook');
  if (entryRulebook) entryRulebook.addEventListener('click', openRulebook);
  const entrySettings = $('#entry-settings');
  if (entrySettings) entrySettings.addEventListener('click', () => {
    const sec = $('#setup-section');
    if (!sec) return;
    sec.hidden = !sec.hidden; // AC-11：长表单默认收起，入口展开/收起
    if (!sec.hidden) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const profilesEntry = $('#btn-profiles-entry');
  if (profilesEntry) profilesEntry.addEventListener('click', openPlayerCenter);
  const deviceProfiles = $('#btn-device-profiles');
  if (deviceProfiles) deviceProfiles.addEventListener('click', openPlayerCenter);
  // 局中顶栏入口（§5「桌面首页与顶栏提供一致入口」）：与首页/设备与数据卡是同一个玩家中心
  const topbarPlayer = $('#btn-player-center');
  if (topbarPlayer) topbarPlayer.addEventListener('click', openPlayerCenter);
  renderAbout();
  $('#btn-discard').addEventListener('click', () => {
    if (confirm('确定放弃当前进行中的对局？该对局将无法继续。')) {
      window.WWGameDraft.clearHandle(localStorage, 'ww_current');
      // ww_resumable 是**历史遗留的清理**，不是死代码 —— 不要删这两行（见 :953 处的完整说明）：
      // 老版本在 localStorage 里留下的这个键，只有这两处 removeItem 负责清掉。
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
  $('#btn-start').addEventListener('click', openStartConfirm);
  // 玩家档案（PROF-01）：加载列表 + 绑定选择/管理入口；失败不阻塞开局（服务端会归默认档案）
  $('#profile-select').addEventListener('change', (e) => onSelectProfile(e.target.value));
  $('#btn-profile-manage').addEventListener('click', openProfileManager);
  // 外观与操作（档案级偏好）：即时生效 + 落档案（失败回退）
  // AC-08：待清理恢复记录的可见入口（列出 / 重试，不泄露绝对路径）
  const rcBtn = document.querySelector('#btn-recovery-check');
  if (rcBtn) rcBtn.addEventListener('click', async () => {
    const list = document.querySelector('#recovery-list');
    const status = document.querySelector('#recovery-status');
    try {
      const r = await api('GET', '/api/import/recoveries');
      if (!r.items.length) { status.textContent = '没有待清理的恢复记录 ✓'; if (list) list.style.display = 'none'; return; }
      status.textContent = `有 ${r.items.length} 条待清理恢复记录：`;
      if (list) {
        list.style.display = '';
        list.innerHTML = '';
        for (const it of r.items) {
          const row = el('div', 'pm-row');
          const main = el('div', 'pm-main');
          main.appendChild(elText('div', 'pm-name', it.file));
          main.appendChild(elText('div', 'hint', `残留 ${(it.residue || []).length} 项 · ${it.error || it.reason || ''}`));
          row.appendChild(main);
          const ops = el('div', 'pm-ops');
          const retry = el('button', 'btn ghost small', '重试清理');
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            try {
              const rr = await api('POST', '/api/import/recoveries/retry');
              status.textContent = `已清理 ${rr.cleaned} 条，剩余 ${rr.remaining} 条`;
              if (!rr.remaining) { status.textContent = '没有待清理的恢复记录 ✓'; list.style.display = 'none'; }
              else rcBtn.click(); // 重新读真实剩余清单，失败项不能从界面消失。
              retry.disabled = false;
            } catch (e) { retry.disabled = false; status.textContent = `重试失败：${e.message}`; }
          });
          ops.appendChild(retry);
          row.appendChild(ops);
          list.appendChild(row);
        }
      }
    } catch (e) { if (status) status.textContent = `检查失败：${e.message}`; }
  });
  ['#pref-font', '#pref-layout', '#pref-motion'].forEach((sel) => {
    const c = document.querySelector(sel);
    if (c) c.addEventListener('change', onPrefControlChange);
  });
  // M2-d §8.2 :263：开局草稿按档案落到**会话存储**（不是 localStorage —— 关掉标签页就该消失）。
  // 用**事件委托**挂在设置屏上，而不是给几十个控件逐个挂：逐个挂必然漏一个，
  // 漏掉的那个字段在切档时就会串到下一个档案的草稿上。各控件自己的监听器先跑（冒泡到屏上时
  // state.setup 已经改完），所以这里直接读 state.setup 就拿到最新值。
  const setupScreen = $('#screen-setup');
  if (setupScreen) {
    for (const ev of ['change', 'input', 'click']) setupScreen.addEventListener(ev, () => { persistSetupDraft(); });
  }
  // 用户手改过昵称后就不再用档案昵称覆盖
  $('#my-name').addEventListener('input', () => { $('#my-name').dataset.touched = '1'; });
  await loadProfiles(); // 里面会按"档案归属"恢复该档案自己的开局草稿（§8.2 :263 切档不继承）
  $('#btn-resume').addEventListener('click', resumeGame);
  await checkResume();
  // 到这里才有 meta/config、事件也才绑上。此前点击按钮什么都不会发生 ——
  // 冷启动较慢时用户会以为"点了没反应"。所以：开始按钮在 HTML 里就是 disabled，
  // 这里显式启用；整个加载窗口内的拦截由 index.html 最先执行的那段守卫负责（见 index.html 顶部）。
  const startBtn = $('#btn-start');
  if (startBtn) { startBtn.disabled = false; startBtn.removeAttribute('title'); } // 禁用原因（加载中）已解除
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
    // 开局确认要素（FIN-04 §8.2）：档案归属与模型状态要与板子/人数一样一眼可见
    const profile = (state.profiles || []).find((p) => p.id === state.profileId);
    if (profile) sum.innerHTML += `<span class="ss-sep">|</span>👤 ${escapeHtml(profile.nickname)}`;
    const seatChoice = $('#my-seat') ? String($('#my-seat').value || '') : '';
    if (seatChoice) sum.innerHTML += `<span class="ss-sep">|</span>座位 ${seatChoice === 'random' ? '随机' : seatChoice + ' 号'}`;
  }
  // 真实模式缺 Key 的显式警示（不阻止浏览，但按下开始时会被拦截并引导 —— 见 startGame）
  const warn = $('#setup-warn');
  if (warn) {
    const hasKey = !!(state.cfg && state.cfg.hasKey);
    warn.textContent = (!mock && !hasKey) ? '⚠ 真实模式需要先在下方「模型与密钥」保存 API Key（Mock 试玩不需要）。' : '';
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

/** AC-11 §8.2：开局最终确认页——档案/板子/人数/座位策略/模式/模型状态一次复核；
 *  无 Key 的真实模式提供「改用 Mock 开局」的一步入局路径（不改服务端安全门禁）。 */
function openStartConfirm() {
  const useMock = document.querySelector('#use-mock') && document.querySelector('#use-mock').checked;
  const total = boardTotal();
  const seatChoice = state.setup.mode === 'play' ? String(($('#my-seat') && $('#my-seat').value) || 'random') : '0';
  const owner = (state.profiles || []).find((x) => x.id === state.profileId);
  const tpl = state.meta.boards[state.setup.boardId];
  const boardName = tpl ? tpl.name : '自定义板子';
  const hasKey = !!(state.cfg && state.cfg.hasKey);
  const wolves = Object.entries(state.setup.boardCounts || {}).filter(([r]) => state.meta.roles[r] && state.meta.roles[r].team === 'wolf').reduce((a, [, n]) => a + n, 0);
  const row = (k, v, warn) => `<div class="start-review-row${warn ? ' needs-config' : ''}"><span>${k}</span><b>${v}</b></div>`;
  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>入席之前</h2>');
  const body = el('div', 'mbody start-review');
  body.innerHTML = [
    row('本局归属', owner ? escapeHtml(owner.nickname) : '默认档案'),
    row('板子', `${escapeHtml(boardName)} · ${total} 人局 · 狼 ${wolves}/好 ${total - wolves}`),
    row('我的座位', seatChoice === '0' ? '观战' : seatChoice === 'random' ? '随机' : seatChoice + ' 号'),
    row('模式', useMock ? '免费试玩 · 不调用 API' : '真实对局 · 按模型用量计费', !useMock && !hasKey),
    row('模型', hasKey ? `${escapeHtml(String(state.cfg.model || ''))} · 已配置` : '未配置 API Key', !hasKey && !useMock),
  ].join('');
  body.appendChild(el('p', 'hint', useMock ? 'Mock 局不调用 API、完全免费。' : (hasKey ? '真实对局将按模型用量计费。' : '⚠ 真实模式需要先保存 API Key——当前尚未配置。')));
  const br = el('div', 'btnrow');
  const back = el('button', 'btn ghost', '← 返回调整');
  back.addEventListener('click', () => { closeModal(); $('#setup-section').hidden = false; $('#setup-section').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  const go = el('button', 'btn primary', useMock ? '开始免费试玩' : '确认并开始真实对局');
  go.disabled = !useMock && !hasKey;
  go.addEventListener('click', () => { closeModal(); startGame(); });
  br.append(back, go);
  body.appendChild(br);
  // 无 Key：一步 Mock 入口（门禁仍在服务端：真实模式没 Key 依旧被拒）
  if (!hasKey && !useMock) {
    const mockNow = el('button', 'btn primary', '改用免费试玩');
    mockNow.addEventListener('click', () => {
      const cb = document.querySelector('#use-mock');
      if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      closeModal();
      startGame();
    });
    body.appendChild(el('div', 'btnrow')).appendChild(mockNow);
  }
  wrap.append(head, body);
  openModal(wrap);
}

async function startGame() {
  $('#setup-error').textContent = '';
  try {
    const total = boardTotal();
    const useMock = $('#use-mock').checked;
    // 真实模式缺 Key：客户端先行阻止并引导（服务端门禁保留，这里是更早、更有指向性的失败）
    if (!useMock && state.cfg && !state.cfg.hasKey) {
      $('#setup-error').textContent = '✗ 真实对局需要 API Key：请在下方「模型与密钥」填写并保存，或勾选「Mock 试玩」（免费，不调用 API）。';
      const apiCard = $('#card-api');
      if (apiCard) apiCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
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
    const owner = (state.profiles || []).find((x) => x.id === state.profileId);
    state.game = { gameId: created.gameId, playerToken: created.playerToken, godToken: created.godToken, mySeat: created.mySeat, mock: !!useMock,
      ownerProfileId: state.profileId || null, ownerNickname: owner ? owner.nickname : null };
    state.gameMeta = { mock: !!useMock }; // 结算层要如实标注试玩局（视图负载里没有 mock 字段）
    window.WWGameDraft.writeHandle(localStorage, 'ww_current', state.game);
    if (created.mySeat) console.info(`[ww] 本局你在 ${created.mySeat} 号座位`);
    await api('POST', `/api/games/${created.gameId}/start`, { token: created.godToken });
    enterGameScreen();
  } catch (e) {
    $('#setup-error').textContent = `✗ ${e.message}`;
  }
}

/** 记住座位偏好（含 'random'）：否则每次回来都要重新选，默认又会回到 1 号 */
function persistSeatChoice(choice) {
  window.WWGameDraft.writeSeat(localStorage, 'ww_seat', choice);
}

function savedSeatChoice() {
  return window.WWGameDraft.readSeat(localStorage, 'ww_seat');
}

/** 恢复/找回进行中的对局：优先用本地令牌；令牌丢失则从最近未结束存档找回 */
async function checkResume() {
  state.resume = null;
  $('#resume-box').classList.add('hidden');
  const saved = window.WWGameDraft.readHandleRaw(localStorage, 'ww_current');
  if (saved) {
    try {
      const g = window.WWGameDraft.parseHandle(saved);
      const v = await api('GET', `/api/games/${g.gameId}/session?token=${g.playerToken || g.godToken}`);
      // 注意：判断"能否继续"必须用 inMemory（对局是否还在服务端内存里）。
      // 曾经这里用的是 v.live —— 那是流式直播缓冲，没人在打字时就是 null，
      // 于是刷新页面会被误判成"不可恢复"，紧接着把用户令牌删掉（丢档）。
      if (v && !v.finished && v.started) {
        state.resume = window.SessionModel.withView(g, v);
        showResumeCard(v.inMemory ? '继续上局' : '从存档恢复', `${v.ownerNickname || '原档案'} · ${await resumeDetail(g.gameId, v)}`);
        return;
      }
      window.WWGameDraft.clearHandle(localStorage, 'ww_current'); // 已结束/从未开局（设置页放弃的创建残留）→ 不恢复
    } catch (_) { /* 网络/权限失败不删除凭证 */ }
  }
  // 令牌丢失（如清了浏览器缓存/误点清除）：从最近未结束的对局找回令牌
  try {
    const { rows } = await api('GET', '/api/games');
    const unfinished = window.SessionModel.findOwned(rows, state.profileId);
    if (unfinished) {
      const tokens = await api('GET', `/api/games/${unfinished.id}/tokens`);
      const g = { gameId: unfinished.id, playerToken: tokens.player, godToken: tokens.god, mock: !!unfinished.mock };
      const v = await api('GET', `/api/games/${g.gameId}/session?token=${g.playerToken || g.godToken}`);
      if (v && !v.finished) {
        window.WWGameDraft.writeHandle(localStorage, 'ww_current', g);
        state.resume = window.SessionModel.withView(g, v);
        showResumeCard(v.inMemory ? '继续上局' : '从存档恢复', `${v.ownerNickname || '原档案'} · ${await resumeDetail(g.gameId, v)}`);
        return;
      }
    }
  } catch (_) { /* 无可恢复对局 */ }
  // 无可恢复局：给明确空态（FIN-04 §8.1），而不是悄悄什么都不显示
  const empty = $('#resume-empty');
  if (empty) empty.classList.remove('hidden');
}

/** 首页「继续上局」卡：标题 + 模式/阶段/人数/保存时间（详情并入标题行，详情拿不到不影响恢复本身） */
function showResumeCard(title, detail) {
  const box = $('#resume-box');
  if (!box) return;
  box.classList.remove('hidden');
  const empty = $('#resume-empty');
  if (empty) empty.classList.add('hidden');
  const h = box.querySelector('h2');
  if (h) h.textContent = title;
  // meta 独立成行（UI 审查：一行五层括号信息过载，层级混乱）
  const meta = box.querySelector('#resume-meta');
  if (meta) meta.textContent = detail || '';
}

/**
 * 恢复卡片的一行详情（P3-a + FIN-04）：阶段 / 人数 / 试玩还是真局 / 存档多久前。
 * 以前卡片只有一句"发现对局"，玩家不知道要恢复的是哪一局什么状态（实测反馈）。
 * 拿不到详情不影响恢复 —— 详情是锦上添花，恢复本身不能因为它失败。
 */
async function resumeDetail(gameId, v) {
  const parts = [];
  if (v && v.phase) parts.push(PHASE_LABEL[v.phase] || v.phase);
  if (v && v.day != null) parts.push(`第 ${v.day} 天`);
  try {
    const { rows } = await api('GET', '/api/games');
    const r = (rows || []).find((x) => x.id === gameId);
    if (r) {
      if (r.seats) parts.push(`${r.seats} 人局`);
      parts.push(r.mock ? '试玩局' : '真实对局');
      if (r.date) {
        const mins = Math.round((Date.now() - new Date(r.date).getTime()) / 60000);
        if (mins >= 1) parts.push(`存档于 ${mins} 分钟前`);
      }
    }
  } catch (_) { /* 详情拿不到就只显示已知信息 */ }
  return parts.join(' · ');
}

async function resumeGame() {
  if (state.resuming) return;
  state.resuming = true;
  try {
    const handle = state.resume || window.WWGameDraft.readHandle(localStorage, 'ww_current');
    if (!handle) return;
    const next = await window.SessionModel.prepare(api, handle, state.profileId, confirmForeignOwner);
    if (!next) return;
    state.game = next;
    window.WWGameDraft.writeHandle(localStorage, 'ww_current', next);
    // ⚠ 下面这行 removeItem（以及上面「放弃并清除」里的那一行）是**向后兼容的清理，不是死代码**：
    // 该键由 37555ae 引入（当时 setItem/getItem 配合 resumeFromAnchor 使用），493ec8f 把恢复机制
    // 整体迁到 SessionModel + ww_current 之后，写/读两侧都不再需要它 —— 全仓库现在只剩这两处 removeItem。
    // 删掉它们不会"清理代码"，反而会让**老用户浏览器里那份残留值永远留在 localStorage**：它既没有
    // 测试覆盖，也没有任何界面读它，于是再没人知道它是什么。保留的成本是两行，收益是老设备升级后不留垃圾键。
    // 另有一条静态守卫（test/ww-resumable.test.js）禁止这个键出现任何 setItem/getItem：
    // 将来若有人重新启用它却没有配套测试，守卫会先判红。
    localStorage.removeItem('ww_resumable');
    enterGameScreen();
  } catch (e) { alert(`恢复失败：${e.message}`); }
  finally { state.resuming = false; }
}

// ---------------- 玩家档案（PROF-01/04，方案 §3） ----------------
// 本机多档案：昵称/头像/简介/战绩/笔记/经验池按档案隔离；API 配置是安装级的，切换档案不动它。
// 唯一身份是 UUID，昵称允许重名。归档替代删除；删除只对已归档档案开放（二次确认）。
//
// M1 §4.1 头像的唯一真值在 web/shared/ 的两个共享模块（手机端 m.js 引用同一份，所以"两端一致"
// 是结构事实而不是"两处碰巧写得一样"——改造前那份九宫格 emoji 表就是这样长成两份的）：
//   · avatar-badge.js —— 八个内置头像的统一线稿徽记（一份 <symbol> 定义 + <use> 引用）与显示回落；
//   · avatar-image.js —— 选图预检 / 居中覆盖裁切 / 只编码一次 / 2MiB 守卫 / §4.3 三接口的请求形状。
// 本节只保留"画在哪块 DOM、由谁触发"。
// ⚠ 纪律：只改**头像**那一行。聊天内容、玩家昵称、战绩/日志文案里的正常 emoji 一个都不动
//    （头像之外没有第二条 emoji 清理路径，也不加任何全局 emoji 正则）。

async function loadProfiles() {
  // M1：拉列表 + 选中 id 落地收在共享模块（两端原本逐字相同），这里只接上本端的界面刷新
  await window.WWProfileState.loadProfiles({
    api, state, storage: localStorage,
    onLoaded: () => {
      renderProfileStrip();
      applyProfilePrefs(currentProfilePrefs()); // 档案级偏好跟随当前档案（FIN-07 行4）
      // M2-d §5.2：档案落地后推进请求代次（档案真的变了才换，同档案的并发请求不受影响）
      getRequestGuard().setCurrent(state.profileId);
      // M2-d §8.2 :263：切档不继承上一档案草稿 —— 归属档案变了才重画设置屏（没有草稿 ⇒ 回该档案默认值）
      if (state.setupDraftProfileId !== (state.profileId || null)) loadSetupDraftFor(state.profileId);
    },
    onFailed: (msg) => renderProfileStrip(`档案加载失败：${msg}`),
  });
}

/**
 * AC-04：恢复前的归属守卫。本局 owner ≠ 当前浏览档案时弹三选：
 * ① 切回原档案并恢复（推荐）② 仍以当前档案身份进入（顶栏如实标注本局归属）③ 取消留在首页
 */
async function confirmForeignOwner(v) {
  const ownerName = v.ownerNickname || '原档案';
  const cur = (state.profiles || []).find((x) => x.id === state.profileId);
  const curName = cur ? cur.nickname : '当前档案';
  return new Promise((resolve) => {
    const wrap = el('div');
    const head = el('div', 'mhead', '<h2>⚠ 对局归属确认</h2>');
    const body = el('div', 'mbody');
    body.appendChild(elText('p', null, `这局对局属于档案「${ownerName}」，而当前浏览的是「${curName}」。笔记与战绩始终记入本局归属档案。`));
    const br = el('div', 'btnrow');
    const sw = el('button', 'btn', `切回「${ownerName}」并恢复`);
    sw.disabled = !(state.profiles || []).some((p) => p.id === v.ownerProfileId && !p.archivedAt);
    sw.addEventListener('click', () => {
      const op = (state.profiles || []).find((x) => x.id === v.ownerProfileId);
      if (op) { onSelectProfile(op.id); }
      closeModal();
      resolve(true);
    });
    const keep = el('button', 'btn ghost', '保持当前档案，进入原档案对局');
    keep.addEventListener('click', () => {
      closeModal();
      resolve(true);
    });
    const cancel = el('button', 'btn ghost', '暂不恢复');
    cancel.addEventListener('click', () => { closeModal(); resolve(false); });
    br.append(sw, keep, cancel);
    body.appendChild(br);
    wrap.append(head, body);
    openModal(wrap, { onDismiss: () => { closeModal(); resolve(false); } });
  });
}

/** 当前档案的偏好（无档案时回落默认值） */
function currentProfilePrefs() {
  return window.WWProfileState.prefsOf(state.profiles, state.profileId);
}

/**
 * 偏好控件（同一套语义在桌面端有**两组**控件：开局设置页 #pref-*、玩家中心 #pc-pref-*）。
 * 回显两组都写 —— 只写一组就会出现"同一份偏好在两个入口显示不同值"。
 * 为什么不共用一组 id：同一文档里 id 必须唯一，第二处只能另起前缀。
 */
const PREF_CONTROL_PAIRS = [['#pref-font', '#pc-pref-font'], ['#pref-layout', '#pc-pref-layout'], ['#pref-motion', '#pc-pref-motion']];

/** 偏好应用：html[data-pref-*] → style.css 共享变量（双端同一套语义） */
function applyProfilePrefs(prefs) {
  const p = prefs || {};
  const root = document.documentElement;
  root.dataset.prefFont = Number(p.fontScale) > 1 ? 'lg' : (Number(p.fontScale) > 0 && Number(p.fontScale) < 1 ? 'sm' : 'std');
  root.dataset.prefLayout = p.layout === 'compact' ? 'compact' : 'reading';
  root.dataset.prefMotion = p.reducedMotion ? '0' : '1';
  // 控件回显（两组界面各自存在时都要写）
  const [fontIds, layoutIds, motionIds] = PREF_CONTROL_PAIRS;
  for (const id of fontIds) { const n = document.querySelector(id); if (n) n.value = root.dataset.prefFont; }
  for (const id of layoutIds) { const n = document.querySelector(id); if (n) n.value = root.dataset.prefLayout; }
  for (const id of motionIds) { const n = document.querySelector(id); if (n) n.checked = !!p.reducedMotion; }
}

/**
 * 偏好保存（计划书 §5.3）：**写入收进串行队列** —— 同一档案串行、合并尚未发送的连续修改，
 * 409 时重读服务端版本、无冲突字段合并后重试一次，同字段冲突保留草稿并说明。
 * 这些判断全在 `web/shared/prefs-queue.js`（Node 单测逐条覆盖），这里只做「谁触发、写哪份缓存、画不画页面」。
 *
 * §5.3 第三条：请求完成时若已切档 ⇒ **只更新原档案缓存，不改变当前页面**。
 * 判据用发起时的代次票据（request-guard），所以 A→B→A 绕一圈也不会把旧结果画上去。
 */
async function saveProfilePrefs(prefs) {
  const status = document.querySelector('#pref-status');
  const payload = {
    fontScale: Number(prefs.fontScale) || 1,
    layout: prefs.layout || 'reading',
    reducedMotion: !!prefs.reducedMotion,
  };
  const pid = state.profileId;
  const prof = state.profiles.find((x) => x.id === pid);
  if (!prof) { applyProfilePrefs(currentProfilePrefs()); if (status) status.textContent = '尚未加载档案，偏好未保存。'; return; }
  const ticket = getRequestGuard().begin(pid);
  const out = await getPrefsQueue().submit(pid, payload);
  if (out.profile) { prof.preferences = out.profile.preferences; prof.revision = out.profile.revision; }
  // 迟到的完成：**只更新原档案缓存**（上面两行已经写了），当前页面一个像素都不动
  if (!getRequestGuard().isCurrent(ticket)) return;
  applyProfilePrefs(prof.preferences); // 成功用服务端值回显；失败/冲突回滚到档案既有值
  if (!status) return;
  if (out.status === 'saved') status.textContent = '已保存到当前档案 ✓';
  else if (out.status === 'conflict') {
    const fields = Object.keys(out.conflict).join('、');
    status.textContent = `保存冲突：另一窗口改了同一字段（${fields}），无冲突的字段已保存；`
      + '你改的内容仍留在控件上（草稿未丢），请重新选择后再保存。';
  } else status.textContent = `保存失败已回退：${(out.error && out.error.message) || '未知错误'}`;
}

/**
 * 偏好控件 → 即时生效 + 落档案（桌面端两组控件共用一份；谁触发的谁把三个控件传进来）。
 * ⚠ 不要把它直接当 change 监听器：形参就是三个控件，事件对象会被当成 f 传进来。
 */
function commitPrefsFromControls(f, l, m) {
  const prefs = {
    fontScale: f && f.value === 'lg' ? 1.2 : (f && f.value === 'sm' ? 0.9 : 1),
    layout: l && l.value === 'compact' ? 'compact' : 'reading',
    reducedMotion: !!(m && m.checked),
  };
  applyProfilePrefs(prefs); // 先即时生效
  saveProfilePrefs(prefs);  // 再落档案（失败自动回退）
}

/** 开局设置页那组控件（#pref-*）的监听器：无参，读数走 id 查询 */
function onPrefControlChange() {
  commitPrefsFromControls(document.querySelector('#pref-font'), document.querySelector('#pref-layout'), document.querySelector('#pref-motion'));
}

/** 玩家中心那组控件（#pc-pref-*）的监听器：与设置页写同一份数据（§5 组③） */
function onPcPrefControlChange() {
  commitPrefsFromControls(document.querySelector('#pc-pref-font'), document.querySelector('#pc-pref-layout'), document.querySelector('#pc-pref-motion'));
}

function profileLabel(p) {
  // <option> 只能承载纯文本，装不下 SVG 徽记 —— 这里用徽记的**可读名**保住"是哪个内置头像"
  // 这条信息（不再需要第二张 emoji 对照表），聊天/昵称里的 emoji 与此无关、照旧。
  return `${window.WWAvatarBadge.textLabel(p.avatarId)} ${p.nickname}${p.archivedAt ? '（已归档）' : ''}`;
}

function renderProfileStrip(err) {
  const sel = $('#profile-select');
  if (sel) {
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
  renderHomeProfile(err);
  renderTopbarIdentity();
}

/** 首页第一屏的当前档案（FIN-04）：头像 + 昵称，与管理入口并存；数据同源 state.profiles */
function renderHomeProfile(err) {
  const av = $('#home-avatar');
  const nick = $('#home-nick');
  const p = (state.profiles || []).find((x) => x.id === state.profileId);
  // 共享模块保证这里永远只有两种结果：自定义图（用服务端给的 avatarUrl），或该档案 avatarId
  // 对应的内置徽记；缺失/脏数据也回落到默认徽记 —— 不存在"什么都不画"的第三种情况。
  renderAvatarInto(av, p);
  if (nick) {
    nick.textContent = p ? p.nickname : (err ? '档案加载失败' : '默认档案');
    nick.title = err || '';
  }
}

/** 局中顶栏：当前档案昵称（对局归属的可见标识，FIN-05） */
function renderTopbarIdentity() {
  const node = $('#topbar-profile');
  if (!node) return;
  // AC-04：对局中显示**本局实际归属**（创建时固化的 owner 快照），不是当前浏览档案
  const owner = state.game && state.game.ownerNickname ? { nickname: state.game.ownerNickname } : null;
  const p = owner || (state.profiles || []).find((x) => x.id === state.profileId);
  const foreign = owner && state.profileId && state.game.ownerProfileId !== state.profileId;
  node.textContent = p ? `${owner ? '本局归属 · ' : ''}${p.nickname}` : '未关联档案';
  node.title = owner ? (foreign ? '本局归属该档案（非当前浏览档案）：笔记/战绩仍记入本局 owner' : '本局归属档案') : '';
}

/** 「关于」分组：版本 + 运行端（不做假信息；能力只有实际接入的才展示） */
function renderAbout() {
  const box = $('#about-version');
  if (!box) return;
  box.textContent = `AI 狼人杀 · 版本 v${APP_VERSION} · 桌面浏览器端`;
}

/** 连接/保存状态点（FIN-05 顶栏）：ok=实时推送，warn=轮询降级，off=未连接 */
function setConnDot(kind, text) {
  const dot = $('#conn-dot');
  if (!dot) return;
  dot.classList.remove('conn-ok', 'conn-warn', 'conn-off');
  dot.classList.add(`conn-${kind === 'ok' || kind === 'warn' ? kind : 'off'}`);
  if (text) dot.title = text;
}

function onSelectProfile(pid) {
  // §5.2：本窗口有未保存的资料或笔记 ⇒ 切档先确认（用户取消就停在这里，草稿一个字都不动）
  const decision = window.WWSwitchGuard.decideSwitch({ dirty: hasUnsavedDraft(), source: window.WWSwitchGuard.SELF });
  if (decision.action === 'confirm' && !confirm(`${decision.reason}\n\n仍要切换档案吗？（未保存的内容会留在原档案的草稿里）`)) return;
  // §5.2 先换代再写存储：切档之前发出的请求回来时一律作废（迟到响应不得覆盖新档案页面）
  getRequestGuard().setCurrent(pid);
  // M1：写选中键 + 昵称预填收在共享模块（两端原本逐字相同），这里只接本端的界面刷新
  window.WWProfileState.selectProfile({ state, storage: localStorage, profileId: pid, nameInput: $('#my-name') });
  applyProfilePrefs(currentProfilePrefs()); // 切档 → 外观偏好跟着档案走
  renderHomeProfile();
  renderTopbarIdentity();
  if (!state.game) checkResume();
  loadSetupDraftFor(pid); // §8.2 :263 切档不继承上一档案草稿（该档案自己的草稿，没有则回默认值）
}

/**
 * 玩家中心（计划书 §5，桌面端）：四组与手机端**同构** —— 组名与顺序逐字一致
 * （①个人资料 ②对局与战绩 ③外观与操作 ④数据管理）。
 * 入口三处共用这一个函数：首页 hero 的「玩家中心」`#btn-profiles-entry`、
 * 设备与数据卡 `#btn-device-profiles`、局中顶栏 `#btn-player-center`。
 *
 * 旧名 `openProfileManager` 保留为别名：openProfileTrash / openProfileEdit / openProfileImport
 * 的"返回档案列表"路径都走它，且 scripts/ui-check.js 整段真路（档案 / 头像 / 回收区）依赖本函数
 * 渲染出的 `#pm-trash-entry` / `#pm-trash-list` / `.pm-row[data-profile-id]` / `.pm-ops` 次序
 * （第 1 个键是「选用」、第 2 个是「编辑」）/ `.btnrow` 按钮族 —— 这些结构不许顺手改。
 */
const PC_GROUPS = [
  { id: 'profile', title: '个人资料' },
  { id: 'games', title: '对局与战绩' },
  { id: 'appearance', title: '外观与操作' },
  { id: 'data', title: '数据管理' },
];

/**
 * 取一份数据，失败与超时都翻成**可渲染的结果**（永不 reject）。
 * 玩家中心要先取数再一次画完，所以任何一个慢接口都不能把弹层拖住：
 * 2.5s 没回来就按"读取失败（超时）"渲染，其余段落照常。
 */
function pcFetch(path) {
  if (!path) return Promise.resolve({ ok: false, err: new Error('尚未加载档案') });
  return Promise.race([
    api('GET', path).then((data) => ({ ok: true, data })).catch((err) => ({ ok: false, err })),
    new Promise((res) => { setTimeout(() => res({ ok: false, err: new Error('读取超时（2.5 秒）') }), 2500); }),
  ]);
}

/**
 * 打开玩家中心。**先取数、再一次画完**，不是"先画骨架再异步填" —— 后者会让弹层在打开后
 * 继续长高，④组（数据管理）的按钮跟着往下位移：玩家/脚本按下的位置已经不是它了
 * （脚本的 realClick 会先在元素几何上做命中测试、再发鼠标事件，几何一变就落到别处，
 *  实测表现为"点回收站没反应"，且只在打开后的几十毫秒内出现，是间歇性红）。
 */
async function openPlayerCenter() {
  // §5.2：票据绑定**发起时**的档案与代次。取数期间切档（含 A→B→A 绕一圈）都让这张票据作废
  const ticket = getRequestGuard().begin(state.profileId);
  const pid = ticket.profileId; // 取数期间的档案：切了就整份作废（落笔前再判一次）
  const [stats, un, fin, trash, rec] = await Promise.all([
    pcFetch(pid ? `/api/profiles/${pid}/stats` : null),
    pcFetch(pid ? `/api/profiles/${pid}/games?status=unfinished&limit=5` : null),
    pcFetch(pid ? `/api/profiles/${pid}/games?status=finished&limit=5` : null),
    pcFetch('/api/profiles/trash'),
    pcFetch('/api/import/recoveries'),
  ]);
  // §5.2：等数据期间切了档（或绕回同一个档案）⇒ 旧票据不再是"当前页面"，不许把旧数据画上去
  if (!getRequestGuard().isCurrent(ticket)) return;

  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>👤 玩家档案</h2>');
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { closeModal(); });
  head.appendChild(close);
  const body = el('div', 'mbody');

  // 四组按 PC_GROUPS 的**固定顺序**先建骨架，再按 id 把内容填进各自的盒子；
  // 页面里的组顺序因此只由 PC_GROUPS 决定（守卫 test/player-center.test.js 钉它，打乱即判红）。
  const boxes = new Map();
  for (const g of PC_GROUPS) {
    const sec = el('section', 'pc-group');
    sec.dataset.wwGroup = g.id;
    sec.appendChild(el('h3', 'pc-group-head', g.title));
    const box = el('div');
    sec.appendChild(box);
    body.appendChild(sec);
    boxes.set(g.id, box);
  }
  const usableCount = state.profiles.filter((p) => !p.archivedAt).length;
  fillPcProfile(boxes.get('profile'), usableCount);
  fillPcGames(boxes.get('games'), { stats, un, fin });
  fillPcAppearance(boxes.get('appearance'));
  fillPcData(boxes.get('data'), { trash, rec });
  wrap.append(head, body);
  openModal(wrap);
}

/** 旧名别名：既有调用点与"返回档案列表"路径继续可用（少一次回归面） */
function openProfileManager() { openPlayerCenter(); }

/** ① 个人资料：头像、昵称、简介、当前档案（列表每一行 = 切档 + 该档案的数据操作） */
function fillPcProfile(box, usableCount) {
  box.appendChild(el('p', 'hint', '同一台设备可以建多个玩家档案：战绩、笔记、AI 经验池互相隔离。API 配置是整台设备共享的，切换档案不会改动它。档案的唯一身份是 UUID，昵称允许重名。'));
  const cur = state.profiles.find((p) => p.id === state.profileId && !p.archivedAt);
  const me = el('div', 'home-profile');
  const av = el('span', 'pm-name-av');
  me.appendChild(av);
  renderAvatarInto(av, cur); // 与首页/顶栏同一条渲染路径，缺失也回落内置徽记
  const who = el('span', 'home-who');
  who.appendChild(elText('b', null, cur ? cur.nickname : '默认档案'));
  who.appendChild(elText('div', 'hint', cur && cur.bio ? cur.bio : '简介还没写（点「编辑」补上）'));
  me.appendChild(who);
  const edit = el('button', 'btn ghost small', cur ? '编辑资料' : '新建档案');
  edit.id = 'pc-edit-current';
  edit.addEventListener('click', () => openProfileEdit(cur || null));
  me.appendChild(edit);
  box.appendChild(me);

  const list = el('div', 'pm-list');
  const rows = [...state.profiles].sort((a, b) => (a.archivedAt ? 1 : 0) - (b.archivedAt ? 1 : 0) || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  for (const p of rows) {
    const row = el('div', 'pm-row' + (p.archivedAt ? ' archived' : '') + (p.id === state.profileId ? ' current' : ''));
    row.dataset.profileId = p.id; // 供脚本/验收精确定位某一行（昵称允许重名，不能按昵称找）
    const main = el('div', 'pm-main');
    // 名前行：真实头像（自定义图或内置徽记）+ 昵称/归档/当前"三态文案"。
    // 与首页/顶栏是同一条渲染路径，玩家中心一眼能看出改没改成功。
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
      b.addEventListener('click', () => fn(p, b));
      ops.appendChild(b);
      return b;
    };
    if (!p.archivedAt) {
      op('选用', async (pp) => { onSelectProfile(pp.id); closeModal(); renderProfileStrip(); }, 'btn small');
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
      op('归档', (pp) => archiveProfile(pp, usableCount));
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
          window.WWProfileState.deselectIfCurrent({ state, storage: localStorage, profileId: pp.id });
          await loadProfiles(); openProfileManager();
        } catch (e) { alert(`删除失败：${e.message}`); }
      }, 'btn small danger');
    }
    op('导出', (pp) => { window.open(`/api/profiles/${pp.id}/export`, '_blank', 'noopener'); });
    row.appendChild(ops);
    list.appendChild(row);
  }
  box.appendChild(list);

  const btnrow = el('div', 'btnrow');
  const mk = el('button', 'btn', '＋ 新建档案');
  mk.addEventListener('click', () => openProfileEdit(null));
  btnrow.appendChild(mk);
  box.appendChild(btnrow);
}

/**
 * 归档一个档案：列表行与④组「归档当前档案」共用。
 * §5.2 两条阻止（顺序与文案由 web/shared/switch-guard.js 决定，可单测）：
 *   ① 该档案还有**未结束的对局** ⇒ 不可归档/删除，返回明确原因，**不得悄悄终止对局**；
 *   ② 最后一个可用档案 ⇒ 挡住（否则设备上会没有档案可用）。
 * 未结束对局数走服务端真实计数（`/games?status=unfinished`），不是猜的。
 */
async function archiveProfile(pp, usableCount) {
  let unfinished = 0;
  try {
    const r = await api('GET', `/api/profiles/${pp.id}/games?status=unfinished&limit=100`);
    unfinished = (r && Number(r.total)) || ((r && r.rows) || []).length;
  } catch (e) {
    // 数不出来就不能假装"没有未结束对局"：宁可挡住并说明原因（数据安全 > 操作顺畅）
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
}

/**
 * 统计概览的一行文案：**唯一真值在 web/shared/stats-bucket.js**（手机端引用同一份）。
 * §5.3 的两条硬口径都收在那里：胜率分母 = 有效胜负局（wins+losses），分母为零显示「暂无」；
 * 平局与"阵营不可判定"单列，绝不混进胜负（旧公式把平局算成好人胜 ⇒ 胜1 负-1）。
 */
function statsLine(s) {
  return window.WWStatsBucket.formatAggregate(s);
}

function pcWinnerText(w) {
  if (w === 'wolf') return '狼阵营胜';
  if (w === 'good') return '好人阵营胜';
  return w || '已结束';
}

/**
 * ② 对局与战绩：统计概览 + 进行中 + 最近完成。
 * 数据由 openPlayerCenter 先取好（真实接口 /stats、/games?status=…），这里只负责画 —— 三段各自
 * 失败只影响自己那一段（一段的失败文案不会把整组变空白）。
 */
function fillPcGames(box, res) {
  if (!state.profileId) { box.appendChild(el('p', 'hint', '尚未加载档案。')); return; }
  const R = res || {};
  const failText = (label, r) => `${label}读取失败：${(r && r.err && r.err.message) || '未知错误'}`;

  const stats = el('p', 'hint');
  stats.textContent = R.stats && R.stats.ok
    ? `统计概览：${statsLine(R.stats.data)}`
    : failText('统计概览', R.stats);
  box.appendChild(stats);

  const unBox = el('div');
  unBox.appendChild(el('h4', 'pc-sub', '进行中'));
  if (R.un && R.un.ok) {
    const rows = (R.un.data && R.un.data.rows) || [];
    if (!rows.length) unBox.appendChild(el('p', 'hint', '没有进行中的对局。'));
    for (const g of rows) unBox.appendChild(pcGameRow(g, true));
  } else {
    unBox.appendChild(el('p', 'hint', failText('进行中', R.un)));
  }
  box.appendChild(unBox);

  const finBox = el('div');
  finBox.appendChild(el('h4', 'pc-sub', '最近完成'));
  if (R.fin && R.fin.ok) {
    const d = R.fin.data || {};
    const rows = d.rows || [];
    if (!rows.length) finBox.appendChild(el('p', 'hint', '还没有已结束的对局。'));
    for (const g of rows) finBox.appendChild(pcGameRow(g, false));
    if (d.total > rows.length) finBox.appendChild(elText('p', 'hint', `共 ${d.total} 局已结束；列表只展示最近 ${rows.length} 局。`));
  } else {
    finBox.appendChild(el('p', 'hint', failText('最近完成', R.fin)));
  }
  box.appendChild(finBox);
}

/** 对局行：进行中给「继续对局」，已结束给「历史」（只读事件流） */
function pcGameRow(g, resumable) {
  const row = el('div', 'pc-row' + (resumable ? ' current' : ''));
  const main = el('div', 'pc-main');
  main.appendChild(elText('div', 'pc-name', resumable ? `${g.mock ? '🧪' : '💳'} ${g.id}` : `${g.mock ? '🧪' : '💳'} ${pcWinnerText(g.winner)}`));
  const phase = g.phase ? ` · ${PHASE_LABEL[g.phase] || g.phase}` : '';
  const tail = resumable ? ' · 进行中' : (g.savedAt ? ` · ${new Date(g.savedAt).toLocaleString()}` : '');
  main.appendChild(elText('div', 'hint', `第 ${g.day || 0} 天${phase}${tail}`));
  row.appendChild(main);
  const ops = el('div', 'pm-ops');
  const btn = el('button', 'btn small', resumable ? '继续对局' : '历史');
  btn.addEventListener('click', () => { if (resumable) pcResumeFromRow(g, btn); else openPcHistory(g.id); });
  ops.appendChild(btn);
  row.appendChild(ops);
  return row;
}

/** 从玩家中心的一行恢复对局：取令牌后走与首页「继续对局」**同一个** resumeGame() */
async function pcResumeFromRow(g, btn) {
  if (btn) btn.disabled = true;
  try {
    const t = await api('GET', `/api/games/${g.id}/tokens`);
    state.resume = { gameId: g.id, playerToken: t.player, godToken: t.god, mock: !!g.mock };
    closeModal();
    await resumeGame();
  } catch (e) {
    if (btn) btn.disabled = false;
    alert(`恢复失败：${e.message}`);
  }
}

/** 已结束对局的只读历史（M2-b 接口）：正文一律 textContent —— 事件文案是引擎/模型产出 */
async function openPcHistory(gameId) {
  const pid = state.profileId;
  if (!pid) return;
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('timeline')} 对局历史</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { closeModal(); openProfileManager(); });
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(elText('p', 'hint', `只读历史 · ${gameId}：来自存档事件，不启动引擎、不调用模型。`));
  const listBox = el('div');
  listBox.textContent = '加载中…';
  body.appendChild(listBox);
  wrap.append(head, body);
  openModal(wrap);
  try {
    const r = await api('GET', `/api/profiles/${pid}/games/${encodeURIComponent(gameId)}/history?limit=100`);
    listBox.textContent = '';
    const rows = r.rows || [];
    for (const e of rows) {
      const row = el('div', 'pc-row');
      const main = el('div', 'pc-main');
      main.appendChild(elText('div', 'pc-name', `第 ${e.day || 0} 天 · ${PHASE_LABEL[e.phase] || e.phase || ''}`));
      main.appendChild(elText('div', 'hint', e.text || ''));
      row.appendChild(main);
      listBox.appendChild(row);
    }
    if (!rows.length) listBox.appendChild(el('p', 'hint', '这条历史里没有可展示的公开事件。'));
    if (r.hasMore) listBox.appendChild(elText('p', 'hint', `还有更多事件（共 ${r.total} 条），这里先显示前 ${rows.length} 条。`));
  } catch (e) {
    listBox.textContent = '';
    listBox.appendChild(elText('p', 'hint', `历史加载失败：${e.message}`));
  }
}

/** ③ 外观与操作：字号 / 阅读布局 / 减少动态效果 —— 与开局设置页 #pref-* 同一份偏好实现 */
function fillPcAppearance(box) {
  const cur = currentProfilePrefs();
  const mkSel = (id, options, value) => {
    const sel = el('select');
    sel.id = id;
    for (const [val, label] of options) {
      const o = el('option', null, label);
      o.value = val;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener('change', onPcPrefControlChange);
    return sel;
  };
  const curFont = Number(cur.fontScale) > 1 ? 'lg' : (Number(cur.fontScale) > 0 && Number(cur.fontScale) < 1 ? 'sm' : 'std');
  const rowF = el('div', 'pc-field');
  rowF.appendChild(el('span', null, '界面字号'));
  rowF.appendChild(mkSel('pc-pref-font', [['sm', '小'], ['std', '标准'], ['lg', '大']], curFont));
  const rowL = el('div', 'pc-field');
  rowL.appendChild(el('span', null, '阅读布局'));
  rowL.appendChild(mkSel('pc-pref-layout', [['reading', '阅读'], ['compact', '紧凑']], cur.layout === 'compact' ? 'compact' : 'reading'));
  const rowM = el('div', 'pc-field');
  rowM.appendChild(el('span', null, '减少动态效果'));
  const mchk = el('input');
  mchk.type = 'checkbox';
  mchk.id = 'pc-pref-motion';
  mchk.checked = !!cur.reducedMotion;
  mchk.addEventListener('change', onPcPrefControlChange);
  rowM.appendChild(mchk);
  box.append(rowF, rowL, rowM);
  box.appendChild(el('p', 'hint', '档案级偏好：保存到当前档案，切档后各自生效（与「开局设置 · 外观与操作」是同一份数据）。'));
}

/** ④ 数据管理：导出、导入、归档、回收站和待清理恢复记录（数据由 openPlayerCenter 先取好） */
function fillPcData(box, res) {
  const cur = state.profiles.find((p) => p.id === state.profileId && !p.archivedAt);
  const usableCount = state.profiles.filter((p) => !p.archivedAt).length;
  const R = res || {};

  const row = el('div', 'btnrow');
  const exp = el('button', 'btn ghost', '导出当前档案');
  exp.id = 'pc-export';
  exp.disabled = !cur;
  exp.title = cur ? `导出「${cur.nickname}」为档案包（含战绩 / 笔记）` : '先选一个档案';
  exp.addEventListener('click', () => { if (cur) window.open(`/api/profiles/${cur.id}/export`, '_blank', 'noopener'); });
  row.appendChild(exp);
  const imp = el('button', 'btn ghost', icoLabel('import', '导入档案包'));
  imp.addEventListener('click', () => openProfileImport());
  row.appendChild(imp);
  // 回收区入口（FIX-04）：id 与文案保持不变 —— scripts/ui-check.js 靠 #pm-trash-entry 走整段回收区真路
  const trashBtn = el('button', 'btn ghost', icoLabel('trash', '回收站'));
  trashBtn.id = 'pm-trash-entry';
  trashBtn.addEventListener('click', openProfileTrash);
  row.appendChild(trashBtn);
  box.appendChild(row);
  // 计数用取好的那份：**打开就定形**，不给它一次异步改字的机会（改字=重排=按钮位移）
  if (R.trash && R.trash.ok) {
    trashBtn.innerHTML = icoLabel('trash', `回收站（${((R.trash.data && R.trash.data.items) || []).length}）`);
  } else {
    trashBtn.innerHTML = icoLabel('trash', '回收站（读取失败）');
    trashBtn.title = (R.trash && R.trash.err && R.trash.err.message) || '回收区不可用';
  }

  const row2 = el('div', 'btnrow');
  const arch = el('button', 'btn ghost', '归档当前档案');
  arch.id = 'pc-archive';
  arch.disabled = !cur;
  arch.title = cur ? '归档后从选择器隐藏，战绩与笔记保留，可随时恢复' : '先选一个档案';
  arch.addEventListener('click', () => { if (cur) archiveProfile(cur, usableCount); });
  row2.appendChild(arch);
  box.appendChild(row2);

  box.appendChild(el('p', 'hint', '待清理恢复记录（导入中断后留下的中间文件）'));
  const recLine = el('p', 'hint');
  const recBtn = el('button', 'btn ghost small', '重试清理');
  if (R.rec && R.rec.ok) {
    const n = ((R.rec.data && R.rec.data.items) || []).length;
    recLine.textContent = n ? `有 ${n} 条待清理恢复记录` : '没有待清理的恢复记录 ✓';
    if (!n) recBtn.style.display = 'none';
  } else {
    recLine.textContent = '恢复记录不可用（需管理会话）';
    recBtn.style.display = 'none';
  }
  recBtn.addEventListener('click', async () => {
    recBtn.disabled = true;
    try {
      const r = await api('POST', '/api/import/recoveries/retry');
      recLine.textContent = r.remaining ? `仍有 ${r.remaining} 条待清理（残留文件被占用）` : '没有待清理的恢复记录 ✓';
      recBtn.disabled = !r.remaining;
    } catch (e) { recLine.textContent = `重试失败：${e.message}`; recBtn.disabled = false; }
  });
  box.append(recLine, recBtn);

  box.appendChild(el('p', 'hint', '说明：这些档案是同一设备上的数据分类，不是密码保护。能读本地文件或管理本服务的人就能看到所有档案。手机浏览器连的是电脑服务时，读写的也是电脑那一份。'));
}


/** 表单内联错误行（沿用档案表单原有配色，不再多写一处色值） */
function formErrorLine() {
  const p = el('p', 'hint');
  p.style.color = '#ff8080';
  return p;
}

/**
 * 档案编辑（PATCH/POST）+ 头像（§4.1）。
 *
 * 头像的两条状态轴分开管，互不覆盖：
 *   · `avatarId` —— 内置徽记，同时也是**删掉自定义图之后的回退**（服务端从不动它）；
 *   · `customUrl` / `pendingBlob` —— 自定义图：已保存的用服务端给的 `avatarUrl`，
 *     刚裁好还没保存的用 `pendingBlob`（内存里的 PNG Blob，不上传也画得出来）。
 * 「改成什么样」全部攒到「保存」才落盘；只有「删除自定义头像」是立即生效的显式动作
 * （§4.1 第 6 条要求的两个明确动作，语义不同所以是两个按钮：「改用内置头像」= 保存时生效，
 * 「删除自定义头像」= 现在就把已上传的文件删掉）。
 * `draft` 用于"选图 → 裁切页 → 返回"时把昵称/简介/已选内置头像原样带回，玩家不会白填一遍。
 */
function openProfileEdit(existing, draft) {
  const Badge = window.WWAvatarBadge;
  const Img = window.WWAvatarImage;
  const d = draft || {};
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${existing ? '编辑档案' : '新建档案'}</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { closeModal(); openProfileManager(); });
  head.appendChild(close);
  const body = el('div', 'mbody');
  const err = formErrorLine();

  // revision 自己拿在手上：删除自定义头像会立即推进它，若继续用外面临时快照里的旧值，
  // 接着点「保存」必然 409（一次"刚被别处修改过"的假警报）。
  let rev = existing ? existing.revision : null;
  let avatarId = d.avatarId !== undefined ? d.avatarId : (existing ? existing.avatarId : Badge.DEFAULT_AVATAR_ID);
  let customUrl = d.customUrl !== undefined ? d.customUrl : (existing ? (existing.avatarUrl || null) : null);
  let pendingBlob = d.pendingBlob || null;
  let removeCustom = !!d.removeCustom;

  const nameL = el('label', null, '<span>昵称（1–20 字）</span>');
  const nameI = el('input'); nameI.maxLength = 20; nameI.id = 'profile-form-nick';
  nameI.value = d.nickname !== undefined ? d.nickname : (existing ? existing.nickname : '');
  nameL.appendChild(nameI);
  body.appendChild(nameL);

  const bioL = el('label', null, '<span>简介（选填，最多 100 字）</span>');
  const bioI = el('textarea'); bioI.maxLength = 100; bioI.rows = 2; bioI.id = 'profile-form-bio';
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

  const avRow = el('div', 'av-row');
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
    // 与首页/玩家中心同一条渲染路径：这里看到的就是保存后看到的
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
    openAvatarCrop({
      source: prep,
      draft: { nickname: nameI.value, bio: bioI.value, avatarId, customUrl, pendingBlob, removeCustom },
      onConfirm: (blob) => openProfileEdit(existing, { nickname: nameI.value, bio: bioI.value, avatarId, customUrl, pendingBlob: blob, removeCustom: false }),
      onUseBuiltin: () => openProfileEdit(existing, { nickname: nameI.value, bio: bioI.value, avatarId, customUrl, pendingBlob: null, removeCustom: true }),
      onCancel: () => openProfileEdit(existing, { nickname: nameI.value, bio: bioI.value, avatarId, customUrl, pendingBlob, removeCustom }),
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
      await loadProfiles(); // 首页/顶栏/玩家中心立即跟上（§4.1 第 5 条）
      syncAvatarUi();
    } catch (e) {
      err.textContent = `删除自定义头像失败：${e.message}（原头像保持不变）`;
    } finally {
      delCustom.disabled = false;
    }
  });

  const go = el('button', 'btn', existing ? '保存' : '创建');
  go.addEventListener('click', async () => {
    const nick = nameI.value.trim();
    if (!nick) { err.textContent = '昵称不能为空'; return; }
    err.textContent = '';
    go.disabled = true;
    try {
      let prof = existing;
      if (existing) {
        const r = await api('PATCH', `/api/profiles/${existing.id}`, { expectedRevision: rev, nickname: nick, avatarId, bio: bioI.value.trim() });
        prof = (r && r.profile) || existing;
      } else {
        const r = await api('POST', '/api/profiles', { nickname: nick, avatarId, bio: bioI.value.trim() });
        prof = r.profile;
        onSelectProfile(prof.id);
      }
      if (prof && Number.isInteger(prof.revision)) rev = prof.revision;
      // §4.1 第 7 条：头像只在玩家真的动了它时才发请求。上传用**新** revision，
      // 失败则整个档案回滚到原头像（先保存资料再传图，任何一步失败都不会留下"图没了"的中间态）。
      if (pendingBlob) {
        const resp = await avatarRequest(() => Img.putAvatar(rawFetch, { profileId: prof.id, revision: rev, body: pendingBlob }));
        const merged = Img.mergeAvatarResult(state.profiles, resp);
        if (merged && Number.isInteger(merged.revision)) rev = merged.revision;
      } else if (removeCustom && customUrl) {
        const resp = await avatarRequest(() => Img.deleteAvatar(rawFetch, { profileId: prof.id, revision: rev }));
        const merged = Img.mergeAvatarResult(state.profiles, resp);
        if (merged && Number.isInteger(merged.revision)) rev = merged.revision;
      }
      await loadProfiles();
      closeModal();
      openProfileManager();
    } catch (e) {
      if (e && (e.status === 409 || /已被其他窗口|revision/i.test(e.message || ''))) err.textContent = '档案刚被别处修改过（另一窗口？），请关闭后重开再试';
      else err.textContent = e.message;
      go.disabled = false;
    }
  });
  body.append(go, err);
  wrap.append(head, body);
  openModal(wrap);
  syncAvatarUi();
  // §5.2 登记给切档守卫：资料表单被改过（昵称/简介/选了新头像/改用内置图）⇒ 切档先确认。
  // 必须在 openModal **之后**登记 —— openModal 开头会清掉上一个弹层的 dirty 引用；
  // 关闭与保存成功都走 closeModal()，那里会一并清空。
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
 * 为什么是独立一页而不是编辑器里的一块：openModal 全页只允许一个模态（它先清空 #modal-root），
 * 所以裁切页顶替编辑页，取消/返回时用 draft 把编辑页原样重开。
 * 为什么预览全是 <canvas>：CSP 是 `img-src 'self'`（src/static.js），`data:`/`blob:` 图片 URL
 * 会被浏览器直接拦掉 —— 解码走 createImageBitmap（不经过 URL），预览全部画在画布上。
 * 编码复用这张 512×512 展示画布，所以"编码出来的字节"就是"玩家在预览里看到的像素"。
 */
function openAvatarCrop(cfg) {
  const Img = window.WWAvatarImage;
  const S = Img.OUTPUT_SIZE;
  const P = 96; // 预览画布内部分辨率（CSS 展示 64px）
  const source = cfg.source;
  let view = Img.initialView(source.width, source.height, S);
  let released = false;
  let drag = null;

  // 出口唯一：位图要么已经变成 Blob，要么被放弃 —— 两条路都必须 close()，否则每裁一次漏一块位图
  const leave = (fn) => {
    if (released) return;
    released = true;
    Img.releaseBitmap(source.bitmap);
    fn();
  };

  const wrap = el('div');
  const head = el('div', 'mhead', '<h2>裁切头像</h2>');
  const back = el('button', 'btn ghost small', '✕');
  back.id = 'av-crop-cancel';
  back.addEventListener('click', () => leave(cfg.onCancel));
  head.appendChild(back);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', `拖动调整位置，用 ＋ / － 缩放（滚轮也行）。头像按「居中覆盖」裁成 ${S}×${S} 正方形，不会拉伸变形。`));

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
  const sq = mkPreview('av-crop-square', '方形预览', false);
  const rd = mkPreview('av-crop-round', '圆形预览', true);
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
  const ops = el('div', 'btnrow');
  const ok = el('button', 'btn primary', '确认裁切');
  ok.id = 'av-crop-confirm';
  const useBuiltin = el('button', 'btn ghost', '改用内置头像');
  useBuiltin.id = 'av-crop-builtin';
  useBuiltin.addEventListener('click', () => leave(cfg.onUseBuiltin));
  ops.append(ok, useBuiltin);
  body.append(ops, err);

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
  const step = (e, k) => {
    view = Img.dragView(source.width, source.height, S, view, (e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
    drag = { x: e.clientX, y: e.clientY };
    paint();
  };
  stage.addEventListener('pointerdown', (e) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 不支持捕获时退化为"指针在区域内才能拖" */ }
    if (typeof e.preventDefault === 'function') e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    step(e, r.width > 0 ? S / r.width : 1);
  });
  const endDrag = () => { drag = null; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('lostpointercapture', endDrag);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    view = Img.zoomView(source.width, source.height, S, view, view.zoom + (e.deltaY < 0 ? Img.ZOOM_STEP : -Img.ZOOM_STEP));
    paint();
  }, { passive: false });
  zOut.addEventListener('click', () => { view = Img.zoomView(source.width, source.height, S, view, view.zoom - Img.ZOOM_STEP); paint(); });
  zIn.addEventListener('click', () => { view = Img.zoomView(source.width, source.height, S, view, view.zoom + Img.ZOOM_STEP); paint(); });

  ok.addEventListener('click', async () => {
    ok.disabled = true;
    err.textContent = '';
    const r = await Img.produceAvatar({ image: source.bitmap, view, outSize: S, canvas: stage });
    // 超 2MiB 时只有这一句原文文案，且**绝不**降采样/降色深重编一次
    if (!r.ok) { err.textContent = r.message; ok.disabled = false; return; }
    leave(() => cfg.onConfirm(r.blob));
  });

  wrap.append(head, body);
  paint();
  // 点遮罩 / Esc 也要释放位图：onDismiss 与 ✕ 走同一条出口
  openModal(wrap, { onDismiss: () => leave(cfg.onCancel) });
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
      closeModal();
      renderProfileStrip();
      openProfileManager();
      alert(`导入完成：${r.imported} 局已归入新档案${r.pendingRecoveries && r.pendingRecoveries.length ? '\n另有历史导入残留未清理，请到「设备与数据」检查恢复记录。' : ''}`);
    } catch (e) { alert(`导入失败：${e.message}`); }
  });
  inp.click();
}

// ---------------- 回收区（FIX-04）：删除后的恢复入口 ----------------
// 背景：删除是「归档代替删除」——目录搬进回收区、数据不丢，但此前**没有任何恢复入口**，
// 删掉就找不回来。服务端补齐了 GET /api/profiles/trash 与 POST /api/profiles/trash/<id>/restore，
// 这里是最小可用入口（桌面端 / 手机端各一份同源实现，字段与文案保持一致）。
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

/** 回收区面板：列出被删除（进回收区）的档案，每项带「恢复」 */
function openProfileTrash() {
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('trash')} 回收站</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { closeModal(); openProfileManager(); });
  head.appendChild(close);
  const body = el('div', 'mbody');
  body.appendChild(el('p', 'hint', '删除档案只是把它移进回收区，战绩、笔记与经验池都还在。点「恢复」即可一步搬回档案列表，恢复后立刻可用。'));
  const msg = el('p', 'hint');
  msg.id = 'pm-trash-msg';
  msg.setAttribute('role', 'status');
  body.appendChild(msg);
  const list = el('div', 'pm-list');
  list.id = 'pm-trash-list';
  list.dataset.state = 'loading';
  body.appendChild(list);
  const backRow = el('div', 'btnrow');
  const back = el('button', 'btn ghost', '← 返回档案列表');
  back.addEventListener('click', () => { closeModal(); openProfileManager(); });
  backRow.appendChild(back);
  body.appendChild(backRow);
  wrap.append(head, body);
  openModal(wrap);
  renderProfileTrash(list, msg);
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
  state.annoUndo = null;
  try { state.tags = window.WWGameDraft.readTags(localStorage, 'ww_tags_', state.game.gameId); } catch (_) { state.tags = {}; }
  $('#stream').innerHTML = '';
  // FIN-10：座位结构作废（换局/人数可能变化），首次渲染全量重建，之后逐座位补丁
  state.seatNodes = new Map();
  state.seatListNodes = new Map();
  state.seatStructKey = '';
  state.newMsgCount = 0;
  state.lastErrSig = null;
  hideNewMsgPill();
  bindGameChrome();
  applySeatView();
  applyNotesMode();
  renderTopbarIdentity();
  loadGameMeta(); // 结算层要如实标注试玩/真实（视图负载里没有 mock 字段）
  initAnnotations(); // NOTE-03/05：拉取本局标注 + 旧 ww_tags_ 一次性迁移
  startPolling();
}

/**
 * 顶栏与布局的交互只绑一次：重复 enterGameScreen（恢复/重进）不得叠加监听，
 * 否则一次点击触发多次 toggle（FIN-10「重复进入不叠加提交」的桌面半边）。
 */
function bindGameChrome() {
  const once = (sel, fn) => {
    const n = $(sel);
    if (n && !n.dataset.bound) { n.dataset.bound = '1'; n.addEventListener('click', fn); }
  };
  once('#btn-gear', openGearMenu);
  once('#btn-notes', toggleNotesDrawer);
  once('#btn-notes-close', toggleNotesDrawer);
  once('#seat-view-ring', () => setSeatView('ring'));
  once('#seat-view-list', () => setSeatView('list'));
  const stream = $('#stream');
  if (stream && !stream.dataset.scrollBound) {
    stream.dataset.scrollBound = '1';
    // 历史阅读锚点（FIN-10）：滚回底部即清除"新发言"计数
    stream.addEventListener('scroll', () => {
      if (streamNearBottom(stream)) hideNewMsgPill();
    }, { passive: true });
  }
  const pill = $('#new-msg-pill');
  if (pill && !pill.dataset.bound) {
    pill.dataset.bound = '1';
    pill.addEventListener('click', () => {
      scrollBottomInstant($('#stream'));
      hideNewMsgPill();
    });
  }
  if (!state.notesModeBound) {
    state.notesModeBound = true;
    if (window.matchMedia) {
      try {
        matchMedia('(min-width: 1280px)').addEventListener('change', applyNotesMode);
      } catch (_) { /* 老 WebView 无 addEventListener 版本：跳过动态切换，刷新后生效 */ }
    }
  }
}

/** 座位视图切换（FIN-05）：纯显示层切换 —— 不清笔记草稿、不改已选目标、不重新建局 */
function applySeatView() {
  const ring = $('#seats');
  const list = $('#seats-list');
  const isList = state.seatView === 'list';
  if (ring) ring.classList.toggle('hidden', isList);
  if (list) list.classList.toggle('hidden', !isList);
  const bRing = $('#seat-view-ring');
  const bList = $('#seat-view-list');
  if (bRing) { bRing.classList.toggle('sel', !isList); bRing.setAttribute('aria-pressed', String(!isList)); }
  if (bList) { bList.classList.toggle('sel', isList); bList.setAttribute('aria-pressed', String(isList)); }
}

function setSeatView(view) {
  if (view !== 'ring' && view !== 'list') return;
  state.seatView = view;
  try { localStorage.setItem('ww_seat_view', view); } catch (_) { /* 隐私模式忽略 */ }
  applySeatView();
  if (state.lastView) updateSeats(state.lastView); // 新视图立刻带上当前目标/票数状态
}

/** 笔记右栏模式（FIN-05）：≥1280px 常驻右栏（.docked），更窄时回到既有抽屉机制 */
function notesDocked() { return !!(window.matchMedia && matchMedia('(min-width: 1280px)').matches); }

function applyNotesMode() {
  const d = $('#notes-drawer');
  if (!d) return;
  if (notesDocked()) {
    d.classList.add('docked');
    $('#screen-game').classList.toggle('notes-collapsed', !!state.notesCollapsed);
    d.classList.toggle('hidden', !!state.notesCollapsed);
  } else {
    d.classList.remove('docked');
    $('#screen-game').classList.remove('notes-collapsed');
    d.classList.add('hidden'); // 抽屉模式默认收起，由顶栏 📝 打开
  }
  if (!d.classList.contains('hidden')) renderNotesList();
}

function toggleNotesDrawer() {
  const d = $('#notes-drawer');
  if (notesDocked()) {
    // 常驻右栏模式：📝 按钮 = 收起/展开右栏
    state.notesCollapsed = !state.notesCollapsed;
    applyNotesMode();
    return;
  }
  const opening = d.classList.contains('hidden');
  $('#god-drawer').classList.add('hidden'); // 两个抽屉互斥
  d.classList.toggle('hidden');
  if (opening) renderNotesList();
}

/** 当前局的元数据（mock 等）：视图负载里没有，结算层要如实标注，懒加载一次并缓存 */
async function loadGameMeta() {
  if (!state.game) return;
  if (state.gameMeta && state.gameMeta.gameId === state.game.gameId) return;
  try {
    const { rows } = await api('GET', '/api/games');
    const r = (rows || []).find((x) => x.id === state.game.gameId);
    state.gameMeta = r ? { gameId: r.id, mock: !!r.mock, seats: r.seats || null } : { gameId: state.game.gameId, mock: !!state.game.mock };
  } catch (_) {
    state.gameMeta = { gameId: state.game && state.game.gameId, mock: !!(state.game && state.game.mock) };
  }
  if (state.view && state.view.finished) renderCoach(state.view); // 迟到的元数据补一次结算标识
}

/**
 * 齿轮菜单：把顶栏原来那排按钮（规则书 / 上帝 / 结束本局 / APP端 / 首页）收进一处。
 * 与手机端同一套信息架构：设置类入口只有一个齿轮，退出类操作也放在里面。
 */
function openGearMenu() {
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('settings')} 设置</h2>`);
  const close = el('button', 'btn ghost small', ico('close'));
  close.addEventListener('click', () => { closeModal(); });
  head.appendChild(close);
  const body = el('div', 'mbody');
  const list = el('div', 'gear-list');
  const v = state.view;
  // 齿轮菜单条目 = [文案, 徽记 id, 动作]，由下面的渲染处拼成「徽记 + 纯文本」。
  // ⚠ 顺序只能是"文案在前、徽记 id 在后"：test/css.test.js:502 用一条形态断言
  //   （`items.push([` 之后紧跟一个单引号字符串，该串以"结束本局"结尾）来证明
  //   §3 行77「危险操作不能只靠红色表达」——危险条目必须**带可见文案**。
  //   那个文件不在本批可改范围，所以这里不能把 icoLabel(...) 直接放在数组首元素的位置。
  const items = [
    ['规则书', 'rulebook', () => openRulebook()],
    [I18N.t('codex.entry'), 'codex', () => openCodex()],
    ['我的身份牌', 'card', () => { if (v && v.me && v.me.role) openInspect(v.me.role); }],
    ['私人笔记', 'notes', () => toggleNotesDrawer()],
    [`上帝视角（当前${state.godMode ? '开' : '关'}）`, 'god', () => toggleGod()],
    [`切换语言（当前${I18N.getLang() === 'en' ? ' English' : ' 中文'}）`, 'lang', () => switchLangDesktop()],
    ['手机 APP 端', 'mobile', () => { window.location.href = '/m/'; }],
  ];
  if (v && !v.finished) items.push(['结束本局', 'end', () => terminateGame()]);
  items.push(['返回首页', 'home', () => backHome()]);
  items.forEach(([label, icon, fn], i) => {
    const b = el('button', 'gear-item' + (i === items.length - 1 ? '' : ''), icoLabel(icon, label));
    if (/结束本局/.test(label)) b.classList.add('danger');
    b.addEventListener('click', () => { closeModal(); fn(); });
    list.appendChild(b);
  });
  body.appendChild(list);
  body.appendChild(el('p', 'hint', '对局中随时可以打开此菜单；上帝视角会给所有 AI 提示注入裁判信息，仅供调试。'));
  wrap.append(head, body);
  openModal(wrap);
}

function switchLangDesktop() {
  I18N.setLang(I18N.getLang() === 'en' ? 'zh-CN' : 'en');
  // 语言档位换的是 data-i18n 的文案，而 i18n 词典里的导航文案仍带前导图标字形
  // （📖 角色图鉴…）：applyI18n 会整块重写 textContent，把徽记一起抹掉。
  // 所以这里必须**在 setLang 之后**按 data-ww-icon 重画一遍 —— 否则切一次语言，
  // 图标就退回到 emoji（这正是"两端行为一致"最容易被破坏的一步）。
  window.WWIcons.mount(document);
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
  try { legacy = window.WWGameDraft.readLegacyTags(localStorage, 'ww_tags_', gid); } catch (_) {}
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
        try { window.WWGameDraft.writeTags(localStorage, 'ww_tags_', gid, pending); } catch (_) {}
        state.tags = pending;
        openLegacyPendingPrompt(pending);
      } else {
        window.WWGameDraft.clearTags(localStorage, 'ww_tags_', gid); // 全部落盘确认后才清理
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
  const head = el('div', 'mhead', `<h2>${ico('tag')} 旧标记待确认</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { closeModal(); });
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
      closeModal();
      openTagModal(Number(seat)); // 编辑保存成功后该座位即并入；失败/取消则仍留在待确认记录里
    });
    const drop = el('button', 'btn small danger', '丢弃旧标记');
    drop.addEventListener('click', () => {
      delete pending[seat];
      try {
        if (Object.keys(pending).length) window.WWGameDraft.writeTags(localStorage, 'ww_tags_', state.game.gameId, pending);
        else window.WWGameDraft.clearTags(localStorage, 'ww_tags_', state.game.gameId);
      } catch (_) {}
      closeModal();
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
  const prev = state.anno.seats[seat] ? JSON.parse(JSON.stringify(state.anno.seats[seat])) : null; // 撤销快照（§11 行11）
  return api('PUT', `/api/games/${gid}/annotations`, { token, expectedRevision: state.anno.rev, seats: { [seat]: entry } })
    .then((r) => {
      state.anno.rev = r.revision;
      state.anno.seats = r.annotations.seats || {};
      state.annoUndo = { seat, prev }; // 仅记录最近一次；撤销不复用游戏行动撤销
      updateSeats(state.view);
      if (!$('#notes-drawer').classList.contains('hidden')) renderNotesList();
      return true;
    })
    .catch((e) => {
      if (e.status === 409) {
        // 并发冲突（方案 §4.5）：另一窗口改过。给出"载入最新并保留我这版"的人工合并路径，绝不静默覆盖。
        const keep = entry; // 本地编辑的这份
        const box = el('div', 'annotation-conflict');
        box.appendChild(el('p', 'hint', '⚠ 另一个窗口更新了笔记（版本冲突）。可选择：载入最新笔记（保留你正在编辑的这一个座位的修改）或放弃本次修改。'));
        const br = el('div', 'btnrow');
        const merge = el('button', 'btn', '载入最新并保留我的修改');
        merge.addEventListener('click', async () => {
          merge.disabled = true;
          try {
            const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
            state.anno.rev = r.revision;
            state.anno.seats = r.annotations.seats || {};
            if (await saveAnnotations(seat, keep)) closeModal();
          } catch (_) { alert('合并保存仍失败，草稿已保留，请稍后重试'); }
          finally { merge.disabled = false; }
        });
        const discard = el('button', 'btn ghost', '放弃我的修改');
        discard.addEventListener('click', async () => {
          try {
            const r = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
            state.anno.rev = r.revision;
            state.anno.seats = r.annotations.seats || {};
            closeModal();
            updateSeats(state.view);
          } catch (_) { alert('无法载入最新笔记，草稿仍保留'); }
        });
        br.append(merge, discard);
        box.appendChild(br);
        const editor = document.querySelector('#modal-root .mbody');
        if (editor) {
          const previous = editor.querySelector('.annotation-conflict');
          if (previous) previous.remove();
          editor.appendChild(box); // 原输入框与草稿关闭守卫留在原位，不销毁再声称已保留。
          box.scrollIntoView({ block: 'nearest' });
        } else openModal(box, { onDismiss: () => { if (confirm('放弃尚未保存的笔记修改？')) closeModal(); } });
      } else {
        alert(`保存失败：${e.message}\n（草稿仍在输入框里，未丢失）`);
      }
      return false;
    });
}

/**
 * 清除一个座位的私人标注（FIX-07）：走服务端的 **DELETE 语义**，而不是"PUT 一份空标注"。
 * 为什么必须删：PUT 空标注只是把内容清空，座位键仍然留在 `doc.seats` 里 ——
 *   · 导出包里 `counts.notes` 按"有 seats 的游戏"计数（src/profiles/transfer.js:59 +
 *     src/api.js 收集 notes 时判 `Object.keys(doc.seats).length`），于是已清空的座位把计数撑高；
 *   · 标注文件只增不减，座位键永远清不掉。
 * 契约（src/api.js 的 gameAnnotationDelete，路由 DELETE /api/games/:id/annotations）：
 *   `?token=&seat=N&expectedRevision=R` → 200 { annotations, revision }；
 *   seat 非数字 400、令牌/权限不足 403、revision 过期 409。
 * 与 PUT 一致带 expectedRevision 做乐观并发：409 时重新拉取最新版本后重试一次（不无限重试）。
 * 失败要可读：把原因说出来，并明确草稿没丢。
 */
async function clearSeatAnnotation(seat) {
  const gid = state.game.gameId;
  const token = state.game.playerToken || state.game.godToken;
  const prev = state.anno.seats[seat] ? JSON.parse(JSON.stringify(state.anno.seats[seat])) : null;
  const del = () => api('DELETE', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}&seat=${seat}&expectedRevision=${state.anno.rev}`);
  try {
    let r;
    try {
      r = await del();
    } catch (e) {
      if (e.status !== 409) throw e;
      const fresh = await api('GET', `/api/games/${gid}/annotations?token=${encodeURIComponent(token)}`);
      state.anno.rev = fresh.revision;
      state.anno.seats = fresh.annotations.seats || {};
      r = await del();
    }
    state.anno.rev = r.revision;
    state.anno.seats = r.annotations.seats || {}; // 以服务端返回为准：座位键真的没了，列表/角标才不会再显示
    state.annoUndo = { seat, prev };              // 清除也能撤销（与 PUT 成功后的语义一致）
    updateSeats(state.view);
    if (!$('#notes-drawer').classList.contains('hidden')) renderNotesList();
    return true;
  } catch (e) {
    alert(`清除失败：${e.message}\n（笔记仍在，未丢失）`);
    return false;
  }
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

  // §9.3 :302 笔记草稿按 **owner + gameId + seat** 保存（**不按当前浏览档案归属**）：
  // 打开时先看看这个座位有没有上次没提交的草稿 —— 切到别的档案看一眼战绩再回来，内容必须还在。
  // ⚠ 这里只能走 `state` 上的钩子（钩子在本文件 openTagModal **之前**登记到 `state.noteDraftHook`）：
  //   本函数被 test/annotation-editor.test.js **整段抽出来**丢进一个只有 el/state/… 的 vm 沙箱里单跑，
  //   引用任何新全局（window / ico / …）都会让那条既有用例当场 ReferenceError。
  const hook = state.noteDraftHook || null;
  const savedDraft = hook ? hook.load(seat) : null;
  if (savedDraft && typeof savedDraft === 'object') {
    for (const k of Object.keys(draft)) if (savedDraft[k] !== undefined && savedDraft[k] !== null) draft[k] = savedDraft[k];
  }
  /** 草稿变更即落**会话存储**（切档/关弹层都不销毁它；保存成功或显式清除才删） */
  const persist = () => { if (hook) hook.save(seat, draft); };

  const wrap = el('div');
  const name = (v.players.find((p) => p.seat === seat) || {}).name || '';
  // ⚠ 这里用声明式的 `data-ww-icon`（由 openModal 统一挂载），**不是** ico()：
  // test/annotation-editor.test.js 会把本函数整段切出来丢进一个只有 el/escapeHtml/… 的
  // vm 沙箱里真跑一遍（用来抓"正文没进 dirty 判断"这类闭包错误），沙箱里没有 ico 也没有
  // window。调用任何外部辅助函数都会让那三条既有断言直接 ReferenceError。
  // 所以：**会被整段抽出来单跑的弹层函数，一律不许调用沙箱里没有的全局**。
  const head = el('div', 'mhead', `<h2 data-ww-icon="notes">${seat} 号的私人笔记</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => {
    if (dirty() && !confirm('有未保存的修改，确定放弃？')) return;
    closeModal();
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

  // ④ 自称身份（TA 声称的，不等于你信的）。AC-07：自称 ≠ 候选——
  // 候选池扣除本人唯一身份是"我的推测"的语义；自称要能记录对跳（他人声称你的唯一身份），
  // 所以列出全板子角色，不按 possibleRolesFor 过滤
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
  const noteL = el('label', null, `<span>笔记（最多 ${A_.MAX_NOTE} 字；可记录"依据第几条发言"）</span>`);
  const noteI = el('textarea');
  noteI.maxLength = A_.MAX_NOTE;
  noteI.rows = 3;
  noteI.value = draft.note;
  noteI.addEventListener('input', () => { draft.note = noteI.value; });
  noteI.placeholder = '例：跳预言家但查杀方向存疑，依据第 12 条发言';
  noteL.appendChild(noteI);
  body.appendChild(noteL);
  const evL = el('label', null, '<span>依据事件序号（选填，发言流里每条前的 #号）</span>');
  const evI = el('input');
  evI.type = 'number';
  evI.min = '1';
  evI.value = draft.evidenceSeq || '';
  evI.addEventListener('input', () => { draft.evidenceSeq = evI.value ? Number(evI.value) : null; });
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
    if (okFlag) { if (hook) hook.clear(seat); closeModal(); } // 保存成功 ⇒ 该座位的草稿已经落盘，删掉
    else save.disabled = false;
  });
  br.appendChild(save);
  if (cur && (cur.leaning !== 'neutral' || (cur.candidateRoleIds || []).length || cur.claimedRoleId || cur.note)) {
    const clr = el('button', 'btn danger', '清除此座位笔记');
    clr.addEventListener('click', async () => {
      save.disabled = true;
      clr.disabled = true;
      // FIX-07：真正删除（DELETE），不是写一份空标注 —— 否则座位键留在 doc.seats 里，计数虚高
      const okFlag = await clearSeatAnnotation(seat);
      if (okFlag) { if (hook) hook.clear(seat); closeModal(); } // 显式清除 = 该座位草稿作废
      else { save.disabled = false; clr.disabled = false; }
    });
    br.appendChild(clr);
  }
  body.append(br, err);
  wrap.append(head, body);
  // 草稿落盘用**事件委托**挂一次：弹层里几十个控件（倾向/把握/候选/自称/正文/依据）逐个挂必然漏，
  // 漏掉的那个字段在切档或换座位时就串了。各控件自己的监听器先跑，冒泡到这里时 draft 已经是最新的。
  wrap.addEventListener('input', persist);
  wrap.addEventListener('change', persist);
  wrap.addEventListener('click', persist);
  openModal(wrap, { onDismiss: () => close.click() });
  // §5.2 登记给切档守卫：本窗口有未保存笔记 ⇒ 切档先确认。
  // 必须在 openModal **之后**登记 —— openModal 开头会清掉上一个弹层的 dirty 引用。
  state.noteDirty = dirty;
}

// ---------------- 笔记列表（NOTE-03）：抽屉/右栏共用同一份渲染 ----------------
function renderNotesList() {
  const box = $('#notes-list');
  if (!box) return;
  box.innerHTML = '';
  const v = state.view;
  if (!state.anno.loaded) { box.appendChild(el('p', 'hint', '标注加载中…')); return; }
  if (!v) { box.appendChild(el('p', 'hint', '对局尚未开始')); return; }
  // 最近一次笔记撤销（§11 行11）：独立于游戏行动撤销；仅记录最近一次
  if (state.annoUndo && state.annoUndo.seat != null) {
    const u = el('div', 'pm-row current');
    const um = el('div', 'pm-main');
    um.appendChild(elText('div', 'pm-name', `${state.annoUndo.seat} 号刚被修改`));
    um.appendChild(el('div', 'hint', '可撤销回修改前的内容'));
    u.appendChild(um);
    const uo = el('div', 'pm-ops');
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
        alert(`撤销失败：${e.message}`);
      }
      updateSeats(state.view);
      renderNotesList();
    });
    uo.appendChild(ub);
    u.appendChild(uo);
    box.appendChild(u);
  }
  const entries = Object.entries(state.anno.seats || {})
    .filter(([, a]) => a && (a.leaning !== 'neutral' || (a.candidateRoleIds || []).length || a.claimedRoleId || a.note));
  if (!entries.length) {
    box.appendChild(el('p', 'hint', `还没有笔记。点击圆桌座位上的 ${ico('tag')} 开始标注；这里是全部笔记的汇总列表。`));
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
    setHint('对局已终止，全场亮牌 ✓', 'ok');
    // 终止是终态：立刻把"当前对局"从 localStorage 里清掉。
    // 以前只在 poll 循环里根据 view.finished 清，而中止那一刻循环可能已经 break 了，
    // 于是残留下来，下次进页面会被当成活局恢复（P2-c，桌面/移动双端都复现过）。
    window.WWGameDraft.clearHandle(localStorage, 'ww_current');
  } catch (e) { setHint(`✗ ${e.message}`, 'err'); }
}

function backHome() {
  stopPolling();
  if (!state.view || !state.view.finished) window.WWGameDraft.writeHandle(localStorage, 'ww_current', state.game);
  else window.WWGameDraft.clearHandle(localStorage, 'ww_current');
  location.reload();
}

function startPolling() {
  // M1：停旧 → 建推送 → 否则退回轮询 的顺序判断收在共享模块（两端原本逐字相同的四行）
  window.WWConnectionState.startConnection({ stopPolling, startStream, startFallback: startPollFallback });
}
function startPollFallback() {
  if (!window.WWConnectionState.beginFallback(state, poll)) return; // 已在轮询：不叠定时器（与原来同义）
  setConnDot('warn', '实时推送不可用，已转为轮询（每 30s 自动尝试恢复推送）');
  // 降级不是终态（P2-a）：每 30s 试着重连推送，成功就撤掉提示、回到推送通道。
  // 原来一旦降级就再也回不去，横幅还会永久挂在事件流里。
  if (!state.streamRetry) {
    state.streamRetry = setInterval(() => {
      if (!window.WWConnectionState.canRetryPush(state)) return;
      if (startStream()) setStreamStatus(null);
    }, window.WWConnectionState.PUSH_RETRY_MS);
  }
  poll();
}
function stopPolling() {
  if (state.streamRetry) { clearInterval(state.streamRetry); state.streamRetry = null; }
  window.WWConnectionState.stopConnection(state, ['stream', 'godStream']);
}

/**
 * SSE 推送（P2-2）：服务端只在**真的有变化**时推一帧，省掉 1.2s 轮询的空转往返。
 *
 * 关键设计：推送是**优化而不是依赖**。浏览器不支持、反代缓冲、连接被断——
 * 任一情况下都自动回退到轮询，游戏照常进行（服务端两条通道共用同一份视图负载，
 * 所以两种模式的渲染结果逐字段一致，不会出现"刷新一下才对"的差异）。
 */
function startStream() {
  if (!window.WWConnectionState.canStream(state)) return false; // 不支持 SSE / 没有对局（两端原本逐字相同的三行）
  const g = state.game;
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
      // M1：判空那一跳收进共享模块；阈值（本端 36s）与降级动作仍留在本端
      window.WWConnectionState.watchdogTick(state, () => Date.now() - (state.lastStreamAt || 0) > STREAM_DEAD_MS, () => {
        setStreamStatus('⚠️ 推送连接无响应，已转为轮询（每 30s 自动尝试恢复推送）');
        stopStream();
        startPollFallback();
      });
    }, 4000);
    setStreamStatus(null); // 连上了就把降级提示撤掉（P2-a）
    setConnDot('ok', '实时推送已连接（对局自动保存于服务端）');
    return true;
  } catch (e) {
    stopStream();
    return false;
  }
}

function openViewStream(kind, token, cursorOf) {
  // M1：建流 + 四个监听器接线收在共享模块（两端原本逐字相同）；帧往哪条视图塞、提示怎么写仍在本端
  return window.WWConnectionState.openStream({
    kind,
    url: window.WWConnectionState.streamUrl(state.game.gameId, token, cursorOf()),
    onActivity: () => { state.lastStreamAt = Date.now(); },
    // 玩家流传玩家视图，上帝流传上帝视图；applyView 会沿用另一侧的上一帧
    onFrame: (k, v) => { if (k === 'god') applyView(null, v); else applyView(v, null); },
    onEnd: () => {
      state.lastStreamAt = Date.now();
      stopStream();
      // 对局结束/被清理：拉一次终局状态（结算分数、终局事件）后停更
      poll();
    },
    // 服务端明确报错（视图构造失败等）：不能静默卡死，回退轮询并把原因显示出来
    onError: () => {
      stopStream();
      setStreamStatus('⚠️ 推送通道中断，已转为轮询（每 30s 自动尝试恢复推送）');
      startPollFallback();
    },
  });
}

function stopStream() {
  window.WWConnectionState.stopStreams(state, ['stream', 'godStream']);
}

async function poll() {
  const g = state.game;
  if (!g) return;
  try {
    // 玩家视图：始终拉取（提供 pending 操作与"我"的信息）
    const pv = await api('GET', window.WWConnectionState.viewUrl(g.gameId, g.playerToken || g.godToken, state.playerAfter || 0));
    // 上帝视图：开启时另拉全量事件
    let gv = null;
    if (state.godMode) gv = await api('GET', window.WWConnectionState.viewUrl(g.gameId, g.godToken, state.godAfter || 0));
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
/** 同帧合并刷新（FIN-10）：一帧内到达的多份视图只触发一次完整重绘，避免每个字块都跑一遍布局 */
let renderQueued = false;
function scheduleGameRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { renderQueued = false; renderGameFrame(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function renderGameFrame() {
  const P = state.playerView || null;
  const G = state.godView || null;
  const primary = state.godMode ? (G || P) : P;
  if (!primary || !state.view) return;
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
  if (mine.error && state.lastErrSig !== mine.error) {
    state.lastErrSig = mine.error;
    appendSys(`⚠️ 对局异常：${mine.error}`);
  }
  if (state.godMode) renderGodStats();
}

function applyView(pv, gv) {
  if (pv) state.playerView = pv;
  if (gv) state.godView = gv;
  const P = state.playerView || null;
  const G = state.godView || null;
  const primary = state.godMode ? (G || P) : P;
  if (!primary) return;
  const hadView = !!state.view;
  state.view = state.godMode ? { ...primary, me: P && P.me, pending: P && P.pending } : P;
  // 首帧 view 到达时刷新笔记抽屉：抽屉可能在标注先到、view 未到时渲染过"对局尚未开始"假态（UI 审查）
  if (!hadView && state.view && !$('#notes-drawer').classList.contains('hidden')) renderNotesList();
  const fresh = (list, cursor) => (list || []).filter((e) => e.seq > (cursor || 0));
  const playerEvents = fresh(P && P.events, state.playerAfter);
  const godEvents = fresh(G && G.events, state.godAfter);
  if ((state.godMode ? state.godAfter : state.playerAfter) === 0) {
    $('#stream').innerHTML = '';
    hideNewMsgPill();
    state.seatNames = {};
    for (const p of primary.players) state.seatNames[p.seat] = p.name;
  }
  appendEvents(state.godMode ? godEvents : playerEvents);
  if (godEvents.length) state.godAfter = Math.max(state.godAfter || 0, ...godEvents.map((e) => e.seq));
  if (playerEvents.length) state.playerAfter = Math.max(state.playerAfter || 0, ...playerEvents.map((e) => e.seq));
  scheduleGameRender();
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
    `<button class="btn primary" id="btn-resume-paused">${icoLabel('resume', '继续对局')}</button>` +
    `<button class="btn ghost" id="btn-terminate-paused">${icoLabel('end', '终止本局')}</button>` +
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
    state.game = { ...g, gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken };
    window.WWGameDraft.writeHandle(localStorage, 'ww_current', state.game);
    state.playerAfter = 0; state.godAfter = 0;
    state.playerView = null; state.godView = null; // 换了新对局，缓存帧作废
    $('#stream').innerHTML = '';
    const box = $('#paused-banner');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; }
    await poll();
  } catch (e) {
    alert(`恢复失败：${e.message}`);
    if (btn) { btn.disabled = false; btn.innerHTML = icoLabel('resume', '继续对局'); }
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
    state.liveSkel = '';
    state.liveSince = null; // 下一段直播重新计时，避免沿用上一个人的秒表
    return;
  }
  const text = l ? l.text || '' : '';
  const reasoning = l ? l.reasoning || '' : '';
  const canSeeText = !!l && (!!l.public || !!state.godMode);
  const secs = l ? Math.max(0, Math.round((Date.now() - liveSince(`${l.seat}|${l.task || ''}`)) / 1000))
    : Math.max(0, Math.round((Date.now() - vp.at) / 1000));
  const sig = `${l ? l.seat : 0}|${l ? l.task : ''}|${text.length}|${reasoning.length}|${state.godMode ? 1 : 0}|${secs}|${vp ? `${vp.done}/${vp.total}` : ''}`;
  if (node0 && state.liveSig === sig) return; // 内容未增长：不写 DOM
  state.liveSig = sig;
  let node = node0;
  if (!node) {
    node = el('div', 'msg typing');
    node.id = 'live-typing';
    $('#stream').appendChild(node);
  }
  // FIN-10 流式更新当前节点：骨架（谁在说/什么形态）只在一段直播开始或形态变化时重建；
  // 之后每个字块只写正文与计数两个文本节点，不重建整个气泡。
  const who = l ? seatLabel(l.seat) : '';
  const skelSig = `${l ? l.seat : 0}|${l ? l.task : ''}|${canSeeText ? 1 : 0}|${state.godMode ? 1 : 0}|${vp && !l ? 1 : 0}`;
  if (state.liveSkel !== skelSig || !node.firstChild) {
    state.liveSkel = skelSig;
    if (vp && !l) {
      node.innerHTML = '<div class="meta"><span class="typing-tag">… 正在收集投票</span></div>'
        + '<div class="typing-body muted"><span class="typing-count"></span></div>';
    } else {
      const tag = canSeeText && text ? '✍ 正在发言' : (text ? '… 正在决策' : '… 正在思考');
      node.innerHTML = `<div class="meta"><span class="who">${who}</span> <span class="typing-tag">${tag}</span> <span class="typing-count"></span></div>`
        + (canSeeText
          ? '<div class="typing-body"><span class="typing-text"></span><span class="caret"></span></div>'
          : '<div class="typing-body muted">正在思考…<span class="caret"></span></div>')
        + (state.godMode ? '<div class="typing-reason" hidden></div>' : '');
    }
  }
  const count = node.querySelector('.typing-count');
  if (count) {
    count.textContent = vp && !l
      ? `已思考 ${vp.done}/${vp.total} · ${secs}s`
      : `已 ${secs}s${canSeeText && text ? ` · ${text.length} 字` : ''}${state.godMode && reasoning ? ` · 思考 ${reasoning.length} 字` : ''}`;
  }
  const tNode = node.querySelector('.typing-text');
  if (tNode) tNode.textContent = text;
  const rNode = node.querySelector('.typing-reason');
  if (rNode) {
    if (state.godMode && reasoning) { rNode.hidden = false; rNode.textContent = `💭 ${reasoning.slice(-400)}`; }
    else rNode.hidden = true;
  }
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

/** 用户是否停留在事件流底部附近（锚点判定，FIN-10）：在底部才自动跟随，上翻时不被拉走 */
function streamNearBottom(s) { return s.scrollHeight - s.scrollTop - s.clientHeight < 160; }

/**
 * 程序化滚底必须**瞬时**完成：#stream 带 scroll-behavior:smooth，平滑动画期间
 * "距底部距离"始终非零 —— 下一帧就会误判"用户在上翻"，跟随永久脱钩（实测 227 条误报）。
 */
function scrollBottomInstant(s) {
  if (!s) return;
  const prev = s.style.scrollBehavior;
  s.style.scrollBehavior = 'auto';
  s.scrollTop = s.scrollHeight;
  s.style.scrollBehavior = prev;
}

function autoScroll() {
  const s = $('#stream');
  if (s && streamNearBottom(s)) scrollBottomInstant(s);
}

/**
 * 追加一条流内容（FIN-10 历史阅读锚点）：
 * 用户本来就在底部 → 跟随滚到最新；上翻阅读时 → 不拉走视线，累计条数显示"有 N 条新发言"胶囊。
 */
function pushStream(node) {
  if (!node) return;
  const s = $('#stream');
  if (!s) return;
  const follow = streamNearBottom(s);
  s.appendChild(node);
  if (follow) scrollBottomInstant(s);
  else { state.newMsgCount = (state.newMsgCount || 0) + 1; showNewMsgPill(); }
}

function showNewMsgPill() {
  const pill = $('#new-msg-pill');
  if (!pill) return;
  pill.textContent = `↓ 有 ${state.newMsgCount} 条新发言`;
  pill.classList.remove('hidden');
}

function hideNewMsgPill() {
  state.newMsgCount = 0;
  const pill = $('#new-msg-pill');
  if (pill) pill.classList.add('hidden');
}

function appendSys(text) { pushStream(el('div', 'sysline', text)); }

/**
 * 推送通道状态条（P2-a）：唯一且会被更新的一个元素。
 * 原来断线时 appendSys 追加一条"已切换为轮询"，既不会被撤掉、重连成功也无从体现 ——
 * 横幅永久留在事件流里，玩家分不清"现在到底走的是推送还是轮询"。
 */
function setStreamStatus(text) {
  let n = document.getElementById('stream-status');
  if (!text) { if (n) n.remove(); return; }
  setConnDot('warn', text); // 连接/保存状态点（FIN-05 顶栏）与流内状态条同源
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
  while (state.nightQueue && state.nightQueue.length) {
    const e = state.nightQueue.shift();
    state.lastNightStep = e.data; // 调试面板/观战要看"当前第几步"，随播放推进
    clearNightWait();
    pushStream(renderEventNode(e));
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
  for (const e of state.nightQueue) {
    state.lastNightStep = e.data;
    pushStream(renderEventNode(e));
  }
  state.nightQueue = [];
  clearNightWait();
}

function appendEvents(events) {
  const stream = $('#stream');
  // 先记锚点再批量追加：避免每条消息各读一次 scrollHeight（大历史导入时的布局抖动）
  const wasNearBottom = stream ? streamNearBottom(stream) : true;
  let added = 0;
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
    if (node && stream) { stream.appendChild(node); added++; }
  }
  // 追加完统一处理一次滚动/锚点（FIN-10）：在底部才跟随，上翻时只累计"新发言"条数
  if (added && stream) {
    if (wasNearBottom) scrollBottomInstant(stream);
    else { state.newMsgCount = (state.newMsgCount || 0) + added; showNewMsgPill(); }
  }
  if (state.nightQueue && state.nightQueue.length) playNightBroadcast();
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
  if (state.game) state.game = window.SessionModel.withView(state.game, v);
  renderTopbarIdentity();
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

/**
 * 座位渲染（FIN-10 增量化）：以 seat 为 key 复用节点。
 * 结构签名（人数/我的座位/视角）变化才全量重建（换局/人数变化兜底）；
 * 其余更新逐座位算签名打补丁 —— 发言字块、直播帧绝不清空重建全部座位，
 * 未变化的座位节点保持同一引用（头像 <img> 不重复创建，不再每帧重排）。
 */
function updateSeats(v) {
  const box = $('#seats');
  if (!box || !Array.isArray(v.players)) return;
  const mySeat = v.me ? v.me.seat : 0;
  // 同步上帝面板的座位下拉（AI 座位）
  const godSel = $('#god-seat');
  if (state.godMode && godSel && Number(godSel.dataset.count) !== v.players.length) {
    godSel.dataset.count = v.players.length;
    godSel.innerHTML = '';
    for (const p of v.players) {
      if (p.isHuman) continue;
      // 安全（SEC-02）：昵称用户可控，option 文本也要转义
      godSel.appendChild(el('option', null, `${p.seat}号 ${escapeHtml(p.name)}`)).value = p.seat;
    }
  }
  state.lastView = v;
  const structKey = `${v.players.length}|${mySeat}|${state.godMode ? 1 : 0}`;
  if (structKey !== state.seatStructKey || !state.seatNodes.size) buildSeatStructure(v, structKey);
  updateRingCore(v);
  const liveSeat = v.live && v.live.seat ? Number(v.live.seat) : 0;
  const ctx = {
    mySeat, liveSeat,
    me: v.me || null,
    n: v.players.length || 1,
    tally: state.voteTally || {},
    portraits: window.AICast ? window.AICast.assignPortraits(v.players) : new Map(),
  };
  v.players.forEach((p, i) => {
    patchSeatNode(state.seatNodes.get(p.seat), p, i, ctx);
    patchSeatRow(state.seatListNodes.get(p.seat), p, i, ctx);
  });
}

/** 结构变化时的全量重建（人数变化 / 换局 / 视角切换）：一次搭好骨架，之后只打补丁 */
function buildSeatStructure(v, structKey) {
  state.seatStructKey = structKey;
  state.seatNodes = new Map();
  state.seatListNodes = new Map();
  const box = $('#seats');
  box.innerHTML = '';
  const list = $('#seats-list');
  if (list) list.innerHTML = '';
  // 布局：座位按椭圆均分，坐标在 JS 里算好写成 --x/--y（百分比）。
  // 为什么不用 CSS 的 sin()/cos()：部分 WebView 没有这两个函数，退化后所有座位会叠在圆心。
  const ring = el('div', 'ring-stage');
  ring.appendChild(ringSvg());
  const core = el('div', 'ring-core');
  core.id = 'ring-core';
  ring.appendChild(core);
  const n = v.players.length || 1;
  const portraits = window.AICast ? window.AICast.assignPortraits(v.players) : new Map();
  v.players.forEach((p, i) => {
    // -90° 起（正上方），顺时针铺开；半径按人数微调（人越多越贴边，避免互相压住）
    const ang = (-90 + (360 / n) * i) * Math.PI / 180;
    const rad = n > 10 ? 43 : 40;
    const s = el('div', 'seat');
    s.dataset.seat = p.seat;
    s.style.setProperty('--x', `${(Math.cos(ang) * rad).toFixed(2)}%`);
    s.style.setProperty('--y', `${(Math.sin(ang) * rad).toFixed(2)}%`);
    s.tabIndex = 0; // 键盘选目标（V07）：Enter/Space 与点击同一入口 selectTarget
    s.setAttribute('role', 'button');
    const snum = el('span', 'snum');
    snum.appendChild(elText('span', 'seat-index', String(p.seat)));
    const bSheriff = el('span', 'badge badge-sheriff hidden', '👑');
    bSheriff.title = '警长';
    const bLost = el('span', 'badge badge-lost hidden', '🚫');
    bLost.title = '失去投票权';
    const roleChip = el('span', 'role-chip role-live hidden');
    const votes = el('span', 'votecount hidden');
    snum.append(bSheriff, bLost, roleChip, votes);
    // 肖像只在结构重建/改名时创建一次（decorate 会 <img> 前插，逐帧调用会反复重建图片）
    if (window.AICast) window.AICast.decorate(snum, portraits.get(p.seat));
    const sname = el('span', 'sname');
    // 身份标注（NOTE-03）：常显入口（不能只在 hover 出现——计划 §4.3），与目标选择是兄弟节点
    const tagBtn = el('button', 'btn small ghost tag-btn', ico('tag'));
    tagBtn.type = 'button';
    tagBtn.title = '编辑 TA 的私人笔记（AI 看不到）';
    tagBtn.setAttribute('aria-label', `${p.seat}号私人笔记`);
    tagBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openTagModal(p.seat); });
    const tagChip = el('span', 'role-chip tag-chip hidden');
    s.append(snum, sname, tagBtn, tagChip);
    // 点座位 = 选目标（selectTarget 自带候选范围校验：非选目标阶段是无害 no-op）
    s.addEventListener('click', () => selectTarget(p.seat));
    s.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !isComposing(e)) { e.preventDefault(); selectTarget(p.seat); }
    });
    ring.appendChild(s);
    state.seatNodes.set(p.seat, s);
    // ---- 列表视图行（与圆桌共用数据与选择状态；整行宽 ≥64×72，是合规的目标区） ----
    const row = el('div', 'seat-row');
    row.dataset.seat = p.seat;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const rnum = el('span', 'row-num');
    rnum.appendChild(elText('span', 'seat-index', String(p.seat)));
    const rrole = el('span', 'role-chip role-live hidden');
    rnum.appendChild(rrole);
    const rmain = el('div', 'row-main');
    const rname = el('span', 'row-name');
    const rmeta = el('span', 'row-meta hint');
    rmain.append(rname, rmeta);
    const rvotes = el('span', 'votecount hidden');
    const rtag = el('button', 'btn small ghost tag-btn', ico('tag'));
    rtag.type = 'button';
    rtag.title = '编辑 TA 的私人笔记（AI 看不到）';
    rtag.setAttribute('aria-label', `${p.seat}号私人笔记`);
    rtag.addEventListener('click', (ev) => { ev.stopPropagation(); openTagModal(p.seat); });
    const rsum = el('span', 'role-chip tag-chip hidden');
    row.append(rnum, rmain, rvotes, rtag, rsum);
    row.addEventListener('click', () => selectTarget(p.seat));
    row.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !isComposing(e)) { e.preventDefault(); selectTarget(p.seat); }
    });
    if (list) list.appendChild(row);
    state.seatListNodes.set(p.seat, row);
  });
  box.appendChild(ring);
}

/** 圆心阶段牌：天数/阶段/存活/正在行动/亮票票数（内容签名不变则不动 DOM） */
function updateRingCore(v) {
  const core = document.getElementById('ring-core');
  if (!core) return;
  const liveSeat = v.live && v.live.seat ? Number(v.live.seat) : 0;
  const aliveNow = v.players.filter((p) => p.alive).length;
  const tally = state.voteTally || {};
  const voteChips = Object.entries(tally)
    .filter(([, k]) => k > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([s, k]) => `<span>${s === '0' ? '弃票' : s + '号'} ${k}</span>`);
  const liveWho = liveSeat ? `${liveSeat}号 ${escapeHtml(String(state.seatNames[liveSeat] || '').trim())} 正在行动…` : '';
  const sig = `${v.day}|${v.phase}|${aliveNow}|${v.players.length}|${liveWho}|${voteChips.join('')}`;
  if (core.dataset.sig === sig) return;
  core.dataset.sig = sig;
  core.innerHTML = `<div class="rc-phase">第${v.day}天</div>`
    + `<div class="rc-sub">${escapeHtml(PHASE_LABEL[v.phase] || v.phase || '')} · 存活 ${aliveNow}/${v.players.length}</div>`
    + (liveWho ? `<div class="rc-live">${liveWho}</div>` : '')
    + (voteChips.length ? `<div class="rc-vote">${voteChips.join('')}</div>` : '');
}

/** 逐座位补丁：签名没变就零 DOM 写入；变了只改类别/文本/徽记，不重建节点 */
function patchSeatNode(node, p, i, ctx) {
  if (!node) return;
  const canPick = actionState.needTarget && actionState.candidates.includes(p.seat);
  // 身份标注入口（NOTE-03）：本人视角且座位未公开、未出局、不是自己
  const taggable = !!(ctx.me && !state.godMode && p.alive && !p.revealed && p.seat !== ctx.me.seat);
  const meSeat = ctx.mySeat || 0;
  const info = p.role ? roleInfo(p.role) : null;
  const sum = !p.role ? seatTagSummary(p.seat) : null;
  const votes = ctx.tally[p.seat];
  const sig = [p.name, p.alive ? 1 : 0, p.isSheriff ? 1 : 0, p.lostVote ? 1 : 0, p.role || '',
    votes || 0, ctx.liveSeat === p.seat ? 1 : 0, canPick ? 1 : 0,
    canPick && actionState.target === p.seat ? 1 : 0, taggable ? 1 : 0, i, sum || '', info ? info.id : ''].join('|');
  if (node.dataset.sig === sig) return;
  node.dataset.sig = sig;
  node.classList.toggle('dead', !p.alive);
  node.classList.toggle('mine', p.seat === meSeat);
  node.classList.toggle('sheriff', !!p.isSheriff);
  node.classList.toggle('speaking', !!ctx.liveSeat && ctx.liveSeat === p.seat);
  node.classList.toggle('targetable', canPick);
  node.classList.toggle('picked', canPick && actionState.target === p.seat);
  // 顺序/人数变化时同步圆桌坐标（补丁路径也要能落位，不必整桌重建）
  if (node.dataset.idx !== String(i)) {
    node.dataset.idx = String(i);
    const n = ctx.n || 1;
    const ang = (-90 + (360 / n) * i) * Math.PI / 180;
    const rad = n > 10 ? 43 : 40;
    node.style.setProperty('--x', `${(Math.cos(ang) * rad).toFixed(2)}%`);
    node.style.setProperty('--y', `${(Math.sin(ang) * rad).toFixed(2)}%`);
  }
  const snum = node.querySelector('.snum');
  if (snum) {
    // 已知身份：头像圆染阵营色 + 右下角徽记
    if (info) snum.style.setProperty('border-color', info.color); else snum.style.removeProperty('border-color');
    const idx = snum.querySelector('.seat-index');
    if (idx) idx.textContent = p.seat;
    const bS = snum.querySelector('.badge-sheriff');
    if (bS) bS.classList.toggle('hidden', !p.isSheriff);
    const bL = snum.querySelector('.badge-lost');
    if (bL) bL.classList.toggle('hidden', !p.lostVote);
    const rc = snum.querySelector('.role-live');
    if (rc) {
      rc.classList.toggle('hidden', !info);
      if (info) { rc.textContent = info.emoji; rc.style.setProperty('color', info.color); rc.title = `${info.emoji}${info.name}`; }
    }
    const vt = snum.querySelector('.votecount');
    if (vt) { vt.classList.toggle('hidden', !votes); vt.textContent = votes ? String(votes) : ''; }
    // 肖像按名字绑定：名字变了才重画，避免逐帧重建 <img>
    const portrait = ctx.portraits ? ctx.portraits.get(p.seat) : null;
    if (window.AICast && portrait && snum.dataset.portrait !== portrait.id) {
      const old = snum.querySelector('.ai-portrait');
      if (old) old.remove();
      snum.classList.remove('portrait-ready');
      window.AICast.decorate(snum, portrait);
    }
  }
  const sname = node.querySelector('.sname');
  if (sname) sname.textContent = `${p.name}${p.seat === meSeat ? '（你）' : ''}`;
  const tb = node.querySelector('.tag-btn');
  if (tb) tb.classList.toggle('hidden', !taggable);
  const tc = node.querySelector('.tag-chip');
  if (tc) {
    tc.classList.toggle('hidden', !sum);
    if (sum) { tc.innerHTML = ico('tag') + escapeHtml(sum); tc.title = '我的私人笔记摘要（AI 看不到）'; }
  }
  node.title = `${p.seat}号 ${p.name}${p.alive ? '' : '（已出局）'}${p.isSheriff ? ' · 警长' : ''}${info ? ` · ${info.name}` : ''}${canPick ? ' · 点击选为目标' : ''}`;
}

/** 列表行补丁：与圆桌同一份签名逻辑（共用选择状态），两视图互为镜像 */
function patchSeatRow(row, p, i, ctx) {
  if (!row) return;
  const canPick = actionState.needTarget && actionState.candidates.includes(p.seat);
  const taggable = !!(ctx.me && !state.godMode && p.alive && !p.revealed && p.seat !== ctx.me.seat);
  const meSeat = ctx.mySeat || 0;
  const info = p.role ? roleInfo(p.role) : null;
  const sum = !p.role ? seatTagSummary(p.seat) : null;
  const votes = ctx.tally[p.seat];
  const sig = ['r', p.name, p.alive ? 1 : 0, p.isSheriff ? 1 : 0, p.lostVote ? 1 : 0, p.role || '',
    votes || 0, ctx.liveSeat === p.seat ? 1 : 0, canPick ? 1 : 0,
    canPick && actionState.target === p.seat ? 1 : 0, taggable ? 1 : 0, sum || '', info ? info.id : ''].join('|');
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  row.classList.toggle('dead', !p.alive);
  row.classList.toggle('mine', p.seat === meSeat);
  row.classList.toggle('speaking', !!ctx.liveSeat && ctx.liveSeat === p.seat);
  row.classList.toggle('targetable', canPick);
  row.classList.toggle('picked', canPick && actionState.target === p.seat);
  const rnum = row.querySelector('.row-num');
  if (rnum) {
    const idx = rnum.querySelector('.seat-index');
    if (idx) idx.textContent = p.seat;
    if (info) rnum.style.setProperty('border-color', info.color); else rnum.style.removeProperty('border-color');
    const rc = rnum.querySelector('.role-live');
    if (rc) {
      rc.classList.toggle('hidden', !info);
      if (info) { rc.textContent = info.emoji; rc.style.setProperty('color', info.color); rc.title = `${info.emoji}${info.name}`; }
    }
  }
  const rname = row.querySelector('.row-name');
  if (rname) rname.textContent = `${p.name}${p.seat === meSeat ? '（你）' : ''}`;
  const rmeta = row.querySelector('.row-meta');
  if (rmeta) {
    const bits = [];
    if (!p.alive) bits.push('已出局');
    if (p.isSheriff) bits.push('👑 警长');
    if (p.lostVote) bits.push('🚫 失去投票权');
    if (info) bits.push(`${info.emoji} ${info.name}`);
    if (ctx.liveSeat === p.seat) bits.push('正在行动…');
    rmeta.textContent = bits.join(' · ');
  }
  const rv = row.querySelector('.votecount');
  if (rv) { rv.classList.toggle('hidden', !votes); rv.textContent = votes ? String(votes) : ''; }
  const rtb = row.querySelector('.tag-btn');
  if (rtb) {
    const taggable = !!(ctx.me && !state.godMode && p.alive && !p.revealed && p.seat !== ctx.me.seat);
    rtb.classList.toggle('hidden', !taggable);
  }
  const rsum = row.querySelector('.tag-chip');
  if (rsum) {
    rsum.classList.toggle('hidden', !sum);
    if (sum) { rsum.innerHTML = ico('tag') + escapeHtml(sum); rsum.title = '我的私人笔记摘要（AI 看不到）'; }
  }
  row.title = `${p.seat}号 ${p.name}${p.alive ? '' : '（已出局）'}${p.isSheriff ? ' · 警长' : ''}${info ? ` · ${info.name}` : ''}${canPick ? ' · 点击选为目标' : ''}`;
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
// FIX-15：target 初值用 null = "还没选"；0 = "显式放弃"（空刀/空守/不开枪/弃票，由各自的按钮写入）。
// 这两件事以前都是 0，所以"没选就提交"无法与"明确放弃"区分 —— 见 pickedTarget()。
let actionState = { target: null, explode: false, withdraw: false, antidote: false, poison: 0, needTarget: false, candidates: [] };

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
  actionState = { target: null, explode: false, withdraw: false, antidote: false, poison: 0, needTarget: false, candidates: [] };
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
        <button class="btn small ghost" id="mrc-inspect" title="检视卡牌">${ico('inspect')}</button>
        <button class="btn small ghost" id="mrc-task" title="查看任务">${ico('task')}</button>
        <button class="btn small ghost" id="mrc-strategy" title="查看策略卡">${ico('strategy')}</button>
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
  wrap.innerHTML = `<div class="mhead"><h2>${ico('task')} 你的任务</h2></div><div class="mbody">
    <p><b style="color:${r.color}">${r.emoji} ${r.name}</b> · 你是 ${me.seat} 号（${me.alive ? '存活' : '出局'}${me.isSheriff ? ' · 警长' : ''}）</p>
    <p>${escapeHtml(r.description)}</p>${mates}
    <p>${win}</p>
    <p class="hint">小贴士：点角色卡上的 ${ico('strategy')} 策略 可查看参考打法。</p>
  </div>`;
  openModal(wrap);
}

function openStrategy(rid) {
  const list = (state.meta.roleStrategies || {})[rid] || [];
  const r = roleInfo(rid);
  const wrap = el('div');
  wrap.innerHTML = `<div class="mhead"><h2>${ico('strategy')} ${r.name} · 策略参考</h2></div><div class="mbody">
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
    setHint('⚔️ 决斗请求已提交，将在当前发言结束后的间隙生效…', 'ok');
  } catch (e) { setHint(`✗ ${e.message}`, 'err'); }
}

function mountDuelBtn(v, box) {
  if (!canDuelNow(v) || box.querySelector('.duel-now-btn')) return;
  const b = el('button', 'btn danger duel-now-btn', icoLabel('duel', '随时决斗'));
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
    setHint('🔮 自爆请求已提交，将在当前发言结束后的间隙生效…', 'ok');
  } catch (e) { setHint('✗ ' + e.message, 'err'); }
}

function mountExplodeBtn(v, box) {
  if (!canExplodeNow(v) || box.querySelector('.explode-now-btn')) return;
  const b = el('button', 'btn danger explode-now-btn', icoLabel('explode', '随时自爆'));
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
 * 目标必选的决策（FIX-15）：没选就提交会静默变成 target=0（空刀/空守/空枪），而玩家以为自己投过了。
 * 实测踩过：狼队"投刀"时有人没点座位，只剩 2:1 才保住刀口 —— 提交的是空刀，界面上却看不出。
 * confirmBtn 会捕获这里抛出的错误并显示在提示行，所以玩家得到的是明确的"请先选目标"，而不是一次假提交。
 * `noneLabel`：这一任务另有显式的"放弃"按钮（空刀/空守/不开枪/弃票）。提示里要点名它，
 * 否则"我就想空守"的玩家会以为界面坏了 —— 显式点那个按钮的行为**完全不变**（照旧提交 0），
 * 服务端判定语义不受影响，这里只是把"什么都没选"和"明确选择放弃"分开。
 */
function pickedTarget(label, noneLabel) {
  // ⚠ 判空必须用 null/undefined，**不能**用 falsy：0 是"显式放弃"（空刀/空守/不开枪/弃票），
  // 是玩家点出来的合法选择。以前 actionState.target 初值是 0，于是"什么都没选"和"显式放弃"
  // 是同一个值，判空只能写 null/undefined —— 那条分支在真实操作里永远不会命中（FIX-15 的根因）。
  // 现在初值是 null，"没选"（null）与"显式放弃"（0）真正分开了。
  if (actionState.target === null || actionState.target === undefined) {
    throw new Error(noneLabel
      ? `请先点一个座位选出${label || '目标'}（想放弃这次操作就点「${noneLabel}」）`
      : `请先点一个座位选出${label || '目标'}`);
  }
  return actionState.target;
}

/** 操作条提示（FIN-03 状态齐全）：成功/失败/等待各有可见状态，失败文案保留在输入不丢的前提下显示 */
function setHint(text, kind) {
  const hint = $('#pending-hint');
  if (!hint) return;
  hint.className = `pending-hint${kind ? ` ${kind}` : ''}`;
  hint.textContent = text;
}

function confirmBtn(text, buildPayload) {
  const b = el('button', 'btn primary', text || '确认');
  b.addEventListener('click', async () => {
    if (b.disabled) return; // 双击只产生一次业务提交
    let payload;
    try {
      payload = buildPayload();
    } catch (e) {
      setHint(`✗ ${e.message}`, 'err');
      return;
    }
    b.disabled = true; // 处理中：按钮禁用但宽度不变（.btn 保持 min-width/min-height）
    try {
      await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload });
      $('#action-controls').innerHTML = '';
      $('#action-controls').dataset.task = '';
      setHint('已提交 ✓', 'ok');
    } catch (e) {
      b.disabled = false; // 失败：恢复可点，输入不清空
      setHint(`✗ ${e.message}`, 'err');
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
          // FIX-15：target 初值已改为 null，白狼王自爆这里要显式落成 0（与改动前发给服务端的字节一致）
          if (me.role === 'whitewolfking') payload.target = Number(actionState.target) || 0;
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
      skip.addEventListener('click', () => submitSimple({ text: '' }, skip));
      btnRow.appendChild(skip);
      box.appendChild(btnRow);
      break;
    }
    case 'night_guard': {
      $('#pending-hint').textContent = '⏳ 守卫行动：选择今晚守护对象';
      box.appendChild(targetPicker(p.candidates, { noneLabel: '空守' }));
      const btnRow = el('div', 'btnrow');
      // FIX-15：这里原来直接提交 actionState.target —— 没选目标时静默变成"空守"（玩家以为守了谁）。
      // 现在未选目标给可读提示；显式点「空守」照旧提交 0。
      btnRow.appendChild(confirmBtn('确认守护', () => ({ target: pickedTarget('守护对象', '空守') })));
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
      // FIX-15：这条判断收进 pickedTarget()，与空守（night_guard）/不开枪（shoot）走同一份逻辑。
      btnRow.appendChild(confirmBtn('投刀', () => ({ target: pickedTarget('刀口', p.allowNone ? '空刀' : null) })));
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
        const saveBtn = el('button', 'btn', icoLabel('antidote', `用解药救 ${ex.killTarget} 号`));
        saveBtn.addEventListener('click', async () => {
          try {
            await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload: { antidote: true, poison: 0 } });
            $('#action-controls').innerHTML = ''; $('#action-controls').dataset.task = '';
          } catch (e) { setHint(`✗ ${e.message}`, 'err'); }
        });
        box.appendChild(saveBtn);
      }
      if (ex.canPoison) {
        box.appendChild(el('span', 'hint', '或选择毒杀：'));
        box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat)));
        const btnRow = el('div', 'btnrow');
        btnRow.appendChild(confirmBtn(icoLabel('poison', '使用毒药'), () => ({ antidote: false, poison: Number(actionState.target) || 0 }))); // FIX-15：null→0，与改动前一致
        box.appendChild(btnRow);
      }
      const skip = el('button', 'btn ghost', '空过（都不用）');
      skip.addEventListener('click', async () => {
        try {
          await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload: { antidote: false, poison: 0 } });
          $('#action-controls').innerHTML = ''; $('#action-controls').dataset.task = '';
        } catch (e) { setHint(`✗ ${e.message}`, 'err'); }
      });
      box.appendChild(skip);
      break;
    }
    case 'sheriff_run': {
      $('#pending-hint').textContent = '⏳ 警长竞选：是否上警？';
      const run = el('button', 'btn primary', icoLabel('sheriff', '上警'));
      const norun = el('button', 'btn', '不上警');
      run.addEventListener('click', () => submitSimple({ run: true }, run));
      norun.addEventListener('click', () => submitSimple({ run: false }, norun));
      box.append(run, norun);
      break;
    }
    case 'direction': {
      $('#pending-hint').textContent = '⏳ 警长：决定今天发言方向';
      const cw = el('button', 'btn primary', '顺时针');
      const ccw = el('button', 'btn', '逆时针');
      cw.addEventListener('click', () => submitSimple({ direction: 'cw' }, cw));
      ccw.addEventListener('click', () => submitSimple({ direction: 'ccw' }, ccw));
      box.append(cw, ccw);
      break;
    }
    case 'badge_pass': {
      $('#pending-hint').textContent = '⏳ 警长离场：移交警徽或撕毁';
      box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat)));
      const btnRow = el('div', 'btnrow');
      btnRow.appendChild(confirmBtn('移交给该玩家', () => ({ target: pickedTarget('接任警长') })));
      const tear = el('button', 'btn danger', '撕毁警徽');
      tear.addEventListener('click', () => submitSimple({ target: 0 }, tear));
      btnRow.appendChild(tear);
      box.appendChild(btnRow);
      break;
    }
    case 'vote': case 'pk_vote': case 'sheriff_vote': {
      const labels = { vote: '放逐投票', pk_vote: 'PK 投票（限投 PK 者）', sheriff_vote: '警长竞选投票' };
      $('#pending-hint').textContent = `⏳ ${labels[p.task]}（互相保密）`;
      box.appendChild(targetPicker(p.candidates, { noneLabel: p.allowNone ? '弃票' : null }));
      const btnRow = el('div', 'btnrow');
      // FIX-15：投票同样不许静默弃票 —— 没选目标就给可读提示，想弃票请点「弃票」
      // （引擎对 vote/pk_vote/sheriff_vote 一律 allowNone:true，所以以前这条分支必然是"静默按 0 提交"）。
      btnRow.appendChild(confirmBtn('投票', () => ({ target: pickedTarget('投票对象', p.allowNone ? '弃票' : null) })));
      box.appendChild(btnRow);
      break;
    }
    case 'shoot': {
      $('#pending-hint').textContent = '⏳ 开枪技能：选择带走目标';
      box.appendChild(targetPicker(v.players.filter((x) => x.alive).map((x) => x.seat), { noneLabel: '不开枪' }));
      const btnRow = el('div', 'btnrow');
      // FIX-15：同 night_guard —— 没选目标不再静默变成"不开枪"；显式点「不开枪」照旧提交 0。
      btnRow.appendChild(confirmBtn('开枪', () => ({ target: pickedTarget('开枪目标', '不开枪') })));
      box.appendChild(btnRow);
      break;
    }
    default:
      box.appendChild(el('span', 'hint', `未知任务：${p.task}`));
  }
}

async function wolfTalkAction(kind, text, ta) {
  try {
    if (kind === 'say' && !text) { setHint('✗ 插话内容不能为空', 'err'); return; }
    const r = await api('POST', `/api/games/${state.game.gameId}/wolftalk`, { token: state.game.playerToken, kind, text });
    if (kind === 'say' && ta) ta.value = '';
    setHint(kind === 'say' ? '已发送 ✓'
      : kind === 'extra' ? `已追加，当前 ${r.wolfTalk.rounds} 轮 ✓` : '已通知结束讨论 ✓', 'ok');
  } catch (e) { setHint(`✗ ${e.message}`, 'err'); }
}

async function submitSimple(payload, btn) {
  if (btn && btn.disabled) return; // 双击只产生一次业务提交
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/games/${state.game.gameId}/action`, { token: state.game.playerToken, payload });
    $('#action-controls').innerHTML = ''; $('#action-controls').dataset.task = '';
    setHint('已提交 ✓', 'ok');
  } catch (e) {
    if (btn) btn.disabled = false;
    setHint(`✗ ${e.message}`, 'err');
  }
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
/**
 * 模态纪律（FIN-03）：全页只允许一个最上层模态（openModal 先清空 modal-root）；
 * 背景不接收点击（点遮罩关闭）与 Tab（焦点循环锁在弹窗内）；Esc 关闭最上层弹窗；
 * 关闭后焦点回到打开弹窗的来源元素。openModal/closeModal 成对使用，页面里
 * 不再直接 `modal-root.innerHTML = ''`（那会丢掉焦点归还）。
 */
function openModal(inner, { onDismiss } = {}) {
  const root = $('#modal-root');
  // M2-d §5.2：全页只允许一个最上层模态（下面这行会清空 modal-root），所以任何一次
  // openModal 都意味着"上一个弹层已被销毁"——它的 dirty() 引用必须一起失效，
  // 否则切档守卫会拿着一个已经不存在于页面上的表单，一直弹"有未保存内容"。
  // （笔记编辑器/资料编辑器在**调用 openModal 之后**才登记自己的 dirty，见 openTagModal 末尾。）
  state.noteDirty = null;
  state.profileFormOpen = false;
  state.profileFormDirty = null;
  if (!state.modalReturnFocus && document.activeElement && document.activeElement !== document.body) {
    state.modalReturnFocus = document.activeElement;
  }
  root.innerHTML = '';
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1;
  state.modalDismiss = onDismiss || closeModal;
  // ⚠ 与手机端同样的坑：把调用方的容器整包塞进来，会让 .mhead/.mbody 变成"孙子"，
  // flex 高度约束传不到正文，正文撑到真实高度后滚不动（规则书实测上万像素）。
  // 无类名的普通容器一律拆开挂到 .modal 下。
  if (inner && !inner.className && inner.children.length) {
    while (inner.firstChild) modal.appendChild(inner.firstChild);
  } else {
    modal.appendChild(inner);
  }
  // 弹层内容是 JS 现拼的，声明式的 `[data-ww-icon]` 只有到这一刻才有实体：
  // 在这里统一画一次（mount 幂等，重复打开同一弹层不会叠加徽记）。
  // 静态 HTML 里那一批由 app.js 启动时的 DOMContentLoaded 与切语言后的重画负责。
  window.WWIcons.mount(modal);
  mask.appendChild(modal);
  const title = modal.querySelector('h2, h3');
  if (title) { title.id = 'active-modal-title'; modal.setAttribute('aria-labelledby', title.id); }
  mask.addEventListener('click', (e) => { if (e.target === mask) state.modalDismiss(); });
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.getClientRects().length);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  root.appendChild(mask);
  // AC-06：初始焦点必须落在弹窗内（否则 Tab 会先落到背景按钮），背景整体 inert 防交互
  syncModalLayerState();
  const focusables = modal.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
  (focusables[0] || modal).focus({ preventScroll: true });
  if (!focusables[0]) modal.tabIndex = -1;
  return modal;
}

/**
 * 背景 inert + body 滚动锁的唯一收口（FIX-08）。
 * 只有一处判断"还有没有模态"，openModal / closeModal / MutationObserver 都调它 —— 于是
 * **任何**清空 #modal-root 的路径（含别处直接 `innerHTML = ''`）都不会留下"锁着但看不见"的页面：
 * 背景点不动 + 页面滚不动，却没有任何弹窗可关，是比原缺陷更糟的状态。
 */
function syncModalLayerState() {
  const root = document.getElementById('modal-root');
  const open = !!root && root.children.length > 0;
  const appEl = document.getElementById('app');
  if (appEl) appEl.inert = open;
  document.body.classList.toggle('ww-layer-open', open);
}

// modal-root 被任何路径清空（含 innerHTML 直清）都自动解除背景 inert 与滚动锁
new MutationObserver(syncModalLayerState).observe(document.getElementById('modal-root'), { childList: true });

/** 关闭最上层模态并把焦点还给来源。链式打开下一个弹窗时来源保持不变。 */
function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = ''; // 遮罩与内容都在这一层里：一起清掉，不留只挡住画面的空遮罩
  state.modalDismiss = null;
  // M2-d §5.2：弹层关掉了 ⇒ 它登记的 dirty() 一并失效（切档守卫不该再看到"有草稿"）
  state.noteDirty = null;
  state.profileFormOpen = false;
  state.profileFormDirty = null;
  syncModalLayerState(); // 解除背景 inert 与 body 滚动锁
  const src = state.modalReturnFocus;
  state.modalReturnFocus = null;
  if (src && typeof src.focus === 'function') {
    try { src.focus({ preventScroll: true }); } catch (_) { try { src.focus(); } catch (_) { /* 来源已移除 */ } }
  }
}

/**
 * Esc 关浮层（FIX-08）：实现放在这里，监听器由 web/pwa.js 统一分发（全页只有一个 Esc 监听器，
 * 避免"两个监听器各关一层"或"谁也不关"）。关闭一律走统一的关闭函数，遮罩、焦点归还、
 * body 滚动锁、返回栈清理都在那里，不再有"直接改 hidden"的旁路 —— 那条路被 `.modal{display:flex}`
 * 盖掉，等于没关（浏览器实测：手机端 Esc 后弹层仍在屏幕上）。
 * 优先级按 z-index 从高到低：检视大卡(90) → 弹窗(75/76) → 笔记抽屉。
 * ⚠ 身份翻牌浮层（#role-overlay，80）**有意不在关闭之列**：它是"确认看到自己身份"的必经步骤，
 * 允许 Esc 跳过会让玩家没看到身份就被推进对局；它只由「我记住了，开始游戏」关闭。
 * 上帝面板（#god-drawer）同理不关：语义是"关面板 = 退上帝视角"，保持原入口操作。
 */
window.__wwEscClose = () => {
  const stage = document.querySelector('.inspect-stage');
  if (stage) { stage.remove(); return true; }
  const root = $('#modal-root');
  if (root && root.children.length) { (state.modalDismiss || closeModal)(); return true; }
  const notes = $('#notes-drawer');
  if (notes && !notes.classList.contains('hidden') && !notesDocked()) { toggleNotesDrawer(); return true; }
  return false;
};

// 中文输入法 composing 期间 Enter 不发送（FIN-03）：桌面端所有提交都走显式按钮，
// 唯一的 Enter 快捷路径是配对码输入 —— 这里统一守卫，composing 中不触发。
function isComposing(e) { return !!(e.isComposing || e.keyCode === 229); }

/**
 * 规则书：正文来自 web/rulebook.js（与手机端同一份内容与渲染器）。
 * 桌面端额外保留两个标签：角色图鉴（可视化卡牌）与本局生效的规则开关。
 */
function openRulebook() {
  const wrap = el('div');
  const head = el('div', 'mhead', `<h2>${ico('rulebook')} 规则书</h2>`);
  const close = el('button', 'btn ghost small', '✕');
  close.addEventListener('click', () => { closeModal(); });
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
      <button class="btn small ghost">${icoLabel('inspect', '检视')}</button>`;
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
 * 局后结算与复盘（P2-4 + FIN-04 §8.4 分层）。
 *
 * 首层（打开即见）：结束方式（自然结束/手动终止）、胜方、局别（Mock/真实/观战）、
 *   本人角色与最终阵营、得分依据；Mock / 观战 / 平局如实标注，不伪装成正式胜败。
 * 第二层（<details> 展开）：全员信息、时间线回看、个人标注入口、AI 复盘。
 *
 * AI 复盘**不自动触发**调用（要花一次 LLM 调用，由用户点），
 * 且必须一眼看出这段点评是 AI 写的还是规则生成的 —— 失败就明说原因，
 * 不做"看起来像 AI 点评、其实是模板"的静默降级。
 */
function renderCoach(v) {
  const box = $('#coach-panel');
  if (!box) return;
  // 复盘面板占中列下方：布局由 #screen-game.has-coach 决定（CSS grid，不靠 JS 算宽）
  const screen = document.getElementById('screen-game');
  if (!v || !v.finished) {
    box.classList.add('hidden'); box.innerHTML = ''; state.coachSig = null;
    if (screen) screen.classList.remove('has-coach');
    return;
  }
  const r = v.review || null;
  // 签名：内容没变就不重绘，否则每次视图更新都会把用户正在读的文本重建一遍
  const sig = `${r ? r.status : 'none'}|${r ? r.mode || '' : ''}|${r ? (r.text || '').length : 0}|${r ? r.fallbackReason || '' : ''}|${v.day}|${(v.players || []).filter((p) => p.alive).length}|${v.winner || ''}|${state.gameMeta && state.gameMeta.mock ? 1 : 0}`;
  if (sig === state.coachSig) return;
  state.coachSig = sig;
  box.classList.remove('hidden');
  if (screen) screen.classList.add('has-coach'); // 复盘面板出现时让出中列下方
  box.innerHTML = '';

  const head = el('div', 'coach-head');
  head.appendChild(el('h3', '', icoLabel('finish', '结算')));
  if (r && r.status === 'done') {
    const again = el('button', 'btn ghost small', r.mode === 'ai' ? '重新生成' : '用 AI 重新点评');
    again.addEventListener('click', () => requestCoach(true));
    head.appendChild(again);
  }
  box.appendChild(head);

  // ---- 首层：结果速览（怎么结束的/谁赢/我是谁/我得分）----
  const winners = { wolf: '🐺 狼人阵营获胜', good: '🕊 好人阵营获胜', third: '🎭 第三方获胜', draw: '🤝 平局（未分胜负）', none: '⏹ 对局终止' };
  const me = v.me || null;
  const mock = !!(state.gameMeta && state.gameMeta.mock);
  const spectate = !me || !me.role;
  const endKind = v.winner === 'none' ? '手动终止（不计正式胜败）' : '自然结束（达成胜利条件）';
  const info = me && me.role ? roleInfo(me.role) : null;
  const myTeam = info ? info.team : null;
  const outcome = !info ? (spectate ? '观战（不参与胜负）' : '—')
    : v.winner === 'draw' ? '平局'
      : v.winner === 'none' ? '—（终止局）'
        : (myTeam === 'third' ? '随绑定对象' : ((myTeam === 'wolf') === (v.winner === 'wolf') ? '获胜 🏆' : '落败'));
  const myScore = me && v.score && Array.isArray(v.score.rows) ? v.score.rows.find((row) => row.seat === me.seat) : null;
  const facts = [
    `<div class="cs-row"><span>结束方式</span><b>${endKind}</b></div>`,
    `<div class="cs-row"><span>结果</span><b>${winners[v.winner] || (v.winner ? escapeHtml(String(v.winner)) : '—')}</b></div>`,
    `<div class="cs-row"><span>局别</span><b>${mock ? 'Mock 试玩（不调用 API，不计正式战绩）' : '真实对局'}${spectate ? ' · 观战视角' : ''}</b></div>`,
    `<div class="cs-row"><span>天数</span><b>第 ${v.day} 天</b></div>`,
    `<div class="cs-row"><span>存活</span><b>${(v.players || []).filter((p) => p.alive).length} / ${(v.players || []).length}</b></div>`,
  ];
  if (info) {
    facts.push(`<div class="cs-row"><span>我的身份</span><b style="color:${info.color}">${info.emoji}${info.name} · ${outcome}${me.alive ? '' : ' · 已出局'}</b></div>`);
  }
  if (myScore) {
    facts.push(`<div class="cs-row"><span>我的得分</span><b>${myScore.score} 分</b></div>`);
    facts.push(`<div class="cs-row"><span>得分依据</span><b class="cs-basis">${escapeHtml(String(v.score.title || '本局评分体系'))}</b></div>`);
  }
  const stat = el('div', 'coach-stat', facts.join(''));
  box.appendChild(stat);

  // ---- 第二层：展开后的复盘详情 ----
  const more = el('details', 'coach-more');
  more.appendChild(el('summary', null, '展开复盘详情（全员信息 · 时间线 · 个人标注 · AI 复盘）'));

  // 全员信息表
  const table = el('div', 'coach-players');
  table.appendChild(el('h4', null, '全员信息'));
  table.appendChild(el('div', 'cp-row cp-head', '<span>座位</span><span>昵称</span><span>身份</span><span>状态</span><span>得分</span>'));
  const rowsHtml = (v.players || []).slice().sort((a, b) => a.seat - b.seat).map((p) => {
    const ri = p.role ? roleInfo(p.role) : null;
    const sr = v.score && Array.isArray(v.score.rows) ? v.score.rows.find((x) => x.seat === p.seat) : null;
    return `<div class="cp-row"><span class="cp-seat">${p.seat}号</span>`
      + `<span class="cp-name">${escapeHtml(p.name)}${me && p.seat === me.seat ? '（你）' : ''}</span>`
      + `<span class="cp-role"${ri ? ` style="color:${ri.color}"` : ''}>${ri ? `${ri.emoji}${ri.name}` : '未公开'}</span>`
      + `<span class="cp-state">${p.alive ? '存活' : '出局'}</span>`
      + `<span class="cp-score">${sr ? `${sr.score} 分` : ''}</span></div>`;
  }).join('');
  table.insertAdjacentHTML('beforeend', rowsHtml);
  more.appendChild(table);

  // 时间线回看 + 个人标注入口（复用现有流程，不重复发起付费生成）
  const tools = el('div', 'btnrow');
  const timelineBtn = el('button', 'btn ghost small', icoLabel('timeline', '回看完整时间线'));
  timelineBtn.addEventListener('click', () => {
    const s = $('#stream');
    if (s) { s.scrollTop = 0; hideNewMsgPill(); }
  });
  tools.appendChild(timelineBtn);
  const annoBtn = el('button', 'btn ghost small', icoLabel('notes', '我的标注'));
  annoBtn.addEventListener('click', () => toggleNotesDrawer());
  tools.appendChild(annoBtn);
  more.appendChild(tools);

  // AI 复盘入口（已有结果优先读取；生成中状态可恢复；失败明确重试；页面切换/刷新不自动重复发起）
  more.appendChild(el('h4', null, icoLabel('coach', 'AI 复盘')));
  if (!r) {
    const btn = el('button', 'btn', '让教练点评这一局');
    const row = el('div', 'btnrow');
    row.appendChild(btn);
    more.append(row, el('div', 'hint', '会调用一次 AI（占用同一通道，约十几秒到一分钟）；点评会存档，重复打开不会重复花钱。'));
    btn.addEventListener('click', () => requestCoach(false));
  } else if (r.status === 'running') {
    more.appendChild(el('div', 'coach-body', '教练正在看这局的记录…（同一时间只跑一个 AI 调用，其他对局会稍等一下）'));
  } else if (r.status === 'error') {
    more.appendChild(elText('div', 'coach-body coach-warn', `点评失败：${r.fallbackReason || '未知原因'}`));
    const retry = el('button', 'btn', '重试');
    retry.addEventListener('click', () => requestCoach(true));
    more.appendChild(retry);
  } else {
    // 安全（审核 P1-5）：复盘文本是模型输出，必须 textContent；el() 的第三参走 innerHTML
    more.appendChild(elText('div', 'coach-body', r.text || '（空点评）'));
    const tag = r.mode === 'ai'
      ? '由 AI 生成；事实来自服务端统计，不含推测。'
      : `规则点评，未使用 AI${r.fallbackReason ? `（原因：${r.fallbackReason}）` : ''}。`;
    // tag 含 fallbackReason（服务端详情）→ 也走 textContent
    more.appendChild(elText('div', `coach-tag${r.mode === 'ai' ? '' : ' coach-warn'}`, tag));
  }
  box.appendChild(more);
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

/**
 * 导航/操作图标（计划书 §3 第 78 行）的注入点，分两步：
 *   ① 立刻注入那份 shared 的 `<symbol>` 定义 —— 之后任何 JS 拼出来的按钮（齿轮菜单、
 *      弹层标题、行动键）都能直接用 `<use>` 引用，不必各自带一份路径；
 *   ② 等 `DOMContentLoaded` 再画 `[data-ww-icon]` —— **必须晚于 i18n.js 的挂载**
 *      （i18n.js 先加载、先注册，所以它的 applyI18n 先跑），因为 applyI18n 会把
 *      `data-i18n` 元素的 textContent 整块换成词典文案，连同徽记一起抹掉。
 *      切语言时同理（见 switchLangDesktop / m.js 的 toggleLang）。
 */
window.WWIcons.ensureDefs(document);
function mountNavIcons() { window.WWIcons.mount(document); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountNavIcons);
else mountNavIcons();
window.addEventListener('storage', async (e) => {
  if (!window.WWProfileState.isSelectionKey(e.key)) return;
  // §5.2：**另一个窗口**切换了当前档案。本窗口若正有未保存的资料/笔记，
  // 决策是 `defer` —— 不弹原生确认框（那是本窗口自己的切档才该问的）、
  // 更不许把本窗口正在填的内容删掉；只如实提示"那边切到了哪个档案，草稿仍归原档案"。
  // 这里读的是 storage 里的**新值**（e.newValue），不是本窗口可能已过期的 state.profileId。
  const decision = window.WWSwitchGuard.decideSwitch({ dirty: hasUnsavedDraft(), source: window.WWSwitchGuard.OTHER_WINDOW });
  if (decision.action === 'defer') {
    const other = (state.profiles || []).find((x) => x.id === e.newValue);
    const status = document.querySelector('#pref-status');
    const text = `${decision.reason}${other ? `（另一窗口切到了「${other.nickname}」）` : ''}`;
    if (status) status.textContent = text;
    else console.info(`[ww] ${text}`);
  }
  await loadProfiles();
  if (!state.game) await checkResume();
});
initSetup().then(async () => {
  const saved = window.WWGameDraft.readHandleRaw(localStorage, 'ww_current');
  if (saved) {
    try {
      const g = window.WWGameDraft.parseHandle(saved);
      const v = await api('GET', `/api/games/${g.gameId}/session?token=${g.playerToken || g.godToken}`);
      if (v && !v.finished && v.inMemory) await resumeGame();
    } catch (_) { /* noop */ }
  }
}).catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;color:#ff8080">初始化失败：${escapeHtml(e.message)}<br>请确认服务已启动（node server.js）</div>`;
});
