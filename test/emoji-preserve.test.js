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
 *   ✗ **不**钉聊天内容/玩家姓名里 emoji 的个数 —— 那些本来就该随文案自由变化
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
 * 第 7 处 `web/shared/avatar-badge.js:15` 在**注释**里提到旧 `'👤'` 兜底字形，**故意不钉**：
 * 注释随时可能被改写，钉它只会制造与事实无关的假红 —— 而且删掉那句注释并不损失任何用户可见文案。
 */
const REQUIRED_LITERALS = [
  {
    file: 'web/app.js', line: 423, window: 25,
    literal: '👤 ${escapeHtml(profile.nickname)}',
    note: '顶栏档案信息里的**玩家姓名**前缀（"不许误删玩家姓名 emoji"的直接落点）',
  },
  { file: 'web/app.js', line: 1147, window: 25, literal: '<h2>👤 玩家档案</h2>', note: '档案弹层标题' },
  { file: 'web/index.html', line: 199, window: 25, literal: '👤 我的档案', note: '桌面档案选择器标签' },
  { file: 'web/index.html', line: 291, window: 25, literal: '👤 档案管理', note: '桌面档案管理按钮' },
  { file: 'web/m/index.html', line: 109, window: 25, literal: '👤 我的', note: '手机端"我的"页签' },
  { file: 'web/m/m.js', line: 1366, window: 25, literal: "openSheet('👤 我的档案'", note: '手机端档案弹层标题' },
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
