'use strict';
/**
 * 一次性给两个界面的静态文案打上 data-i18n 标记，并插入语言切换按钮。
 * 手工改 HTML 容易漏项，用脚本做且可重复执行（幂等：已有标记就跳过）。
 * 用法：node scripts/apply-i18n.js
 */
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');

/** [文件, 查找片段, 替换片段]；替换里必须包含 data-i18n 标记 */
const EDITS = {
  'index.html': [
    // 顶栏
    ['<a class="skip-link" href="#app">跳到主内容</a>', '<a class="skip-link" href="#app" data-i18n="skip.toMain">跳到主内容</a>'],
    ['<h1>🐺 AI 狼人杀</h1>', '<h1 data-i18n="app.title">🐺 AI 狼人杀</h1>'],
    ['<span class="sub">本地网页版 · 1 名人类玩家 + AI · OpenAI 兼容接口</span>',
      '<span class="sub" data-i18n="app.sub">本地网页版 · 1 名人类玩家 + AI · OpenAI 兼容接口</span>\n      <button class="btn ghost small" id="btn-lang" data-i18n-title="api.langSwitch" title="切换界面语言">🌐 中</button>'],
    // API 卡片
    ['<h2>① API 配置</h2>', '<h2 data-i18n="api.title">① API 配置</h2>'],
    ['<label>接口地址 base_url<input id="cfg-baseurl"', '<label><span data-i18n="api.baseUrl">接口地址 base_url</span><input id="cfg-baseurl"'],
    ['<label>模型 model<input id="cfg-model"', '<label><span data-i18n="api.model">模型 model</span><input id="cfg-model"'],
    ['<label>API Key<input id="cfg-key"', '<label><span data-i18n="api.key">API Key</span><input id="cfg-key"'],
    ['<label>温度 temperature<input id="cfg-temp"', '<label><span data-i18n="api.temp">温度 temperature</span><input id="cfg-temp"'],
    ['<label>最大回复 tokens（建议 16000，思考过程也计入）<input id="cfg-maxtokens"',
      '<label><span data-i18n="api.maxTokens">最大回复 tokens（建议 16000，思考过程也计入）</span><input id="cfg-maxtokens"'],
    ['<label>节奏档位（一次设定思考强度 / 反思频率 / 上下文预算）\n          <select id="cfg-pace"></select></label>',
      '<label><span data-i18n="api.pace">节奏档位（一次设定思考强度 / 反思频率 / 上下文预算）</span>\n          <select id="cfg-pace"></select></label>'],
    ['<label>发言思考强度（发言/遗言/PK）', '<label><span data-i18n="api.effort">发言思考强度（发言/遗言/PK）</span>'],
    ['<option value="low">最低 low（最快）</option>', '<option value="low" data-i18n="api.effortLow">最低 low（最快）</option>'],
    ['<option value="high">普通 high（默认）</option>', '<option value="high" data-i18n="api.effortHigh">普通 high（默认）</option>'],
    ['<label>快速任务思考强度（夜晚/投票等）', '<label><span data-i18n="api.fastEffort">快速任务思考强度（夜晚/投票等）</span>'],
    ['<option value="low">最低 low（默认，最丝滑）</option>', '<option value="low" data-i18n="api.fastEffortLow">最低 low（默认，最丝滑）</option>'],
    ['<option value="high">普通 high</option>', '<option value="high" data-i18n="api.fastEffortHigh">普通 high</option>'],
    ['<label>上下文预算 tokens（每次决策的记忆预算，超出自动裁剪；默认 12000）\n          <input id="cfg-budget"',
      '<label><span data-i18n="api.budget">上下文预算 tokens（每次决策的记忆预算，超出自动裁剪；默认 12000）</span>\n          <input id="cfg-budget"'],
    ['<label class="checkline"><input id="cfg-cachecontrol" type="checkbox"> 给 system 消息加显式缓存标记（部分服务商需要，默认走自动前缀缓存）</label>',
      '<label class="checkline"><input id="cfg-cachecontrol" type="checkbox"> <span data-i18n="api.cacheControl">给 system 消息加显式缓存标记（部分服务商需要，默认走自动前缀缓存）</span></label>'],
    ['<label class="checkline"><input id="cfg-keepalive" type="checkbox"> 复用 HTTP 长连接（默认开：每次调用省一轮 TCP+TLS 握手，实测约 90ms）。若日志频繁出现「复用连接已失效（ECONNRESET）」，多半是防火墙/代理会掐断空闲连接，取消勾选即可</label>',
      '<label class="checkline"><input id="cfg-keepalive" type="checkbox"> <span data-i18n="api.keepAlive">复用 HTTP 长连接（默认开：每次调用省一轮 TCP+TLS 握手，实测约 90ms）。若日志频繁出现「复用连接已失效（ECONNRESET）」，多半是防火墙/代理会掐断空闲连接，取消勾选即可</span></label>'],
    ['<button class="btn" id="btn-save-config">保存配置</button>', '<button class="btn" id="btn-save-config" data-i18n="common.save">保存配置</button>'],
    ['<button class="btn ghost" id="btn-test-config">测试连接</button>', '<button class="btn ghost" id="btn-test-config" data-i18n="common.test">测试连接</button>'],
    // 板子 / 规则 / 玩家
    ['<h2>② 板子</h2>', '<h2 data-i18n="board.title">② 板子</h2>'],
    ['<label>模板\n          <select id="board-template"></select>\n        </label>',
      '<label><span data-i18n="board.template">模板</span>\n          <select id="board-template"></select>\n        </label>'],
    ['<h2>③ 规则开关 <span class="hint">默认 = 网易12人守卫局</span></h2>',
      '<h2><span data-i18n="rules.title">③ 规则开关</span> <span class="hint" data-i18n="rules.defaultHint">默认 = 网易12人守卫局</span></h2>'],
    ['<h2>④ 玩家</h2>', '<h2 data-i18n="players.title">④ 玩家</h2>'],
    ['value="play" checked> 我当玩家（其余全是 AI）</label>', 'value="play" checked> <span data-i18n="players.modePlay">我当玩家（其余全是 AI）</span></label>'],
    ['value="watch"> 纯观战（上帝视角看 AI 互杀）</label>', 'value="watch"> <span data-i18n="players.modeWatch">纯观战（上帝视角看 AI 互杀）</span></label>'],
    ['<label>我的座位\n              <select id="my-seat"></select>\n            </label>',
      '<label><span data-i18n="players.seat">我的座位</span>\n              <select id="my-seat"></select>\n            </label>'],
    ['<label>我的昵称<input id="my-name"', '<label><span data-i18n="players.name">我的昵称</span><input id="my-name"'],
    ['<label class="checkline"><input id="use-mock" type="checkbox"> Mock 试玩（不调用 API，随机脚本 AI，用于测试流程）</label>',
      '<label class="checkline"><input id="use-mock" type="checkbox"> <span data-i18n="players.mock">Mock 试玩（不调用 API，随机脚本 AI，用于测试流程）</span></label>'],
    ['<h3>AI 玩家昵称</h3>', '<h3 data-i18n="players.aiNames">AI 玩家昵称</h3>'],
    ['<button class="btn ghost" id="btn-rand-names">随机昵称</button>', '<button class="btn ghost" id="btn-rand-names" data-i18n="players.randNames">随机昵称</button>'],
    ['<p class="hint">人格提示词可在下方高级选项为每个 AI 定制（可选）</p>', '<p class="hint" data-i18n="players.personaHint">人格提示词可在下方高级选项为每个 AI 定制（可选）</p>'],
    ['<summary class="hint">高级：AI 人格设置</summary>', '<summary class="hint" data-i18n="players.advanced">高级：AI 人格设置</summary>'],
    ['<button class="btn primary big" id="btn-start">🎮 开始游戏</button>', '<button class="btn primary big" id="btn-start" data-i18n="start.button">🎮 开始游戏</button>'],
    ['<h2>发现进行中的对局</h2>', '<h2 data-i18n="resume.title">发现进行中的对局</h2>'],
    ['<button class="btn primary" id="btn-resume">继续对局</button>', '<button class="btn primary" id="btn-resume" data-i18n="resume.continue">继续对局</button>'],
    ['<button class="btn ghost" id="btn-discard">放弃并清除</button>', '<button class="btn ghost" id="btn-discard" data-i18n="resume.discard">放弃并清除</button>'],
    // 游戏顶栏
    ['<button class="btn ghost" id="btn-rulebook">📖 规则书</button>', '<button class="btn ghost" id="btn-rulebook" data-i18n="game.rulebook">📖 规则书</button>'],
    ['<button class="btn ghost" id="btn-god">👁 上帝</button>', '<button class="btn ghost" id="btn-god" data-i18n="game.god">👁 上帝</button>'],
    ['<button class="btn danger" id="btn-terminate">⏹ 结束本局</button>', '<button class="btn danger" id="btn-terminate" data-i18n="game.terminate">⏹ 结束本局</button>'],
    ['<a class="btn ghost" href="/m/" title="手机 APP 端">📱 APP端</a>', '<a class="btn ghost" href="/m/" title="手机 APP 端" data-i18n="game.appLink" data-i18n-title="game.appLinkTitle">📱 APP端</a>'],
    ['<button class="btn ghost" id="btn-home">🏠 首页</button>', '<button class="btn ghost" id="btn-home" data-i18n="game.home">🏠 首页</button>'],
    ['aria-label="对局事件流"', 'aria-label="对局事件流" data-i18n-aria="game.streamAria"'],
    // 上帝面板
    ['<h3>👁 上帝 / 开发者面板</h3>', '<h3 data-i18n="god.title">👁 上帝 / 开发者面板</h3>'],
    ['title="关闭面板（返回玩家视角）">✕ 关闭</button>', 'title="关闭面板（返回玩家视角）" data-i18n-title="god.closeTitle"><span data-i18n="common.close">✕ 关闭</span></button>'],
    ['<h4>AI 上下文调试</h4>', '<h4 data-i18n="god.context">AI 上下文调试</h4>'],
    ['<button class="btn ghost" id="god-agent-refresh">刷新</button>', '<button class="btn ghost" id="god-agent-refresh" data-i18n="common.refresh">刷新</button>'],
    ['<h4>日志查看器</h4>', '<h4 data-i18n="god.logs">日志查看器</h4>'],
    ['<option value="">全部级别</option>', '<option value="" data-i18n="god.allLevels">全部级别</option>'],
    ['<option value="">全部模块</option>', '<option value="" data-i18n="god.allModules">全部模块</option>'],
    // 翻牌浮层
    ['<span class="cb-txt">❓<br>点击翻看你的身份</span>', '<span class="cb-txt" data-i18n-html="overlay.flipHint">❓<br>点击翻看你的身份</span>'],
    ['<button class="btn primary" id="btn-flip-done">我记住了，开始游戏</button>', '<button class="btn primary" id="btn-flip-done" data-i18n="overlay.flipDone">我记住了，开始游戏</button>'],
    ['<button class="btn" id="btn-inspect">🔍 检视卡牌</button>', '<button class="btn" id="btn-inspect" data-i18n="overlay.inspect">🔍 检视卡牌</button>'],
    // 脚本加载顺序：i18n → pwa → app（i18n 必须最先，pwa 取词依赖它）
    ['<script src="pwa.js"></script>', '<script src="i18n.js"></script>\n<script src="pwa.js"></script>'],
  ],
  'm/index.html': [
    ['<a class="skip-link" href="#m-app">跳到主内容</a>', '<a class="skip-link" href="#m-app" data-i18n="skip.toMain">跳到主内容</a>'],
    ['<h1>🦇 AI 狼人杀</h1>', '<h1 data-i18n="m.title">🦇 AI 狼人杀</h1>'],
    ['<p class="m-sub">✠ 选择你的战场 ✠</p>', '<p class="m-sub" data-i18n="m.sub">✠ 选择你的战场 ✠</p>'],
    ['<button class="btn" id="m-settings-btn">⚙ 设置</button>', '<button class="btn" id="m-settings-btn" data-i18n="m.settings">⚙ 设置</button>'],
    ['<button class="btn primary" id="m-next" disabled>下一步 →</button>', '<button class="btn primary" id="m-next" disabled data-i18n="m.next">下一步 →</button>'],
    ['<button class="btn small" id="m-back">←</button>', '<button class="btn small" id="m-back" data-i18n-title="m.back" title="返回">←</button>'],
    ['<h2 id="m-rules-title">对局规则</h2>', '<h2 id="m-rules-title" data-i18n="m.rulesTitle">对局规则</h2>'],
    ['<h3 class="m-h3">⚔ 对局规则</h3>', '<h3 class="m-h3" data-i18n="m.rulesSection">⚔ 对局规则</h3>'],
    ['<label>我的座位<select id="m-my-seat"></select></label>', '<label><span data-i18n="players.seat">我的座位</span><select id="m-my-seat"></select></label>'],
    ['<label>我的昵称<input id="m-my-name"', '<label><span data-i18n="players.name">我的昵称</span><input id="m-my-name"'],
    ['<p class="hint" style="margin-top:10px">AI 昵称开局自动从名字库随机（进入对局后无法修改）</p>',
      '<p class="hint" style="margin-top:10px" data-i18n="m.aiNamesHint">AI 昵称开局自动从名字库随机（进入对局后无法修改）</p>'],
    ['<button class="btn primary big" id="m-start">⚔ 开始游戏</button>', '<button class="btn primary big" id="m-start" data-i18n="m.start">⚔ 开始游戏</button>'],
    ['<button class="btn small ghost" id="m-log-btn" title="事件记录">📜</button>', '<button class="btn small ghost" id="m-log-btn" title="事件记录" data-i18n-title="m.logTitle">📜</button>'],
    ['<button class="btn small ghost" id="m-me-btn" title="我的身份">🎴</button>', '<button class="btn small ghost" id="m-me-btn" title="我的身份" data-i18n-title="m.meTitle">🎴</button>'],
    ['<button class="btn small ghost" id="m-rulebook-btn" title="规则书">📖</button>', '<button class="btn small ghost" id="m-rulebook-btn" title="规则书" data-i18n-title="game.rulebookTitle">📖</button>'],
    ['<button class="btn small danger" id="m-terminate-btn" title="结束本局">⏹</button>', '<button class="btn small danger" id="m-terminate-btn" title="结束本局" data-i18n-title="game.terminate">⏹</button>'],
    ['<button class="dtab sel" data-tab="log">📜 记录</button>', '<button class="dtab sel" data-tab="log" data-i18n="m.tabLog">📜 记录</button>'],
    ['<button class="dtab" data-tab="me">🎴 我的身份</button>', '<button class="dtab" data-tab="me" data-i18n="m.tabMe">🎴 我的身份</button>'],
    ['<div class="drawer-body">', '<div class="drawer-body" role="log" aria-live="polite" data-i18n-aria="game.streamAria">'],
    ['<div class="flip-back">身份牌<br>点击翻开</div>', '<div class="flip-back" data-i18n-html="m.flipHint">身份牌<br>点击翻开</div>'],
    ['<button class="btn primary" id="m-flip-done">开始游戏</button>', '<button class="btn primary" id="m-flip-done" data-i18n="m.start">开始游戏</button>'],
    ['<button class="btn" id="m-inspect-btn">🔍 检视</button>', '<button class="btn" id="m-inspect-btn" data-i18n="m.inspect">🔍 检视</button>'],
    // 语言切换按钮挂在设置屏（手机端空间紧张，放顶栏会挤）
    ['<button class="btn" id="m-settings-btn" data-i18n="m.settings">⚙ 设置</button>',
      '<button class="btn" id="m-settings-btn" data-i18n="m.settings">⚙ 设置</button>\n      <button class="btn" id="btn-lang" data-i18n-title="api.langSwitch" title="切换界面语言">🌐 中</button>'],
    ['<script src="../pwa.js"></script>', '<script src="../i18n.js"></script>\n<script src="../pwa.js"></script>'],
  ],
};

let changed = 0;
for (const [file, edits] of Object.entries(EDITS)) {
  const p = path.join(WEB, file);
  let html = fs.readFileSync(p, 'utf8');
  for (const [from, to] of edits) {
    if (html.includes(to) && from !== to) continue; // 幂等
    if (!html.includes(from)) {
      console.log(`⚠ ${file}: 未找到片段（可能已改过）: ${from.slice(0, 60)}…`);
      continue;
    }
    html = html.replace(from, to);
    changed++;
  }
  fs.writeFileSync(p, html);
}
console.log(`✓ 共应用 ${changed} 处标记`);
