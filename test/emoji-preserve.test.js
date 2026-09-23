/**
 * emoji-preserve.test.js — 「不许误删正常 emoji」的**窄**守卫（计划书 §3 第 78 行）
 *
 * 第 78 行要求核心导航/操作图标改用统一 SVG，**同时**明确不许顺手清洗聊天内容 / 玩家姓名 /
 * 角色文本里的正常 emoji。上一批（M1 自定义头像）把两端两份 `AVATAR_EMOJI` 表并进
 * `web/shared/avatar-badge.js` 时，全仓库 emoji 字面量从 1061 降到 1039，变化只落在 4 个头像相关文件 ——
 * 那次**保住了** 7 处非头像 `👤`，但这条约束当时**没有任何断言**，全靠人工核对（上一批如实上报的覆盖缺口）。
 * 本文件只补这条缺口，且刻意收窄：
 *
 *   ✓ 钉住「这几条非头像文案必须还在」：逐条给出 文件 + 大致位置 + 必须出现的字面量
 *   ✓ 钉住「头像那套字面量不得回流到 web/app.js / web/m/m.js」
 *   ✓ 钉住 `src/engine/roles.js` / `web/i18n.js` 的 emoji 计数**基线**（跌破基线−容差 = 批量误删）
 *   ✗ **不**钉全仓库 emoji 总数 —— 那会让任何正常新增 emoji 都变红，是坏守卫
 *   ✗ **不**钉 **AI 生成**的聊天正文 / 玩家自填姓名里的 emoji **个数** —— 那些本来就该随文案自由变化
 *
 * ══ 缺口 A（本次补上）：聊天内容 / 发言模板 / 系统消息 / 玩家姓名 ═══════════════
 * 上面那 5 条只钉了 6 处非头像 `👤` 与两份文件的计数地板，**没有**覆盖"有人顺手清洗聊天/发言/
 * 系统消息模板里的 emoji"（上一批如实上报的覆盖缺口）。A 组四条用例补的就是它，
 * 覆盖范围是**grep 摸出来的**（HEAD 实测），不是假设的：
 *   · 聊天内容：两端 `renderEventNode()` 里的气泡模板（公开发言 /「狼队频道」私聊气泡，
 *     它们把玩家名 + 聊天正文嵌进 innerHTML）—— `web/app.js`、`web/m/m.js`
 *   · 发言模板：发言上下文标签表（狼聊/遗言/警上/PK）、阶段状态文案、"正在发言"提示 —— 同上
 *   · 系统消息：两端 `appendSys(...)`、推送/等待/复盘文案，以及**服务端**的 `src/engine/render.js`
 *   · 玩家姓名：「你是 N号 昵称 · 身份」姓名行、座位警徽徽记，以及**唯二会动昵称的两条路径**
 *     （引擎侧 `src/engine/text.js` 的 sanitizeInline、两端共享的 `web/shared/profile-state.js` 预填）
 * A 组刻意**不**钉：AI 生成的对局正文（模型爱不爱用 emoji 该自由）、全仓库总数。
 * A 组**抓不到**：① 没列进清单的模板改写；② 把 emoji 换成另一个 emoji（文案改写 ≠ 误删）；
 *   ③ 纯运行时的清洗（例如对 `d.text` 跑一遍 `\p{Extended_Pictographic}` 过滤）——
 *   静态字面量守卫看不见，只有 A4 的行为用例能挡住"昵称被清洗"这一类。
 *
 * ══ emoji 口径（这份文件最容易写歪的地方）════════════════════════════════════
 * `\p{Extended_Pictographic}` + **字符簇折叠**：
 *   · 簇内含任一 `\p{Extended_Pictographic}`，或含键帽 `U+20E3` → 记 **1**
 *     （`1️⃣` = 0031 FE0F 20E3，基数 `1` 本身不是 pictographic，只看字符属性会把它漏掉）
 *   · 折叠保证 `❤️`(2764 FE0F)、`👍🏽`(1F44D 1F3FD)、`👨‍👩‍👧`(ZWJ)、`1️⃣` 各只算 1 个
 *   · 裸 `✓`(U+2713) `✗`(U+2717) `≥`(U+2265) `→`(U+2192) **都不算 emoji**
 *     （`\p{So}` 是**错**的口径：实测它把 ✓/✗ 算进去 —— `\p{So}` 见「口径自检」用例的钉法）
 * 「口径自检」把这些事实钉死：换口径（例如偷懒用 `\p{So}`）会当场判红，而不是把基线悄悄算歪。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const linesOf = (rel) => read(rel).split(/\r?\n/);

const EXT_PICT = /\p{Extended_Pictographic}/u;
const KEYCAP = '\u20E3';
/** 字符簇切分：ZWJ 连字 / 肤色修饰 / FE0F / 键帽都会归进同一个簇 */
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

function clusters(text) {
  return [...SEGMENTER.segment(String(text))].map((s) => s.segment);
}

/** 该簇是否算 1 个 emoji（键帽序列的基数不是 pictographic，必须单独认） */
function isEmojiCluster(c) {
  return EXT_PICT.test(c) || c.indexOf(KEYCAP) >= 0;
}

function countEmoji(text) {
  let n = 0;
  for (const c of clusters(text)) if (isEmojiCluster(c)) n++;
  return n;
}

test('口径自检：字符簇折叠成 1，且裸 ✓/✗/≥/→ 不算 emoji（挡住 \\p{So} 这种错口径）', () => {
  // 先把「错口径真的会算出别的答案」这件事钉住，免得有人以为口径怎么写都一样
  assert.strictEqual(('✓✗'.match(/\p{So}/gu) || []).length, 2, '事实：✓✗ 在 \\p{So} 下是 2 个 —— 所以 \\p{So} 不能当 emoji 口径');
  assert.strictEqual(countEmoji('✓✗≥→'), 0, '裸 ✓/✗/≥/→ 不是 emoji');
  assert.strictEqual(countEmoji('abc 123 +-'), 0, '纯 ASCII 不是 emoji');
  // 组合序列必须折叠成 1（FE0F / 键帽 / 肤色 / ZWJ）
  assert.strictEqual(countEmoji('✔'), 1, 'U+2714 HEAVY CHECK MARK 是真 emoji');
  assert.strictEqual(countEmoji('❤️'), 1, 'FE0F 变体选择符不额外计数');
  assert.strictEqual(countEmoji('1️⃣'), 1, '键帽 20E3 要计入（基数 1 不是 pictographic）');
  assert.strictEqual(countEmoji('👍🏽'), 1, '肤色修饰符不额外计数');
  assert.strictEqual(countEmoji('👨‍👩‍👧'), 1, 'ZWJ 家庭只算 1 个');
});

/**
 * 非头像 `👤` 的 6 处**源码/HTML 字面量**（M1 合并后 HEAD 的人工核对基线）。
 * `window` = 允许的上下行漂移（这就是"大致位置"：文案必须还在，但不把守卫绑死在行号上）。
 *
 * ⚠ 行号是"大致位置"的锚点，**上面加几行注释就会漂**：A3b 在 web/app.js 的 PHASE_LABEL 定义
 * 与 ww_resumable 清理处各加了几行注释、在 web/m/m.js 的 PHASE_LABEL 处加了注释，两处 `👤`
 * 字面量因此各下移（app.js 1147→1175、m.js 1366→1392），原来 ±25 的窗口刚好差一点。
 * 处理方式是**把锚点对齐到真实行号**（window 仍为 25，判据强度一字未改）；
 * 不许改成"整文件找得到就算过" —— 那会把"字形被搬走/被替换"这类退化放过去。
 *
 * 第 7 处 `web/shared/avatar-badge.js:15` 在**注释**里提到旧 `'👤'` 兜底字形，**故意不钉**：
 * 注释随时可能被改写，钉它只会制造与事实无关的假红 —— 而且删掉那句注释并不损失任何用户可见文案。
 */
const REQUIRED_LITERALS = [
  {
    file: 'web/app.js', line: 558, window: 25,
    literal: '👤 ${escapeHtml(profile.nickname)}',
    note: '顶栏档案信息里的**玩家姓名**前缀（"不许误删玩家姓名 emoji"的直接落点）',
  },
  // ⚠ 这两条 line 是 M2-c 施工后的**位置重锚**：字面量、window（25）、note 全都没动，只有记录的行号跟着
  //   新增的玩家中心代码下移（app.js +70：openPlayerCenter/pcFetch/fillPc* 的"先取数再一次画完"；
  //   m.js +317：手机端玩家中心独立页）。判据强度不变 —— 仍是"±25 行内必须逐字命中"。
  // ⚠ M2-d 再次重锚 app.js 的两条（423→558、1245→1361）：本批在 app.js 前面插了五条共享模块的薄接线
  //   （state 上的 dirty 引用、request-guard/prefs-queue 工厂、开局草稿的 load/apply），字面量逐字未动、
  //   window 仍为 25、两条都仍在（整文件命中 1 次）。
  // ⚠ m.js 那条也**在本批**漂了（1709→1788）：本批给 m.js 也加了同一套薄接线与守卫（state 上的两个 dirty
  //   引用、request-guard/prefs-queue 工厂、归档阻止、笔记草稿钩子），字面量逐字未动、整文件仍命中 1 次。
  //   施工中途我曾写过"m.js 的 1709 未漂、无需动"——那句是**错的**（当时还没改 m.js，改完就漂了）；
  //   现按事实改为 1788。锚点一条一条在目标文件的 ±25 窗口内逐字核过，不是只看数字。
  // ⚠ M3 第一批（C1b）再锚一次（**只动锚点行号，字面量与 window 一字未改**）：
  //   ① web/m/index.html：底栏 #m-tabbar 从 #m-boards **内部**移到全部屏之外（#m-app 的直接子元素，
  //      排在最后一个 section.m-screen 之后），「👤 我的」页签随底栏从 109 搬到 278 ——
  //      这是**产品导航的位置变更**，不是"字形被搬走/被删"；字面量在整文件仍恰好命中 1 次。
  //   ② web/m/m.js：本批新增了「我的对局」独立页的共用取数/行构建/切屏函数与底栏同步（+约 60 行），
  //      档案弹层标题跟着下移 1788→1848；字面量仍在，整文件恰好命中 1 次。
  { file: 'web/app.js', line: 1361, window: 25, literal: '<h2>👤 玩家档案</h2>', note: '档案弹层标题' },
  { file: 'web/index.html', line: 199, window: 25, literal: '👤 我的档案', note: '桌面档案选择器标签' },
  { file: 'web/index.html', line: 291, window: 25, literal: '👤 档案管理', note: '桌面档案管理按钮' },
  { file: 'web/m/index.html', line: 278, window: 25, literal: '👤 我的', note: '手机端"我的"页签（M3 C1b：随底栏移到全部屏之后，109→278）' },
  { file: 'web/m/m.js', line: 1848, window: 25, literal: "openSheet('👤 我的档案'", note: '手机端档案弹层标题（M3 C1b：新增对局页代码后下移，1788→1848）' },
];

test('非头像 👤 文案：6 处必须仍在（逐条点名文件 / 大致位置 / 字面量）', () => {
  const misses = [];
  for (const item of REQUIRED_LITERALS) {
    const lines = linesOf(item.file);
    const lo = Math.max(0, item.line - item.window - 1);
    const hi = Math.min(lines.length, item.line + item.window);
    let inWindow = 0;
    for (let i = lo; i < hi; i++) if (lines[i].includes(item.literal)) inWindow++;
    if (inWindow === 0) {
      const whole = lines.filter((l) => l.includes(item.literal)).length;
      misses.push(
        `  ✖ ${item.file} 第 ${item.line}±${item.window} 行内找不到 ${JSON.stringify(item.literal)}` +
        `（整文件命中 ${whole} 次）—— ${item.note}`
      );
    }
  }
  assert.deepStrictEqual(misses, [], `非头像 emoji 被删掉或搬走了 ${misses.length} 处：\n${misses.join('\n')}`);
});

/**
 * 头像那套字面量不得回流。**信号的选择是这份守卫最容易被写坏的地方**：
 * 那 8 个头像 emoji 里，🐺🔮🌙🧪🎭 **同时**是合法角色/状态文案的字形，实测就躺在同两份文件里：
 *   · `web/app.js:2999`  `const icons = { …, dreamer:'🌙', wolf:'🐺', wolfbeauty:'💃', seer:'🔮', witch:'⚗️', … }` ← 角色图标表
 *   · `web/m/m.js:3315`  `return { night:'🌙 夜晚进行中…', sheriff:'🎩 警长竞选进行中…', … }`                      ← 状态标签表
 * 所以「某个头像 emoji 出现在 app.js / m.js 里」**不是**违规 —— 那恰恰是第 78 行反面要求保护的内容。
 * 能判红的只有「头像那张 **id → 字形映射表**」这个结构本身（`\p{So}` 之类的宽口径在这里会直接误伤角色表）。
 * 用两个结构信号：
 *   ① 被删掉的标识符 `AVATAR_EMOJI` 重新出现；
 *   ② 头像**独有** id（scholar / hunter / candle —— 实测在两端正文里出现 0 次；而 night/seer/wolf/witch
 *      会被上面那两张表合法占用，所以**不能**当信号）被写成 `id: '<emoji>'` 的映射。
 */
const AVATAR_ONLY_IDS = ['scholar', 'hunter', 'candle'];
const AVATAR_TABLE_RE = new RegExp(
  `\\b(?:${AVATAR_ONLY_IDS.join('|')})\\s*:\\s*['"\`][^'"\`]*\\p{Extended_Pictographic}`,
  'u'
);

test('头像字面量不得回流：两端不得再出现 AVATAR_EMOJI 那张表（合法角色 emoji 不算违规）', () => {
  const bad = [];
  for (const file of ['web/app.js', 'web/m/m.js']) {
    linesOf(file).forEach((line, i) => {
      if (/\bAVATAR_EMOJI\b/.test(line)) {
        bad.push(`  ✖ ${file}:${i + 1} 出现已删除的标识符 AVATAR_EMOJI：${line.trim().slice(0, 110)}`);
      }
      if (AVATAR_TABLE_RE.test(line)) {
        bad.push(`  ✖ ${file}:${i + 1} 疑似头像 id→emoji 映射表回流：${line.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepStrictEqual(
    bad,
    [],
    `头像 emoji 表应只存在于 web/shared/avatar-badge.js（单一真值），却回流到两端：\n${bad.join('\n')}`
  );
});

test('头像字形：共享徽记模块仍给出 8 枚 SVG 徽记，且渲染结果里没有 emoji 字形', () => {
  const badge = require('../web/shared/avatar-badge.js');
  assert.strictEqual(badge.AVATAR_IDS.length, 8, '八个内置头像 id 的数量变了');
  const defs = badge.defsMarkup();
  assert.strictEqual((defs.match(/<symbol /g) || []).length, 8, '每枚徽记应有一个 <symbol>：SVG 化不能退回 emoji');
  for (const id of badge.AVATAR_IDS) {
    const markup = badge.badgeMarkup(id);
    assert.strictEqual(EXT_PICT.test(markup), false, `${id} 的徽记渲染里出现了 emoji 字形`);
    assert.ok(markup.includes(`#${badge.symbolId(id)}`), `${id} 的徽记没有引用自己的 <symbol>`);
  }
});

/**
 * emoji 计数基线（口径见文件头）。容差**只开在下方**：
 *   · 下方容差 = 给计划书第 78 行「导航/操作图标改 SVG」这类**有意替换**留的路（逐条替换是渐进的，
 *     一刀切 0 会把下一步的正当改造直接拦死）；
 *   · 上方**不设限** = 新增 emoji 不判红（"钉全仓库总数"那种坏守卫正是死在这一点上）。
 * 但**批量下降**（上一次事故的形态：脚本式清洗、整表删掉）一定会跌破下界。
 */
const EMOJI_BASELINE = [
  { file: 'src/engine/roles.js', baseline: 15, tolerance: 2, note: '角色图鉴的定位/性格文案' },
  { file: 'web/i18n.js', baseline: 77, tolerance: 8, note: '界面外壳文案' },
];

test('emoji 基线：roles.js / i18n.js 不得批量减少（下界 = 基线 − 容差）', () => {
  const failures = [];
  for (const { file, baseline, tolerance, note } of EMOJI_BASELINE) {
    const count = countEmoji(read(file));
    const floor = baseline - tolerance;
    if (count < floor) {
      failures.push(`  ✖ ${file}：实测 ${count} < 下界 ${floor}（基线 ${baseline} − 容差 ${tolerance}）—— ${note} 疑似被批量清洗`);
    }
  }
  assert.deepStrictEqual(failures, [], `emoji 被批量误删：\n${failures.join('\n')}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// A 组（缺口 A）：聊天内容 / 发言模板 / 系统消息 / 玩家姓名 里的 emoji
//
// 为什么是**字面量清单 + 函数体内计数地板**这两种信号，而不是"再钉几个文件的总数"：
//   · 逐条字面量 → 单点误删（"顺手清洗了某条文案"）能精确点名，且**正常新增 emoji 永远不会红**
//     （清单只要求"这些必须还在"，不要求"只有这些"）；
//   · 计数地板 → 只覆盖"批量清洗"这一形态，且**只算聊天流渲染函数体内部**（导航/操作图标
//     在函数体之外，计划书 §78 把它们换成 SVG 完全不影响这里）；
//   · 行为用例 → 静态字面量看不见的"运行时清洗"（昵称被过滤）只能靠真实调用挡。
// 清单范围见文件头「缺口 A」一节（grep 实测的落点，不是假设）。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 必含 emoji 的**具体文案片段**（HEAD 实测存在；用整文件 `includes` 判定 ——
 * 刻意**不**绑行号：文案搬了位置不算破坏，"字面量整个消失"才算）。
 *
 * 写法说明：模板串里的 `${` 用 `${'$'}{` 拼出来，避免本文件自己的插值把被测字面量吃掉；
 * 逐字比较时以这里的 `literal` 为准（`\\p{Extended_Pictographic}` 口径只用于条目的自检）。
 */
const REQUIRED_CHAT_LITERALS = [
  // ---- 聊天内容：两端的气泡模板（玩家名 + 聊天正文都嵌在这两个模板里）----
  {
    file: 'web/app.js', category: '聊天内容',
    literal: `🔒 ${'$'}{seatLabel(e.actor)}${'$'}{d.human ? '（你）' : ''}：${'$'}{escapeHtml(d.text || '')}`,
    note: '桌面端「狼队频道」聊天气泡：说话人 + 聊天正文的模板（🔒 是频道标记）',
  },
  {
    file: 'web/m/m.js', category: '聊天内容',
    literal: `🔒 ${'$'}{seatLabel(e.actor)}${'$'}{d.human ? '（你）' : ''}：${'$'}{escapeHtml(d.text || '')}`,
    note: '手机端「狼队频道」聊天气泡：同上（两端必须一致）',
  },
  // ---- 发言模板：上下文标签 / 阶段状态 / 正在发言 ----
  {
    file: 'web/app.js', category: '发言模板',
    literal: `wolf: '🔒 狼聊', lastwords: '🕯 遗言', sheriff: '🎩 警上'`,
    note: '发言上下文标签表（狼聊/遗言/警上）—— 每条公开发言的气泡头上挂的就是它',
  },
  {
    file: 'web/m/m.js', category: '发言模板',
    literal: `wolf: '🔒 狼聊', lastwords: '🕯 遗言', sheriff: '🎩 警上'`,
    note: '手机端同一张标签表（pk 一项两端字形略有差异，故只钉前三个公共项）',
  },
  { file: 'web/app.js', category: '发言模板', literal: `'⚔️ PK'`, note: '桌面端 PK 发言标签（FE0F 变体选择符别丢）' },
  { file: 'web/app.js', category: '发言模板', literal: `'✍ 正在发言'`, note: '桌面端"谁正在发言"的实时提示' },
  { file: 'web/m/m.js', category: '发言模板', literal: `'✍ 正在发言'`, note: '手机端"谁正在发言"的实时提示' },
  { file: 'web/app.js', category: '发言模板', literal: `'💬 白天发言进行中…'`, note: '桌面端阶段状态文案（发言阶段）' },
  { file: 'web/m/m.js', category: '发言模板', literal: `'💬 白天发言进行中…'`, note: '手机端阶段状态文案（发言阶段）' },
  // ---- 系统消息：两端 appendSys + 服务端渲染 ----
  { file: 'web/app.js', category: '系统消息', literal: `'⏳ 等待其他玩家行动中…'`, note: '桌面端等待系统消息' },
  { file: 'web/m/m.js', category: '系统消息', literal: `'⏳ 等待其他玩家行动中…'`, note: '手机端等待系统消息' },
  { file: 'web/app.js', category: '系统消息', literal: `⚠️ 拉取失败：`, note: '桌面端拉取失败系统消息' },
  { file: 'web/m/m.js', category: '系统消息', literal: `⚠ 拉取失败：`, note: '手机端拉取失败系统消息（这一端没有 FE0F 变体选择符，故与桌面端字形不同）' },
  { file: 'web/app.js', category: '系统消息', literal: `'⚠️ 推送通道中断，已转为轮询`, note: '桌面端推送降级系统消息' },
  { file: 'web/m/m.js', category: '系统消息', literal: `'⚠ 推送中断，已切换为轮询'`, note: '手机端推送降级系统消息' },
  { file: 'web/app.js', category: '系统消息', literal: `'🎓 已请求教练点评`, note: '桌面端教练点评请求的系统消息' },
  { file: 'web/m/m.js', category: '系统消息', literal: `'⏳ 正在生成复盘…'`, note: '手机端复盘生成中的系统消息' },
  { file: 'web/app.js', category: '系统消息', literal: `🕯 第${'$'}{d.index}/${'$'}{d.total}步`, note: '桌面端夜间步骤播报（聊天流里的一行）' },
  { file: 'web/m/m.js', category: '系统消息', literal: `🕯 ${'$'}{escapeHtml(d.label)}（${'$'}{d.index}/${'$'}{d.total}）`, note: '手机端夜间步骤播报' },
  { file: 'src/engine/render.js', category: '系统消息', literal: `🕯 ${'$'}{d.label}`, note: '**服务端**系统消息渲染（不只是前端才管 emoji）' },
  { file: 'src/engine/render.js', category: '系统消息', literal: `⚠️ 这是你连续第二晚摄梦此人`, note: '服务端摄梦警告文案（私密系统消息）' },
  // ---- 玩家姓名：姓名行与座位徽记 ----
  {
    file: 'web/app.js', category: '玩家姓名',
    literal: `${'$'}{me.isSheriff ? ' 👑警长' : ''}${'$'}{me.alive ? '' : ' 💀'}`,
    note: '「你是 N号 昵称 · 身份 👑警长/💀」姓名行：徽记就挂在玩家名后面',
  },
  { file: 'web/m/m.js', category: '玩家姓名', literal: `put(el('span', 'b', '👑'))`, note: '手机端座位警徽徽记（名字左侧那一枚）' },
];

test('缺口 A：聊天/发言/系统消息/姓名 的必含 emoji 文案逐条钉住（缺失即点名文件与类别）', () => {
  const misses = [];
  for (const item of REQUIRED_CHAT_LITERALS) {
    if (read(item.file).includes(item.literal)) continue;
    misses.push(`  ✖ [${item.category}] ${item.file} 里找不到 ${JSON.stringify(item.literal)} —— ${item.note}`);
  }
  assert.deepStrictEqual(
    misses,
    [],
    `${misses.length} 处聊天/发言/系统消息/姓名文案里的 emoji 被删掉或改写了：\n${misses.join('\n')}`
  );
});

test('缺口 A 自检：清单本身有效（文件都在、每条字面量真的含 emoji、四个类别都非空）', () => {
  const badFiles = [];
  const badLiterals = [];
  const categories = new Set();
  for (const item of REQUIRED_CHAT_LITERALS) {
    categories.add(item.category);
    if (!fs.existsSync(path.join(ROOT, item.file))) badFiles.push(`  ✖ 清单里的文件不存在：${item.file}`);
    if (countEmoji(item.literal) === 0) {
      badLiterals.push(`  ✖ 清单条目其实不含 emoji（钉不住任何东西）：${item.file} ${JSON.stringify(item.literal)}`);
    }
  }
  const missing = ['聊天内容', '发言模板', '系统消息', '玩家姓名'].filter((c) => !categories.has(c));
  assert.deepStrictEqual(badFiles.concat(badLiterals, missing.map((c) => `  ✖ 清单缺少「${c}」这一类`)), [],
    'A 组清单自身失效了（空清单 / 写错口径 / 丢了一整类），它保护的文案等于没人守');
});

/**
 * 发言上下文标签表的结构约束：**四个键各自**都得带 emoji。
 *
 * 与上一条清单的分工：上一条钉住"这三条字面量还在"（含具体文案），这一条只要求
 * "每个上下文标签里必须还有一个 emoji" —— 所以改文案（`🕯 遗言` → `🕯️ 遗言`）不会红，
 * 而**删掉某一个标签的 emoji**（`lastwords: '遗言'`）会精确点名那个键。
 * 用"每个键都必须含"而不是"表里恰好 4 个 emoji"：以后**新增**发言上下文（带 emoji）不该判红。
 */
const SPEECH_TAG_KEYS = ['wolf', 'lastwords', 'sheriff', 'pk'];
const SPEECH_TAG_ANCHOR = /wolf:\s*'🔒 狼聊'/;

test('缺口 A：两端发言上下文标签表（狼聊/遗言/警上/PK）每个键都必须还带 emoji', () => {
  const failures = [];
  for (const file of ['web/app.js', 'web/m/m.js']) {
    const lines = linesOf(file);
    const idx = lines.findIndex((l) => SPEECH_TAG_ANCHOR.test(l));
    if (idx < 0) {
      failures.push(`  ✖ ${file}：找不到发言上下文标签表（锚点 wolf: '🔒 狼聊' 不见了）`);
      continue;
    }
    for (const key of SPEECH_TAG_KEYS) {
      const m = new RegExp(`\\b${key}\\s*:\\s*'([^']*)'`).exec(lines[idx]);
      if (!m) { failures.push(`  ✖ ${file}:${idx + 1} 标签表里「${key}」这一项没了`); continue; }
      if (countEmoji(m[1]) === 0) {
        failures.push(`  ✖ ${file}:${idx + 1} 标签「${key}」的文案「${m[1]}」里 emoji 被删了`);
      }
    }
  }
  assert.deepStrictEqual(failures, [], `发言上下文标签的 emoji 被删：\n${failures.join('\n')}`);
});

/**
 * 聊天流渲染函数体内的 emoji 计数地板（**只降不升**）。
 *
 * 范围为什么是"函数体内部"：用户读到的聊天/发言/系统消息**只**由 `renderEventNode()` 产出，
 * 而这个函数体里没有一枚**导航/操作**图标（🏠 ⚙ 📖 📥 🎲 🌐 全在函数体之外）——
 * 所以计划书 §78 的"导航图标改 SVG"不会碰到这条地板，而"顺手清洗聊天模板"一定会。
 * 容差按唯一一处**合法的整表替换**定价：`web/app.js` 的 night_step 角色图标表
 * （💗🛡️🌙🐺💃🔮⚗️🐦，8 枚，是**角色**图标、不是导航图标）若整体 SVG 化，计数会掉 8 ——
 * 所以桌面端给 12、手机端（没有那张表）给 8。再放宽就会让"清洗掉大半聊天 emoji"漏网。
 * 抓不到：掉幅小于容差的逐个误删（那些由上面的逐条清单负责点名）。
 */
const RENDER_FLOOR = [
  { file: 'web/app.js', baseline: 46, tolerance: 12, note: '桌面端 renderEventNode（含 night_step 角色图标表 8 枚）' },
  { file: 'web/m/m.js', baseline: 37, tolerance: 8, note: '手机端 renderEventNode' },
];

/** 取聊天流渲染函数的函数体（锚点 = 顶层 `function renderEventNode(`，结束 = 之后第一个顶格 `}`） */
function renderEventBody(rel) {
  const lines = linesOf(rel);
  const start = lines.findIndex((l) => /^function renderEventNode?\(/.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) return null;
  return lines.slice(start, end + 1).join('\n');
}

test('缺口 A：聊天流渲染函数体内的 emoji 不得成批减少（地板 = 基线 − 容差）', () => {
  const failures = [];
  for (const { file, baseline, tolerance, note } of RENDER_FLOOR) {
    const body = renderEventBody(file);
    if (body === null) {
      failures.push(`  ✖ ${file}：找不到聊天流渲染函数 renderEventNode（改了函数名就请同步这条守卫）—— ${note}`);
      continue;
    }
    const count = countEmoji(body);
    const floor = baseline - tolerance;
    if (count < floor) {
      failures.push(`  ✖ ${file}：函数体内 emoji 实测 ${count} < 下界 ${floor}（基线 ${baseline} − 容差 ${tolerance}）—— ${note} 疑似被批量清洗`);
    }
  }
  assert.deepStrictEqual(failures, [], `聊天流渲染函数体里的 emoji 成批减少：\n${failures.join('\n')}`);
});

/**
 * 玩家姓名是**用户自填**的：emoji 在这里被"顺手清洗"是最可能的事故形态，
 * 而静态字面量看不见它（昵称进的是变量）。所以这一条走真实调用：只钉**唯二**会动昵称的代码路径 ——
 *   ① 引擎侧单行化清洗 `sanitizeInline`（昵称会嵌进提示词结构行，见 src/engine/text.js 注释）；
 *   ② 两端共用的切档预填 `profile-state.selectProfile`（用户手改过就不覆盖）。
 * 只断言"emoji 字符簇数量不变"：清洗该做的活（控制字符、结构标记、长度截断）仍然必须发生。
 */
test('缺口 A：玩家姓名清洗/预填不得吃掉 emoji（引擎 sanitizeInline + 共享 profile-state）', () => {
  const { sanitizeInline } = require('../src/engine/text.js');
  const cases = ['🐺阿甲', '阿甲👤', '👨‍👩‍👧一家', '👍🏽好评', '1️⃣号', '❤️心'];
  const stripped = [];
  for (const raw of cases) {
    const out = sanitizeInline(raw, 20);
    if (countEmoji(out) !== countEmoji(raw)) {
      stripped.push(`  ✖ sanitizeInline(${JSON.stringify(raw)}) = ${JSON.stringify(out)} —— emoji 从 ${countEmoji(raw)} 个变成 ${countEmoji(out)} 个`);
    }
  }
  assert.deepStrictEqual(stripped, [], `引擎侧昵称清洗把 emoji 吃掉了：\n${stripped.join('\n')}`);
  // 它该干的活还在（不是"什么都不过滤"）：结构标记与控制字符必须照旧剔除
  assert.strictEqual(sanitizeInline('阿【甲】\u0007', 20), '阿甲', '结构标记/控制字符仍必须被剔除');
  assert.strictEqual(sanitizeInline('很长'.repeat(30), 6), '很长很长很长', '长度截断仍必须生效');

  // ② 切档预填：昵称里带 emoji 时必须逐字进输入框（两端共用这一份实现）
  const M = require('../web/shared/profile-state.js');
  const nick = '🐺阿甲👤';
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const state = { profiles: [{ id: 'p1', nickname: nick }], profileId: null };
  const input = { value: '', dataset: {} };
  M.selectProfile({ state, storage, profileId: 'p1', nameInput: input });
  assert.strictEqual(input.value, nick, '昵称框预填必须逐字保留玩家姓名里的 emoji');
  assert.strictEqual(countEmoji(input.value), countEmoji(nick), '预填后 emoji 个数不得变化');
});

