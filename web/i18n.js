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
      'home.kicker': '月夜议会',
      'home.brand': 'AI 狼人杀',
      'home.navAria': '历史、资料与设置入口',
      'home.lobby': '大厅',
      'home.history': '对局历史',
      'home.historyTitle': '对局历史（按当前档案）',
      'home.historyDescription': '按当前玩家档案查看未结束对局、战绩和公开事件。',
      'home.castNav': 'AI 来客',
      'home.rulebook': '规则书',
      'home.rulebookDescription': '胜负条件、夜晚顺序和本局角色说明。',
      'home.setupNav': '设置',
      'home.settingsPage': '设置',
      'home.settingsDescription': '模型与密钥属于此设备；外观偏好跟随当前玩家档案。',
      'home.wizardPage': '创建对局',
      'home.wizardDescription': '先确认模式与模型，再选择板子和座位。',
      'home.appearanceTitle': '界面外观与字体大小',
      'wizard.modeTitle': '开局前，选择对局模式',
      'wizard.modeHint': '免费试玩使用本地流程脚本；真实对局需要先保存模型地址、模型名和 API Key。',
      'wizard.mockTitle': '免费试玩',
      'wizard.mockHint': '不调用模型 · 不产生 API 费用',
      'wizard.realTitle': '真实对局',
      'wizard.realHint': '使用下方配置的模型 · 按服务商用量计费',
      'wizard.backLobby': '返回大厅',
      'wizard.keyReady': '模型与 API Key 已保存，可以继续选择板子。',
      'wizard.keyMissing': '真实对局需要先保存模型地址、模型名和 API Key；也可选免费试玩。',
      'wizard.prev': '← 上一步',
      'wizard.next': '下一步 →',
      'wizard.confirm': '确认开局',
      'wizard.fixKeys': '去配置模型与密钥',
      'wizard.stepsAria': '开局步骤',
      'wizard.stepBoard': '2 板子与规则',
      'wizard.stepPlayers': '3 参与与座位',
      'wizard.stepConfirm': '4 确认开局',
      'wizard.myProfile': '👤 我的档案',
      'wizard.expandRules': '展开规则长表（夜晚顺序 / 自救 / 警长竞选…通常不用改）',
      'resume.activeTitle': '继续上局',
      'resume.diskTitle': '从存档恢复',
      'settings.appearance': '外观与操作',
      'settings.appearanceHint': '档案级偏好 · 保存后立即生效并跟随档案',
      'settings.fontScale': '界面字号',
      'settings.small': '小',
      'settings.standard': '标准',
      'settings.large': '大',
      'settings.layout': '阅读布局',
      'settings.reading': '阅读',
      'settings.compact': '紧凑',
      'settings.reduceMotion': '减少动态效果（关闭过渡与动画）',
      'settings.prefStatus': '保存到当前档案；切换档案后各自生效。',
      'settings.gamePrefs': '游戏默认偏好',
      'settings.gamePrefsHint': '开局后板子与规则固定，中途不可修改',
      'settings.modelKeys': '模型与密钥',
      'settings.modelKeysHint': '此设备共享 · 不随档案切换',
      'settings.fastModelPlaceholder': '留空则与上面一致',
      'settings.clearKeys': '清空额外 Key',
      'settings.probe': '探测并发额度',
      'settings.deviceData': '设备与数据',
      'settings.recoveries': '检查待清理恢复记录',
      'settings.manageData': '档案管理（导入 / 导出 / 战绩）',
      'settings.mobilePage': '手机端页面',
      'settings.about': '关于',
      'settings.localData': '本机单机运行：对局、笔记与档案只保存在这台电脑上；模型请求直接发往你配置的服务商地址。',
      'home.profileHint': '本机玩家档案 · 战绩 / 笔记 / 经验按档案隔离',
      'home.manageProfiles': '管理档案…',
      'home.switchProfile': '切换玩家',
      'home.entryQuestion': '你想如何进入？',
      'home.mockDescription': '免费试玩 / 本地剧本演练 · 不调用 API',
      'home.realDescription': '真实对局 / 使用已配置模型 · 按服务商用量计费',
      'home.emptyHint': '没有进行中的对局。点「开始游戏」按步骤开局，确认前随时可以后退修改。',
      'home.heroTitle': '月已升，诸位请入席',
      'home.heroDescription': '一位人类 · 一桌 AI · 每句话都可能改变结局。',
      'home.costHint': '试玩局用本地流程脚本推进（不调用模型、完全免费）；真实对局才调用你配置的模型服务商，按用量计费。',
      'home.castTitle': '今夜来客',
      'home.castDescription': '不同的性格，相同的游戏规则。人物外观不代表身份或阵营。',
      'home.castOpen': '翻阅来客名册 ↗',
      'home.rolesAndRules': '角色与规则',
      'home.owner': '本局归属 👤 {name}',
      'home.keyWarning': '⚠ 真实模式需要先在「模型与密钥」保存 API Key（免费试玩不需要）。',
      'app.kicker': '月夜集会 · 村人闭眼，狼人睁眼',
  'codex.title': '角色图鉴',
  'codex.secThird': '❓ 第三方（阵营随对象变动）',
  'codex.pageOf': '第 {p} / {t} 页',
  'codex.pageOfFaction': '本阵营 {i} / {n} 页 · 共 {t} 页',
  'codex.catThird': '第三方',
  'codex.chipDynamic': '🔗 胜负阵营随暗恋对象',
  'codex.dynamicNote': '阵营不固定：绑定前按平民计，绑定后随对象 —— 对象是狼则你随狼胜，对象是好人则你随好人胜（预言家查验你永远是好人）。',
  'codex.catWolf': '狼',
  'codex.catGod': '神',
  'codex.catVillager': '民',
  'codex.sub': '共 {n} 个身份 · 狼 {w} / 神 {g} / 民 {v}',
  'codex.entry': '📖 角色图鉴',
  'codex.back': '← 返回',
  'codex.search': '搜索身份…',
  'codex.filterAll': '全部',
  'codex.filterWolf': '🐺 狼人',
  'codex.filterGod': '🛡 神职',
  'codex.filterVillager': '🌾 平民',
  'codex.filterInGame': '本局在场',
  'codex.secWolf': '🐺 狼人阵营',
  'codex.secGod': '🛡 神职阵营',
  'codex.secVillager': '🌾 平民阵营',
  'codex.inGame': '本局 ×{n}',
  'codex.chipNight': '🌙 夜间行动',
  'codex.chipDeath': '💥 出局触发',
  'codex.chipExplode': '💣 可自爆',
  'codex.chipExplodeShot': '🎯 自爆带走一人',
  'codex.chipVoteImmune': '🛡 放逐免疫',
  'codex.ability': '能力',
  'codex.aiTitle': '🤖 AI 会怎么打这个身份',
  'codex.aiHint': '这些是喂给 AI 的战术模板，真人玩家也可以参考',
  'codex.inspect': '🔍 检视大卡',
  'codex.rulebook': '📖 完整规则书',
  'codex.empty': '没有匹配的身份',
  'codex.pickHint': '点左侧任意一张牌查看细节',
  'digest.board': '板子',
  'digest.players': '{n} 人局',
  'digest.wolves': '狼 {w}',
  'digest.good': '好 {g}',
  'digest.play': '我参战',
  'digest.watch': '纯观战（上帝视角）',
  'digest.mock': 'Mock 试玩（不调 API）',
  'digest.model': '模型 {m}',
  'digest.pace': '节奏 {p}',
  'digest.unknownBoard': '自定义板子',
  'digest.noModel': '未配置模型',
  'app.title': '游戏大厅',
      'app.sub': '本地网页版 · 1 名人类玩家 + AI · OpenAI 兼容接口',
      'skip.toMain': '跳到主内容',
      'common.save': '保存配置',
      'common.test': '测试连接',
      'common.refresh': '刷新',
      'common.close': '关闭',

      'api.title': 'API 配置',
      'api.baseUrl': '接口地址 base_url',
      'api.model': '模型 model',
      'api.key': 'API Key',
      'api.keys': '更多 API Key（可选，一行一个或用逗号分隔；每多一把 Key 就多一条并发通道）',
      'api.temp': '温度 temperature',
      'api.maxTokens': '最大回复 tokens（建议 16000，思考过程也计入）',
      'api.pace': '节奏档位（一次设定思考强度 / 反思频率 / 上下文预算）',
      'm.mockOn': '🧪 试玩中（不花钱）',
      'm.mockOff': '💳 真实对局（花钱）',
      'api.effort': '发言思考强度（发言/遗言/PK）',
      'api.effortLow': '轻度 low（默认，较快）',
      'api.effortMedium': '中档 medium',
      'api.effortHigh': '最高 high（最慢，实测单条发言平均等 100s+）',
      'api.fastEffort': '快速任务思考强度（夜晚/投票等）',
      'api.fastEffortLow': '最低 low（默认，最丝滑）',
      'api.fastEffortMedium': '中档 medium',
      'api.fastEffortHigh': '最高 high',
      'api.modelFast': '快速任务模型（留空 = 与主模型相同）。夜晚行动/投票/警竞这类微决策决策空间很小，却占掉一半以上调用次数，换更小更快的模型能明显提速；发言类仍走主模型',
      'api.budget': '上下文预算 tokens（每次决策的记忆预算，超出自动裁剪；默认 12000）',
      'api.cacheControl': '给 system 消息加显式缓存标记（部分服务商需要，默认走自动前缀缓存）',
      'api.keepAlive': '复用 HTTP 长连接（默认开：每次调用省一轮 TCP+TLS 握手，实测约 90ms）。若日志频繁出现「复用连接已失效（ECONNRESET）」，多半是防火墙/代理会掐断空闲连接，取消勾选即可',
      'api.langSwitch': '切换界面语言',

      'board.title': '板子',
      'board.template': '模板',
      'rules.title': '规则开关',
      'rules.defaultHint': '默认 = 网易12人守卫局',
      'rules.nightOrder': '夜晚行动顺序',
      'rules.nightOrderHint': '（默认按官方流程，通常不用改；展开可调整先后）',
      'players.title': '玩家',
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
      'start.button': '开始新局',
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
      'm.gearTitle': '设置（规则书 / 结束本局 / 退出）',
      'm.flipHint': '身份牌<br>点击翻开',
      'm.inspect': '🔍 检视',
      // §5 玩家中心（手机「我的」独立页面）：页面标题 + 四个固定分组的组名（逐字取自计划书 §5）
      'm.playerCenter': '玩家中心',
      'm.pc.profile': '个人资料',
      'm.pc.games': '对局与战绩',
      'm.pc.appearance': '外观与操作',
      'm.pc.data': '数据管理',
      'offline.title': '现在没有网络',
      'offline.body1': '离线时打不开新对局：AI 在服务器端调用模型，断网就没法继续了。',
      'offline.body2': '已经打开过的页面可以脱离网络显示，但任何推进对局的操作都需要联网——这是单并发、串行调用的必然结果，不是缓存能绕开的。',
      'offline.retry': '重试',
    },
    en: {
      'home.kicker': 'Moonlit Council',
      'home.brand': 'AI Werewolf',
      'home.navAria': 'History, references and settings',
      'home.lobby': 'Lobby',
      'home.history': 'Match history',
      'home.historyTitle': 'Match history for the current player',
      'home.historyDescription': 'Browse unfinished matches, records and public events for this local player.',
      'home.castNav': 'AI guests',
      'home.rulebook': 'Rulebook',
      'home.rulebookDescription': 'Victory conditions, night order and role explanations.',
      'home.setupNav': 'Settings',
      'home.settingsPage': 'Settings',
      'home.settingsDescription': 'Model and keys belong to this device. Appearance follows the current player.',
      'home.wizardPage': 'Create a match',
      'home.wizardDescription': 'Choose the mode and model first, then the board and your seat.',
      'home.appearanceTitle': 'Appearance and text size',
      'wizard.modeTitle': 'Choose a match mode first',
      'wizard.modeHint': 'Free practice uses local scripts. Real matches require a saved model URL, model name and API key.',
      'wizard.mockTitle': 'Free practice',
      'wizard.mockHint': 'No model calls · no API charges',
      'wizard.realTitle': 'Real match',
      'wizard.realHint': 'Uses the configured model · provider usage charges apply',
      'wizard.backLobby': 'Back to lobby',
      'wizard.keyReady': 'Model and API key saved. Continue to board selection.',
      'wizard.keyMissing': 'Save a model URL, model name and API key first, or choose free practice.',
      'wizard.prev': '← Previous',
      'wizard.next': 'Next →',
      'wizard.confirm': 'Start match',
      'wizard.fixKeys': 'Configure model and API key',
      'wizard.stepsAria': 'Match setup steps',
      'wizard.stepBoard': '2 Board & rules',
      'wizard.stepPlayers': '3 Players & seat',
      'wizard.stepConfirm': '4 Review & start',
      'wizard.myProfile': '👤 My player',
      'wizard.expandRules': 'Advanced rules (night order / self-save / sheriff election)',
      'resume.activeTitle': 'Resume match',
      'resume.diskTitle': 'Restore saved match',
      'settings.appearance': 'Appearance & controls',
      'settings.appearanceHint': 'Per-player preference · saves instantly and follows this player',
      'settings.fontScale': 'Text size',
      'settings.small': 'Small',
      'settings.standard': 'Standard',
      'settings.large': 'Large',
      'settings.layout': 'Reading layout',
      'settings.reading': 'Reading',
      'settings.compact': 'Compact',
      'settings.reduceMotion': 'Reduce motion (turn off transitions and animation)',
      'settings.prefStatus': 'Saved to the current player; each player keeps separate preferences.',
      'settings.gamePrefs': 'Match defaults',
      'settings.gamePrefsHint': 'Board and rules are fixed once the match begins',
      'settings.modelKeys': 'Model & API keys',
      'settings.modelKeysHint': 'Shared on this device · unaffected by player switching',
      'settings.fastModelPlaceholder': 'Leave blank to use the main model',
      'settings.clearKeys': 'Clear extra keys',
      'settings.probe': 'Probe concurrency',
      'settings.deviceData': 'Device & data',
      'settings.recoveries': 'Check pending import recovery',
      'settings.manageData': 'Manage players (import / export / records)',
      'settings.mobilePage': 'Mobile page',
      'settings.about': 'About',
      'settings.localData': 'This is a local app. Matches, notes and players stay on this computer; model requests go to your configured provider.',
      'home.profileHint': 'Local player · matches, notes and AI memory stay separate',
      'home.manageProfiles': 'Manage players…',
      'home.switchProfile': 'Switch player',
      'home.entryQuestion': 'How will you enter tonight?',
      'home.mockDescription': 'Free practice / local scripted AI · no API calls',
      'home.realDescription': 'Real match / configured model · provider usage charges apply',
      'home.emptyHint': 'No match in progress. Start a game and review each step before confirming.',
      'home.heroTitle': 'The moon has risen. Take your seat.',
      'home.heroDescription': 'One human · a table of AI guests · every word may change the outcome.',
      'home.costHint': 'Practice uses local scripts and is free. Real matches call your configured model provider and may incur charges.',
      'home.castTitle': 'Tonight’s guests',
      'home.castDescription': 'Different personalities, the same rules. A portrait never reveals a role or faction.',
      'home.castOpen': 'Browse the guest register ↗',
      'home.rolesAndRules': 'Roles and rules',
      'home.owner': 'Owned by 👤 {name}',
      'home.keyWarning': '⚠ A real match needs a saved API key under Model & keys. Free practice does not.',
      'app.kicker': 'Moonlit gathering · villagers sleep, wolves wake',
  'codex.title': 'Role codex',
  'codex.secThird': '❓ Third party (camp follows a target)',
  'codex.pageOf': 'Page {p} of {t}',
  'codex.pageOfFaction': '{i}/{n} in faction · page {p} of {t}',
  'codex.catThird': 'Third',
  'codex.chipDynamic': '🔗 Wins with the beloved',
  'codex.dynamicNote': 'Camp is not fixed: it counts as a villager before binding, then follows the beloved — win with wolves if they are a wolf, with the good side otherwise (the seer always sees you as good).',
  'codex.catWolf': 'Wolf',
  'codex.catGod': 'God',
  'codex.catVillager': 'Villager',
  'codex.sub': '{n} identities · {w} wolves / {g} gods / {v} villagers',
  'codex.entry': '📖 Role codex',
  'codex.back': '← Back',
  'codex.search': 'Search roles…',
  'codex.filterAll': 'All',
  'codex.filterWolf': '🐺 Wolves',
  'codex.filterGod': '🛡 Gods',
  'codex.filterVillager': '🌾 Villagers',
  'codex.filterInGame': 'In this game',
  'codex.secWolf': '🐺 Wolf faction',
  'codex.secGod': '🛡 God faction',
  'codex.secVillager': '🌾 Villager faction',
  'codex.inGame': 'In game ×{n}',
  'codex.chipNight': '🌙 Night action',
  'codex.chipDeath': '💥 Triggers on death',
  'codex.chipExplode': '💣 Can self-destruct',
  'codex.chipExplodeShot': '🎯 Takes one when self-destructing',
  'codex.chipVoteImmune': '🛡 Immune to exile',
  'codex.ability': 'Ability',
  'codex.aiTitle': '🤖 How the AI plays this role',
  'codex.aiHint': 'Tactics fed to the AI — human players can borrow them too',
  'codex.inspect': '🔍 Inspect card',
  'codex.rulebook': '📖 Full rulebook',
  'codex.empty': 'No matching roles',
  'codex.pickHint': 'Pick a card on the left for details',
  'digest.board': 'Board',
  'digest.players': '{n} players',
  'digest.wolves': 'wolves {w}',
  'digest.good': 'good {g}',
  'digest.play': 'I play',
  'digest.watch': 'Spectate (god view)',
  'digest.mock': 'Mock run (no API)',
  'digest.model': 'Model {m}',
  'digest.pace': 'Pace {p}',
  'digest.unknownBoard': 'Custom board',
  'digest.noModel': 'no model set',
  'app.title': 'Werewolf Hall',
      'app.sub': 'Local web build · 1 human + AI players · OpenAI-compatible API',
      'skip.toMain': 'Skip to main content',
      'common.save': 'Save',
      'common.test': 'Test connection',
      'common.refresh': 'Refresh',
      'common.close': 'Close',

      'api.title': 'API',
      'api.baseUrl': 'Base URL',
      'api.model': 'Model',
      'api.key': 'API key',
      'api.keys': 'More API keys (optional; one per line or comma-separated — each extra key adds one concurrent channel)',
      'api.temp': 'Temperature',
      'api.maxTokens': 'Max reply tokens (16000 recommended; reasoning counts too)',
      'api.pace': 'Pace preset (sets thinking effort / reflection frequency / context budget at once)',
      'm.mockOn': '🧪 Mock (free)',
      'm.mockOff': '💳 Real game (paid)',
      'api.effort': 'Speech thinking effort (speech / last words / PK)',
      'api.effortLow': 'low (default; faster)',
      'api.effortMedium': 'medium',
      'api.effortHigh': 'high (slowest; measured ~100s+ per speech on average)',
      'api.fastEffort': 'Fast-task thinking effort (night actions / votes)',
      'api.fastEffortLow': 'low (default, smoothest)',
      'api.fastEffortMedium': 'medium',
      'api.fastEffortHigh': 'high',
      'api.modelFast': 'Model for fast tasks (empty = same as main model). Night actions / votes / sheriff races are tiny decisions but more than half of all calls — a smaller, faster model speeds them up noticeably; speeches still use the main model',
      'api.budget': 'Context budget tokens (memory budget per decision, trimmed automatically; default 12000)',
      'api.cacheControl': 'Add an explicit cache marker to the system message (some providers require it; automatic prefix caching is the default)',
      'api.keepAlive': 'Reuse HTTP connections (on by default; saves a TCP+TLS handshake, ~90ms per call). If the log keeps showing ECONNRESET, a firewall or proxy is closing idle connections — turn it off.',
      'api.langSwitch': 'Switch interface language',

      'board.title': 'Board',
      'board.template': 'Template',
      'rules.title': 'Rule switches',
      'rules.defaultHint': 'default = NetEase 12-player guard board',
      'rules.nightOrder': 'Night action order',
      'rules.nightOrderHint': '(official order by default; expand to reorder)',
      'players.title': 'Players',
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
      'm.gearTitle': 'Settings (rulebook / end game / quit)',
      'm.flipHint': 'Role card<br>tap to reveal',
      'm.inspect': '🔍 Inspect',
      // §5 player center (mobile "Me" page): page title + the four fixed group names
      'm.playerCenter': 'Player center',
      'm.pc.profile': 'Profile',
      'm.pc.games': 'Games & record',
      'm.pc.appearance': 'Appearance & controls',
      'm.pc.data': 'Data',
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
    // data-i18n 会替换按钮的全部子节点；统一徽记必须在文案重刷后重新挂载。
    const d = doc || root.document;
    if (d && root.WWIcons && typeof root.WWIcons.mount === 'function') root.WWIcons.mount(d);
    if (d && typeof root.CustomEvent === 'function' && typeof d.dispatchEvent === 'function') {
      d.dispatchEvent(new root.CustomEvent('ww:languagechange', { detail: { lang } }));
    }
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
  // 便于 Node 直接 require（浏览器里没有 module，用 typeof 守卫）。
  // ⚠ 不能写成 root.module：被 require 的模块里 globalThis.module 是 undefined，
  // 那样这行永远不会执行，require('./web/i18n.js') 只会拿到空对象（实测过）。
  if (typeof module !== 'undefined' && module.exports) module.exports = I18N;
})(typeof window !== 'undefined' ? window : globalThis);
