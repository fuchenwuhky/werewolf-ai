/**
 * i18n.js — 界面文案的多语言（P2-7）
 *
 * 范围说明（刻意写清楚，避免"以为全翻译了"）：
 *   ✅ 覆盖：两个界面的**静态外壳**（设置页标签/按钮、顶栏、上帝面板、翻牌浮层、离线与更新提示）。
 *   ❌ 未覆盖：app.js / m.js 里运行时拼出来的句子、以及服务端返回的文案（节奏档位说明、规则书、
 *      事件流正文、点评文本）。那些是"游戏内容"，不是"界面外壳"，硬翻会破坏中文规则术语的一致性。
 *
 * 两条设计约束：
 *   ① **缺 key 时保留页面原文案**，绝不把 `api.key` 这样的键名显示给用户。
 *      因此 HTML 里的原文案就是 zh-CN 的兜底来源，字典漏一条也不会露馅。
 *   ② 本文件**不依赖 DOM 就能加载**（只在存在 document 时才自动挂载），
 *      这样纯字典与取词逻辑可以在 Node 里直接单测。
 */
'use strict';
(function (root) {
  const DICT = {
    'zh-CN': {
      'app.title': '🐺 AI 狼人杀',
      'app.sub': '本地网页版 · 1 名人类玩家 + AI · OpenAI 兼容接口',
      'skip.toMain': '跳到主内容',
      'common.save': '保存配置',
      'common.test': '测试连接',
      'common.refresh': '刷新',
      'common.close': '关闭',

      'api.title': '① API 配置',
      'api.baseUrl': '接口地址 base_url',
      'api.model': '模型 model',
      'api.key': 'API Key',
      'api.temp': '温度 temperature',
      'api.maxTokens': '最大回复 tokens（建议 16000，思考过程也计入）',
      'api.pace': '节奏档位（一次设定思考强度 / 反思频率 / 上下文预算）',
      'api.effort': '发言思考强度（发言/遗言/PK）',
      'api.effortLow': '最低 low（最快）',
      'api.effortHigh': '普通 high（默认）',
      'api.fastEffort': '快速任务思考强度（夜晚/投票等）',
      'api.fastEffortLow': '最低 low（默认，最丝滑）',
      'api.fastEffortHigh': '普通 high',
      'api.budget': '上下文预算 tokens（每次决策的记忆预算，超出自动裁剪；默认 12000）',
      'api.cacheControl': '给 system 消息加显式缓存标记（部分服务商需要，默认走自动前缀缓存）',
      'api.keepAlive': '复用 HTTP 长连接（默认开：每次调用省一轮 TCP+TLS 握手，实测约 90ms）。若日志频繁出现「复用连接已失效（ECONNRESET）」，多半是防火墙/代理会掐断空闲连接，取消勾选即可',
      'api.langSwitch': '切换界面语言',

      'board.title': '② 板子',
      'board.template': '模板',
      'rules.title': '③ 规则开关',
      'rules.defaultHint': '默认 = 网易12人守卫局',
      'rules.nightOrder': '夜晚行动顺序',
      'rules.nightOrderHint': '（默认按官方流程，通常不用改；展开可调整先后）',
      'players.title': '④ 玩家',
      'players.modePlay': '我当玩家（其余全是 AI）',
      'players.modeWatch': '纯观战（上帝视角看 AI 互杀）',
      'players.seat': '我的座位',
      'players.seatRandomHint': '🎲 座位开局时随机分配（每局都不一样）。下面每个座位的昵称/人格都会保留，抽到你的那个座位会换成你的昵称。',
      'players.name': '我的昵称',
      'players.mock': 'Mock 试玩（不调用 API，随机脚本 AI，用于测试流程）',
      'players.aiNames': 'AI 玩家昵称',
      'players.randNames': '随机昵称',
      'players.personaHint': '人格提示词可在下方高级选项为每个 AI 定制（可选）',
      'players.advanced': '高级：AI 人格设置',
      'start.button': '🎮 开始游戏',
      'resume.title': '发现进行中的对局',
      'resume.continue': '继续对局',
      'resume.discard': '放弃并清除',

      'game.rulebook': '📖 规则书',
      'game.rulebookTitle': '规则书',
      'game.god': '👁 上帝',
      'game.terminate': '⏹ 结束本局',
      'game.appLink': '📱 APP端',
      'game.appLinkTitle': '手机 APP 端',
      'game.home': '🏠 首页',
      'game.streamAria': '对局事件流',
      'god.title': '👁 上帝 / 开发者面板',
      'god.closeTitle': '关闭面板（返回玩家视角）',
      'god.context': 'AI 上下文调试',
      'god.logs': '日志查看器',
      'god.allLevels': '全部级别',
      'god.allModules': '全部模块',

      'overlay.flipHint': '❓<br>点击翻看你的身份',
      'overlay.flipDone': '我记住了，开始游戏',
      'overlay.inspect': '🔍 检视卡牌',

      'pwa.offline': '⚠ 已断网：AI 需要联网才能行动，对局会停在这里；网络恢复后自动继续。',
      'pwa.update': '新版本可用 · 立即刷新',
      'pwa.swFail': '离线能力注册失败（不影响正常使用）',
      'boot.loading': '⏳ 界面正在加载配置，请稍候…',

      'm.title': '🦇 AI 狼人杀',
      'm.sub': '✠ 选择你的战场 ✠',
      'm.settings': '⚙ 设置',
      'm.next': '下一步 →',
      'm.back': '返回',
      'm.rulesTitle': '对局规则',
      'm.rulesSection': '⚔ 对局规则',
      'm.aiNamesHint': 'AI 昵称开局自动从名字库随机（进入对局后无法修改）',
      'm.start': '⚔ 开始游戏',
      'm.logTitle': '事件记录',
      'm.meTitle': '我的身份',
      'm.tabLog': '📜 记录',
      'm.tabMe': '🎴 我的身份',
      'm.flipHint': '身份牌<br>点击翻开',
      'm.inspect': '🔍 检视',
      'offline.title': '现在没有网络',
      'offline.body1': '离线时打不开新对局：AI 在服务器端调用模型，断网就没法继续了。',
      'offline.body2': '已经打开过的页面可以脱离网络显示，但任何推进对局的操作都需要联网——这是单并发、串行调用的必然结果，不是缓存能绕开的。',
      'offline.retry': '重试',
    },
    en: {
      'app.title': '🐺 AI Werewolf',
      'app.sub': 'Local web build · 1 human + AI players · OpenAI-compatible API',
      'skip.toMain': 'Skip to main content',
      'common.save': 'Save',
      'common.test': 'Test connection',
      'common.refresh': 'Refresh',
      'common.close': 'Close',

      'api.title': '① API',
      'api.baseUrl': 'Base URL',
      'api.model': 'Model',
      'api.key': 'API key',
      'api.temp': 'Temperature',
      'api.maxTokens': 'Max reply tokens (16000 recommended; reasoning counts too)',
      'api.pace': 'Pace preset (sets thinking effort / reflection frequency / context budget at once)',
      'api.effort': 'Speech thinking effort (speech / last words / PK)',
      'api.effortLow': 'low (fastest)',
      'api.effortHigh': 'high (default)',
      'api.fastEffort': 'Fast-task thinking effort (night actions / votes)',
      'api.fastEffortLow': 'low (default, smoothest)',
      'api.fastEffortHigh': 'high',
      'api.budget': 'Context budget tokens (memory budget per decision, trimmed automatically; default 12000)',
      'api.cacheControl': 'Add an explicit cache marker to the system message (some providers require it; automatic prefix caching is the default)',
      'api.keepAlive': 'Reuse HTTP connections (on by default; saves a TCP+TLS handshake, ~90ms per call). If the log keeps showing ECONNRESET, a firewall or proxy is closing idle connections — turn it off.',
      'api.langSwitch': 'Switch interface language',

      'board.title': '② Board',
      'board.template': 'Template',
      'rules.title': '③ Rule switches',
      'rules.defaultHint': 'default = NetEase 12-player guard board',
      'rules.nightOrder': 'Night action order',
      'rules.nightOrderHint': '(official order by default; expand to reorder)',
      'players.title': '④ Players',
      'players.modePlay': 'I play (everyone else is AI)',
      'players.modeWatch': 'Spectate (god view, AI vs AI)',
      'players.seat': 'My seat',
      'players.seatRandomHint': '🎲 Your seat is drawn at the start and differs every game. Nicknames/personas set below are kept — whichever seat you draw gets your nickname.',
      'players.name': 'My nickname',
      'players.mock': 'Mock run (no API calls, scripted random AI, for testing the flow)',
      'players.aiNames': 'AI nicknames',
      'players.randNames': 'Randomize names',
      'players.personaHint': 'You can customise each AI persona in the advanced section below (optional)',
      'players.advanced': 'Advanced: AI personas',
      'start.button': '🎮 Start game',
      'resume.title': 'Unfinished game found',
      'resume.continue': 'Resume',
      'resume.discard': 'Discard',

      'game.rulebook': '📖 Rules',
      'game.rulebookTitle': 'Rules',
      'game.god': '👁 God',
      'game.terminate': '⏹ End game',
      'game.appLink': '📱 Mobile',
      'game.appLinkTitle': 'Mobile build',
      'game.home': '🏠 Home',
      'game.streamAria': 'Game event stream',
      'god.title': '👁 God / developer panel',
      'god.closeTitle': 'Close panel (back to player view)',
      'god.context': 'AI context debug',
      'god.logs': 'Log viewer',
      'god.allLevels': 'All levels',
      'god.allModules': 'All modules',

      'overlay.flipHint': '❓<br>Tap to reveal your role',
      'overlay.flipDone': 'Got it, start the game',
      'overlay.inspect': '🔍 Inspect card',

      'pwa.offline': '⚠ Offline: the AI needs the network to act, so the game is paused here. It resumes automatically once you are back online.',
      'pwa.update': 'Update available · reload',
      'pwa.swFail': 'Offline support failed to register (the app still works)',
      'boot.loading': '⏳ Loading configuration, please wait…',

      'm.title': '🦇 AI Werewolf',
      'm.sub': '✠ Choose your battlefield ✠',
      'm.settings': '⚙ Settings',
      'm.next': 'Next →',
      'm.back': 'Back',
      'm.rulesTitle': 'Game rules',
      'm.rulesSection': '⚔ Game rules',
      'm.aiNamesHint': 'AI nicknames are drawn randomly at the start (cannot be changed once the game begins)',
      'm.start': '⚔ Start game',
      'm.logTitle': 'Event log',
      'm.meTitle': 'My role',
      'm.tabLog': '📜 Log',
      'm.tabMe': '🎴 My role',
      'm.flipHint': 'Role card<br>tap to reveal',
      'm.inspect': '🔍 Inspect',
      'offline.title': 'You are offline',
      'offline.body1': 'New games need the network: the AI calls the model on the server, so nothing can advance offline.',
      'offline.body2': 'Pages you already opened can still render, but any action that advances the game needs the network — that is a direct consequence of the single-key, strictly serial call model, not something caching can work around.',
      'offline.retry': 'Retry',
    },
  };

  const FALLBACK = 'zh-CN';
  const STORAGE_KEY = 'ww.lang';

  function detect() {
    try {
      const saved = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      if (saved && DICT[saved]) return saved;
    } catch (_) { /* 隐私模式下 localStorage 可能抛错 */ }
    const nav = (root.navigator && (root.navigator.language || root.navigator.userLanguage)) || '';
    if (/^zh\b/i.test(nav)) return 'zh-CN';
    if (/^en\b/i.test(nav)) return 'en';
    return FALLBACK; // 其他语言先给中文（游戏文案本身是中文，规则术语更好懂）
  }

  let lang = detect();

  /** 取词：当前语言 → 中文兜底 → 返回 null（由调用方决定退回页面原文案） */
  function lookup(key, l) {
    const table = DICT[l] || DICT[FALLBACK];
    if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    const fb = DICT[FALLBACK];
    if (fb && Object.prototype.hasOwnProperty.call(fb, key)) return fb[key];
    return null;
  }

  /**
   * 取词并替换 {name} 占位。
   * @returns {string|null} 找不到时返回 **null**（而不是键名）——调用方据此保留原文案。
   */
  function t(key, vars) {
    const raw = lookup(key, lang);
    if (raw == null) return null;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  }

  /** 若取不到词就保留元素原文案；取到了才替换（缺 key 时不会露键名） */
  function applyAttrs(el, key, attr, set) {
    const val = t(key);
    if (val == null) return false;
    if (attr) el.setAttribute(attr, val); else set(el, val);
    return true;
  }

  function applyI18n(doc) {
    const d = doc || root.document;
    if (!d) return 0;
    let n = 0;
    for (const el of d.querySelectorAll('[data-i18n]')) {
      if (applyAttrs(el, el.getAttribute('data-i18n'), null, (e, v) => { e.textContent = v; })) n++;
    }
    for (const el of d.querySelectorAll('[data-i18n-html]')) {
      // 仅用于含 <br> 这类内联标签的固定文案（内容来自本文件，不含用户输入）
      if (applyAttrs(el, el.getAttribute('data-i18n-html'), null, (e, v) => { e.innerHTML = v; })) n++;
    }
    for (const el of d.querySelectorAll('[data-i18n-placeholder]')) {
      if (applyAttrs(el, el.getAttribute('data-i18n-placeholder'), 'placeholder', null)) n++;
    }
    for (const el of d.querySelectorAll('[data-i18n-title]')) {
      if (applyAttrs(el, el.getAttribute('data-i18n-title'), 'title', null)) n++;
    }
    for (const el of d.querySelectorAll('[data-i18n-aria]')) {
      if (applyAttrs(el, el.getAttribute('data-i18n-aria'), 'aria-label', null)) n++;
    }
    if (d.documentElement) d.documentElement.lang = lang;
    return n;
  }

  function setLang(next, doc) {
    if (!DICT[next]) return false;
    lang = next;
    try { root.localStorage && root.localStorage.setItem(STORAGE_KEY, next); } catch (_) { /* ignore */ }
    applyI18n(doc); // 允许调用方指定重刷目标（测试与嵌入式场景用）
    syncSwitcher();
    return true;
  }

  function syncSwitcher() {
    const d = root.document;
    if (!d) return;
    const btn = d.getElementById('btn-lang');
    if (btn) btn.textContent = lang === 'zh-CN' ? '🌐 中' : '🌐 EN';
  }

  function mount() {
    const d = root.document;
    if (!d) return;
    applyI18n(d);
    const btn = d.getElementById('btn-lang');
    if (btn) {
      syncSwitcher();
      btn.addEventListener('click', () => setLang(lang === 'zh-CN' ? 'en' : 'zh-CN'));
    }
  }

  const I18N = { DICT, LANGS: Object.keys(DICT), FALLBACK, t, lookup, detect, setLang, getLang: () => lang, applyI18n, mount };
  root.I18N = I18N;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
  if (root.module && root.module.exports) root.module.exports = I18N; // 便于 Node 直接 require（浏览器里没有 module）
})(typeof window !== 'undefined' ? window : globalThis);
