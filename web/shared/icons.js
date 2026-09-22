/**
 * icons.js — **核心导航与操作图标**的唯一真值（计划书 §3 第 78 行前半句）
 *
 * 第 78 行原文：「核心导航和操作图标使用统一 SVG；**不要全局删除聊天内容或玩家姓名里的正常 emoji**。」
 * 上一批（M1 自定义头像）已经按同一套做法收敛了八个**头像**徽记（web/shared/avatar-badge.js）。
 * 本模块收敛的是**头像之外**的那一类：页面主导航 / 页签 / 操作按钮上的图标。
 *
 * ── 判据（本模块与这次改造的边界，按**位置**判而不按**字形**判）────────────────
 * 同一个字形在不同位置是不同角色：`🌐` 出现在语言切换按钮上是**操作图标**，
 * 出现在「🌐 局域网配对」这段状态文案里是**内容**。所以判据不能是"这个 emoji 删不删"。
 *
 *   换（导航/操作图标）当且仅当落在下面三类位置之一：
 *     ① 一个**可点击的导航/操作控件**的标签里（button / a / label / 页签 / 菜单项 / 行动键）；
 *     ② **由这类控件打开的弹层/抽屉的标题栏**里的图标（设置面板、回收站、私人笔记、规则书…）；
 *     ③ 一段**用该字形指路**的提示文案（"点圆桌座位上的 🏷 开始标注"）—— 换成同一个徽记，
 *        否则文案会指着一个已经不存在的字形，比不换更糟。
 *
 *   不换（内容，一律保留）：
 *     · 聊天/发言/系统消息/事件流/横幅/结算文案里的 emoji（`🔒 狼聊`、`🎉 好人阵营获胜！`…）；
 *     · 玩家姓名、昵称、档案文案里的 emoji；
 *     · **状态与严重度标记**：`⚠ ⚠️ ✅ ⏳ ⏸ 💭 🧠 ✍ 🧪 💳 👑 🚫 💀 🏆 🌙 🕯 🎩 🗳 ⚔️ 💥 🔫 🃏 🐺 🐦 🌱 🕊 🎭 🤝 ⏹ 🌅 💬`；
 *     · **角色语义表**（web/app.js 的角色图标表、web/m/m.js 的状态标签表）—— 它们字形上就是
 *       角色/阶段语义，不是导航；
 *     · 那 7 处非头像 `👤` 文案（顶栏姓名前缀、档案标题、档案标签、档案管理按钮、"我的"页签…）。
 *
 * 本模块**不提供**任何"清洗 emoji"的入口。`plainLabel()` 只服务于 ①②③ 三类位置：
 * 它删的是**标签开头那个图标字形**，标签内部与标签之后的 emoji 一律不动（见该函数注释与用例）。
 *
 * ── 三条纪律（与 avatar-badge.js 同一套）────────────────────────────────────────
 *  ① **一份定义、`<use>` 引用**：39 个 `<symbol>` 只注入一次，使用点各写一行 `<use>`。
 *  ② **只用 `currentColor`**：不写死任何十六进制色值；深浅底都由所在容器的文字色决定。
 *     次要结构用 `opacity` 降权，而不是换第二个颜色。
 *  ③ **统一风格**：24×24 画布、内容收在 2px 安全边距内、线宽 1.6、圆头圆角、全部写在
 *     一个 `<g>` 上（见 STROKE），而不是每个路径各写一遍。
 *
 * 零运行时依赖、无外部请求、随字号缩放（viewBox + em 尺寸）。
 */
'use strict';
(function (global) {
  /**
   * 39 个图标 id。名字按**语义**取（不是按原来那个 emoji 取），
   * 这样同一个语义在两端共用同一枚徽记 —— 例如桌面 `🎮 开始游戏` 与手机 `⚔ 开始游戏`
   * 原本是两个不同字形，现在都是 `start`。
   */
  const ICON_IDS = [
    'settings', 'codex', 'rulebook', 'card', 'lang', 'aiCast', 'mobile',
    'notes', 'god', 'inspect', 'ring', 'list',
    'start', 'resume', 'game', 'speech', 'players', 'tag',
    'home', 'end', 'trash', 'import', 'summary', 'coach', 'task', 'strategy',
    'undo', 'timeline', 'close', 'back', 'finish',
    'duel', 'explode', 'antidote', 'poison', 'sheriff', 'withdraw',
    'edit', 'create',
  ];

  /** 无障碍名（`<svg role="img">` 的 aria-label；徽记本身是装饰，但名字让屏幕阅读器不至于念空） */
  const ICON_NAME = {
    settings: '设置', codex: '角色图鉴', rulebook: '规则书', card: '身份牌', lang: '切换语言',
    aiCast: 'AI 来客名册', mobile: '手机端', notes: '私人笔记', god: '上帝面板', inspect: '检视',
    ring: '圆桌视图', list: '列表视图', start: '开始游戏', resume: '继续对局', game: '对局',
    speech: '发言', players: '玩家', tag: '笔记标记', home: '返回首页', end: '结束本局',
    trash: '回收站', import: '导入', summary: '本局总结', coach: 'AI 复盘', task: '任务',
    strategy: '策略参考', undo: '撤销', timeline: '时间线', close: '关闭', back: '返回',
    finish: '结算', duel: '决斗', explode: '自爆', antidote: '解药', poison: '毒药',
    sheriff: '上警', withdraw: '退水', edit: '编辑档案', create: '新建档案',
  };

  const DEFS_ID = 'ww-icon-defs';
  const SYMBOL_PREFIX = 'wwIc';
  const ICON_CLASS = 'ww-icon';

  /**
   * 统一的笔触属性：39 枚徽记共用同一套线宽/端点/连接，这才叫"统一风格"。
   * 写在 `<g>` 上一次，而不是每个 `<path>` 各写一遍。
   */
  const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  /** 内部小面积实心（眼睛/骰点/桌位点）：与线稿同一色，靠形状而不是靠第二个颜色区分 */
  const SOLID = 'fill="currentColor" stroke="none"';

  /**
   * 徽记线稿。共同约束（"统一风格"的可核对判据）：
   *   · 24×24 画布、内容收在 2px 安全边距内（圆形裁切与方形显示都不会蹭边）；
   *   · 只用直线/圆弧/圆/矩形，线宽统一 1.6、圆头圆角；
   *   · 语义尽量贴近被替换的那个字形（⚙=齿轮、🔍=放大镜、🗑=垃圾桶、🏠=房子、
   *     📖=摊开的书、🎓=学位帽、☠️=骷髅、🎩=礼帽…），视觉习惯不变；
   *   · 两端同语义共用一个 id（桌面 `🎮 开始游戏` 与手机 `⚔ 开始游戏` 都是 `start`）。
   */
  const MARKS = {
    // 设置：齿轮（外圈 + 八枚齿尖 + 内圈）
    settings: `
      <circle cx="12" cy="12" r="7.4"/>
      <circle cx="12" cy="12" r="2.9"/>
      <path d="M12 4.6V2.6M12 19.4v2M4.6 12h-2M19.4 12h2M17.2 6.8l1.4-1.4M6.8 6.8 5.4 5.4M17.2 17.2l1.4 1.4M6.8 17.2l-1.4 1.4"/>`,
    // 角色图鉴：摊开的书 + 右页上压着一张牌（字形习惯来自 📖 / 🎴）
    codex: `
      <path d="M12 6.6C10 5.1 7.7 4.9 5.4 6v11c2.3-1.1 4.6-.9 6.6.6 2-1.5 4.3-1.7 6.6-.6V6C16.3 4.9 14 5.1 12 6.6Z"/>
      <path d="M12 6.6v11"/>
      <path d="M14.4 9.2h4.2v5.4h-4.2Z" opacity=".5"/>`,
    // 规则书：合起的书 + 书脊 + 书签带（与"摊开的书"明确区分，避免和头像里那本学者书撞脸）
    rulebook: `
      <path d="M7.6 3.6h8.8a1.6 1.6 0 0 1 1.6 1.6v13.6a1.6 1.6 0 0 1-1.6 1.6H7.6Z"/>
      <path d="M7.6 3.6v16.8"/>
      <path d="M12.8 3.6v6l1.9-1.3 1.9 1.3v-6" opacity=".55"/>`,
    // 身份牌：一张竖牌 + 牌面上的月牙纹章（字形习惯来自 🎴）
    card: `
      <path d="M9.4 3.6h5.2a1.6 1.6 0 0 1 1.6 1.6v13.6a1.6 1.6 0 0 1-1.6 1.6H9.4a1.6 1.6 0 0 1-1.6-1.6V5.2a1.6 1.6 0 0 1 1.6-1.6Z"/>
      <path d="M12 8.2a2.5 2.5 0 0 0 3.8 3.8 3.8 3.8 0 1 1-3.8-3.8Z"/>`,
    // 语言：地球（圆 + 赤道 + 一条经线）
    lang: `
      <circle cx="12" cy="12" r="8.4"/>
      <path d="M3.6 12h16.8"/>
      <path d="M12 3.6c2.2 2.3 3.3 5.2 3.3 8.4S14.2 18.1 12 20.4c-2.2-2.3-3.3-5.2-3.3-8.4S9.8 5.9 12 3.6Z"/>`,
    // AI 来客名册：机器人头（天线 + 头 + 两侧听筒 + 两眼 + 嘴）
    aiCast: `
      <path d="M5.6 8.8h12.8v9.4H5.6Z"/>
      <path d="M3.6 11.4v4M20.4 11.4v4"/>
      <path d="M12 8.8V6.2"/>
      <circle cx="12" cy="5.2" r="1.1" ${SOLID}/>
      <circle cx="9.4" cy="12.6" r="1.2" ${SOLID}/>
      <circle cx="14.6" cy="12.6" r="1.2" ${SOLID}/>
      <path d="M9.8 15.8h4.4" opacity=".55"/>`,
    // 手机端：手机（机身 + 听筒 + Home 键）
    mobile: `
      <path d="M8.4 3.6h7.2a1.6 1.6 0 0 1 1.6 1.6v13.6a1.6 1.6 0 0 1-1.6 1.6H8.4a1.6 1.6 0 0 1-1.6-1.6V5.2a1.6 1.6 0 0 1 1.6-1.6Z"/>
      <path d="M10.6 6.2h2.8" opacity=".55"/>
      <circle cx="12" cy="17.2" r=".9" ${SOLID}/>`,
    // 私人笔记：线圈笔记本（封面 + 三个线圈 + 三行字）
    notes: `
      <path d="M7.4 4.4h11.2v15.2H7.4Z"/>
      <path d="M4.4 8h3M4.4 12h3M4.4 16h3"/>
      <path d="M10.6 9h5.2M10.6 12.4h5.2M10.6 15.8h3" opacity=".55"/>`,
    // 上帝面板：眼睛（眼形 + 瞳孔）
    god: `
      <path d="M2.8 12S6.3 6.4 12 6.4 21.2 12 21.2 12 17.7 17.6 12 17.6 2.8 12 2.8 12Z"/>
      <circle cx="12" cy="12" r="3.1"/>`,
    // 检视：放大镜
    inspect: `
      <circle cx="10.6" cy="10.6" r="6.2"/>
      <path d="M15.2 15.2 20.4 20.4"/>`,
    // 圆桌：圆桌 + 四个座位点
    ring: `
      <circle cx="12" cy="12" r="6.2" opacity=".6"/>
      <circle cx="12" cy="3.6" r="1.4" ${SOLID}/>
      <circle cx="12" cy="20.4" r="1.4" ${SOLID}/>
      <circle cx="3.6" cy="12" r="1.4" ${SOLID}/>
      <circle cx="20.4" cy="12" r="1.4" ${SOLID}/>`,
    // 列表：三行「点 + 线」
    list: `
      <path d="M9 6.6h11.2M9 12h11.2M9 17.4h11.2"/>
      <circle cx="4.8" cy="6.6" r="1.2" ${SOLID}/>
      <circle cx="4.8" cy="12" r="1.2" ${SOLID}/>
      <circle cx="4.8" cy="17.4" r="1.2" ${SOLID}/>`,
    // 开始游戏：圆角方框里的播放三角（两端原本是 🎮 与 ⚔ 两个字形，统一到一枚）
    start: `
      <path d="M6.4 4.6h11.2a1.8 1.8 0 0 1 1.8 1.8v11.2a1.8 1.8 0 0 1-1.8 1.8H6.4a1.8 1.8 0 0 1-1.8-1.8V6.4a1.8 1.8 0 0 1 1.8-1.8Z"/>
      <path d="M10.4 8.8 15.8 12l-5.4 3.2Z"/>`,
    // 继续对局：进入对局框的箭头（▶ 是"播放"，语义上继续用"进入"更准）
    resume: `
      <path d="M9.8 4.4h8.2a1.6 1.6 0 0 1 1.6 1.6v12a1.6 1.6 0 0 1-1.6 1.6H9.8"/>
      <path d="M3.6 12h11.2"/>
      <path d="M11.2 8.4 14.8 12l-3.6 3.6"/>`,
    // 对局：骰子（三点）
    game: `
      <rect x="5.2" y="5.2" width="13.6" height="13.6" rx="2.2"/>
      <circle cx="9.4" cy="9.4" r="1.15" ${SOLID}/>
      <circle cx="12" cy="12" r="1.15" ${SOLID}/>
      <circle cx="14.6" cy="14.6" r="1.15" ${SOLID}/>`,
    // 发言：对话气泡
    speech: `
      <path d="M4.6 5.8h14.8v10.4H12.4l-4.6 3.4v-3.4H4.6Z"/>`,
    // 玩家：两个人
    players: `
      <circle cx="9" cy="8.2" r="3.2"/>
      <path d="M3.8 19.4c0-2.9 2.3-5.2 5.2-5.2s5.2 2.3 5.2 5.2"/>
      <path d="M15.4 5.6a3.2 3.2 0 0 1 0 6" opacity=".7"/>
      <path d="M16.8 14.6c2 .7 3.4 2.5 3.4 4.8" opacity=".7"/>`,
    // 笔记标记：吊牌（五边形 + 孔）
    tag: `
      <path d="M13.4 3.8H20v6.6l-9.8 9.8-6.6-6.6Z"/>
      <circle cx="16.6" cy="7.2" r="1.4" ${SOLID}/>`,
    // 返回首页：房子
    home: `
      <path d="M3.8 11 12 4.2 20.2 11"/>
      <path d="M6.2 9.6v10.2h11.6V9.6"/>`,
    // 结束本局：停止方块
    end: `
      <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2"/>`,
    // 回收站：垃圾桶（盖 + 提手 + 桶身 + 两道竖纹）
    trash: `
      <path d="M4.4 7.4h15.2"/>
      <path d="M9.4 7.4V5.2h5.2v2.2"/>
      <path d="M6.4 7.4l1 12h9.2l1-12"/>
      <path d="M10.4 11v5.4M13.6 11v5.4" opacity=".55"/>`,
    // 导入：向下装入托盘
    import: `
      <path d="M12 4.2v9.6"/>
      <path d="M8.2 10.4 12 14.2l3.8-3.8"/>
      <path d="M4.8 16.4v2.2a1.6 1.6 0 0 0 1.6 1.6h11.2a1.6 1.6 0 0 0 1.6-1.6v-2.2"/>`,
    // 本局总结：坐标轴 + 三根柱子
    summary: `
      <path d="M4.4 4.4v15.2h15.2"/>
      <path d="M8.6 16.4v-4.8M12.4 16.4V7.6M16.2 16.4v-3"/>`,
    // AI 复盘：学位帽（帽板 + 帽围 + 流苏）
    coach: `
      <path d="M12 4.2 2.8 8.4 12 12.6l9.2-4.2Z"/>
      <path d="M6.6 10.4v4.4c0 1.7 2.4 3 5.4 3s5.4-1.3 5.4-3v-4.4" opacity=".7"/>
      <path d="M20.2 9.4v5" opacity=".5"/>`,
    // 任务：写字板（板 + 夹子 + 两行字）
    task: `
      <path d="M8.8 4.8H6.6a1.6 1.6 0 0 0-1.6 1.6v12.8a1.6 1.6 0 0 0 1.6 1.6h10.8a1.6 1.6 0 0 0 1.6-1.6V6.4a1.6 1.6 0 0 0-1.6-1.6h-2.2"/>
      <path d="M9.4 3.2h5.2v3.2H9.4Z"/>
      <path d="M9.2 12h5.6M9.2 15.4h3.4" opacity=".55"/>`,
    // 策略参考：罗盘（圆 + 指针菱形）
    strategy: `
      <circle cx="12" cy="12" r="8.4"/>
      <path d="M15.4 8.6 13.6 13.6 8.6 15.4 10.4 10.4Z" opacity=".85"/>`,
    // 撤销：回卷箭头
    undo: `
      <path d="M4.6 9.6h9.6a5.4 5.4 0 0 1 0 10.8H8.8"/>
      <path d="M8.4 5.6 4.4 9.6l4 4"/>`,
    // 时间线：双左三角（"回看"）。与 ⏮ 同一套语义
    timeline: `
      <path d="M11.6 5.6 5.6 12l6 6.4Z"/>
      <path d="M18.8 5.6 12.8 12l6 6.4Z"/>`,
    // 关闭：叉
    close: `
      <path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>`,
    // 返回：左箭头
    back: `
      <path d="M19.4 12H4.8"/>
      <path d="M10.6 5.8 4.4 12l6.2 6.2"/>`,
    // 结算：旗子
    finish: `
      <path d="M6.4 3.8v16.8"/>
      <path d="M6.4 4.8h11.4l-2.6 4 2.6 4H6.4Z"/>`,
    // 决斗：交叉双剑（两道剑身 + 两片护手）
    duel: `
      <path d="M4.8 4.6 17.6 17.4"/>
      <path d="M19.2 4.6 6.4 17.4"/>
      <path d="M15.2 19.6l4.4-4.4M8.8 19.6l-4.4-4.4" opacity=".6"/>`,
    // 自爆：水晶球（球 + 三脚架；与头像里的"先知"徽记用不同底座，避免两枚徽记撞脸）
    explode: `
      <circle cx="12" cy="9.6" r="5.8"/>
      <path d="M6.4 19.8 12 15.6l5.6 4.2"/>
      <path d="M6.4 19.8h11.2"/>`,
    // 解药：胶囊（斜置圆角矩形 + 分界）
    antidote: `
      <rect x="8.2" y="3.2" width="7.6" height="17.6" rx="3.8" transform="rotate(-45 12 12)"/>
      <path d="M14.7 9.3 9.3 14.7" opacity=".55"/>`,
    // 毒药：骷髅（颅顶 + 下颌 + 两眼 + 两齿缝）
    poison: `
      <path d="M12 3.6c-4.4 0-7.6 3-7.6 7 0 2.4 1.2 4.2 3 5.4v3.6h9.2v-3.6c1.8-1.2 3-3 3-5.4 0-4-3.2-7-7.6-7Z"/>
      <circle cx="9.2" cy="10.6" r="1.8" ${SOLID}/>
      <circle cx="14.8" cy="10.6" r="1.8" ${SOLID}/>
      <path d="M10.6 19.6v-3M13.4 19.6v-3" opacity=".5"/>`,
    // 上警：礼帽（帽檐 + 帽筒 + 帽带）
    sheriff: `
      <path d="M4.2 18.4h15.6"/>
      <path d="M7.4 18.4V6.6a1.4 1.4 0 0 1 1.4-1.4h6.4a1.4 1.4 0 0 1 1.4 1.4v11.8"/>
      <path d="M7.4 15.4h9.2" opacity=".5"/>`,
    // 退水：水滴
    withdraw: `
      <path d="M12 3.6c3.2 3.6 5.4 6.5 5.4 9.2a5.4 5.4 0 0 1-10.8 0c0-2.7 2.2-5.6 5.4-9.2Z"/>`,
    // 编辑档案：铅笔（笔杆 + 笔尾束 + 笔尖）
    edit: `
      <path d="M4.8 19.2 6 15.2 15.4 5.8l3.4 3.4L9.4 18.6Z"/>
      <path d="M13.8 7.4l3.4 3.4" opacity=".55"/>`,
    // 新建档案：四角星 + 一颗小星
    create: `
      <path d="M11.4 4.6 13 9.4 17.8 11 13 12.6 11.4 17.4 9.8 12.6 5 11 9.8 9.4Z"/>
      <path d="M18.6 15.6 19.3 17.5 21.2 18.2 19.3 18.9 18.6 20.8 17.9 18.9 16 18.2 17.9 17.5Z" ${SOLID} opacity=".7"/>`,
  };

  /**
   * 允许出现在**标签开头**、应当被徽记取代的"字面字形"。
   *
   * 为什么需要它：`\p{Extended_Pictographic}` 之外还有一批**纯符号字形**也被当图标用
   * （`☰` 列表、`←` 返回、`✕` 关闭）。它们不是 emoji（`test/emoji-preserve.test.js` 的
   * 口径自检就明确"裸 ✓/✗/≥/→ 不算 emoji"），但作为**控件标签的开头**同样是图标位。
   * 这里只列本次实际替换到的几个，不做任何"通用符号清洗"。
   */
  const LEAD_GLYPHS = ['☰', '←', '→', '↑', '↓', '✕', '✗', '✓', '↩', '⏮', '⏹', '⏸'];

  const EXT_PICT = /\p{Extended_Pictographic}/u;
  const KEYCAP = '\u20E3';
  const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

  /** 切成字符簇（ZWJ / 肤色 / FE0F / 键帽都会归进同一簇）；无 Intl.Segmenter 时退化为按码点切 */
  function clusters(text) {
    const s = String(text == null ? '' : text);
    if (!SEGMENTER) return Array.from(s);
    return [...SEGMENTER.segment(s)].map((x) => x.segment);
  }

  /** 该簇是不是"表情字形"（判据与 test/emoji-preserve.test.js 的 countEmoji 完全一致） */
  function isEmojiCluster(c) {
    return EXT_PICT.test(c) || c.indexOf(KEYCAP) >= 0;
  }

  /**
   * 标签去图标：只删**标签开头**的一个（或连续几个）图标字形，其余一个字节都不动。
   *
   *   plainLabel('📖 角色图鉴')   → '角色图鉴'
   *   plainLabel('⚙ 开局设置')   → '开局设置'
   *   plainLabel('☰ 列表')       → '列表'
   *   plainLabel('🐺 狼人阵营获胜！') → '狼人阵营获胜！'   ← 不是错误：调用点只喂 ①②③ 三类位置
   *   plainLabel('好人 🎉 获胜')  → '好人 🎉 获胜'        ← **标签内部**的 emoji 不动（关键性质）
   *   plainLabel('设置')          → '设置'               ← 无图标时原样返回
   *
   * 这是本模块唯一"看起来像清洗 emoji"的地方，所以边界必须写死：
   * **只删开头**、**只在被 `data-ww-icon` 显式点名的元素上调用**、**不导出任何"清理整段文本"的入口**。
   */
  function plainLabel(text) {
    const cs = clusters(text);
    let i = 0;
    while (i < cs.length) {
      const c = cs[i];
      if (isEmojiCluster(c) || LEAD_GLYPHS.indexOf(c) >= 0) { i++; continue; }
      if (/^\s+$/.test(c)) { i++; continue; } // 图标与文字之间的空格
      break;
    }
    let out = cs.slice(i).join('');
    // 若开头连续出现的是"图标 空格 图标 空格"，上面已一并吃掉；再收一次前导空白
    out = out.replace(/^[\s\uFE0F\u200D]+/u, '');
    return out;
  }

  function has(s) { return typeof s === 'string' && s.length > 0; }
  function normalizeId(id) { return has(id) && ICON_IDS.indexOf(id) >= 0 ? id : null; }
  function symbolId(id) { return SYMBOL_PREFIX + id.charAt(0).toUpperCase() + id.slice(1); }

  /** 页面级 defs（39 个 `<symbol>` 只注入一份）。写法与 avatar-badge.js 的 defsMarkup 一致。 */
  function defsMarkup() {
    const symbols = ICON_IDS.map((id) => {
      const body = MARKS[id].trim().replace(/\n\s+/g, '\n      ');
      return `    <symbol id="${symbolId(id)}" viewBox="0 0 24 24"><g ${STROKE}>${body}</g></symbol>`;
    }).join('\n');
    return `<svg id="${DEFS_ID}" width="0" height="0" aria-hidden="true" focusable="false"` +
      ` xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
      ` style="position:absolute;width:0;height:0;overflow:hidden">\n  <defs>\n${symbols}\n  </defs>\n</svg>`;
  }

  /**
   * 一枚徽记的展示标记（`<use>` 引用上面那份定义，不复制路径）。
   *
   * 尺寸走 em：容器给 font-size，徽记随字号缩放（缩字号/紧凑布局也不会缩到 0）。
   * 同时写死 width/height 属性 —— 样式表万一没加载时仍有确定尺寸，不会退化成 SVG 默认的 300×150。
   *
   * `style="vertical-align:-.125em"` 是**唯一**的内联表现属性，理由：图标要跟文字基线对齐，
   * 而本条规则本该落在 `web/style.css` 的 `.ww-icon` 上 —— 该文件属别的批次（A1 桌面触区），
   * 本批不得改。放在模块里一处生成，两端渲染完全一致（见报告"桌面端需要但未改的 CSS"）。
   */
  function iconMarkup(id, opts) {
    const key = normalizeId(id);
    if (!key) return '';
    const o = opts || {};
    const cls = o.cls ? `${ICON_CLASS} ${o.cls}` : ICON_CLASS;
    const size = o.size || '1em';
    const name = has(o.label) ? o.label : ICON_NAME[key];
    const href = `#${symbolId(key)}`;
    return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}"` +
      ` role="img" aria-label="${name}" focusable="false" style="vertical-align:-.125em">` +
      `<use href="${href}" xlink:href="${href}"/></svg>`;
  }

  /** 徽记 + 纯文字标签（JS 侧拼按钮文案用；HTML 侧用 data-ww-icon + mount 同一套结果） */
  function labelMarkup(id, text, opts) {
    const icon = iconMarkup(id, opts);
    const t = plainLabel(text);
    if (!icon) return t;
    return t ? `${icon} ${t}` : icon;
  }

  /** 注入页面级 defs（只注一次）。没有 document 时静默返回 false，便于在 Node 里单测字符串。 */
  function ensureDefs(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.body) return false;
    if (d.getElementById(DEFS_ID)) return true;
    const box = d.createElement('div');
    box.innerHTML = defsMarkup();
    const svg = box.firstElementChild;
    if (!svg) return false;
    d.body.insertBefore(svg, d.body.firstChild);
    return true;
  }

  const MARKER_ATTR = 'data-ww-icon';

  /**
   * 把一个元素画成「徽记 + 去图标标签」。幂等：重复调用结果相同。
   *
   * 幂等的做法：先摘掉上一次插入的 `<svg class="ww-icon">`，剩下的文本就是纯标签 ——
   * 所以**必须在 i18n 重刷之后**再调用一次（`applyI18n` 会整块重写 textContent，
   * 把徽记一起抹掉；这正是 `mount()` 需要被显式重跑的原因，见 app.js / m.js 的接线注释）。
   */
  function mountNode(node) {
    if (!node || !node.getAttribute) return false;
    const id = normalizeId(node.getAttribute(MARKER_ATTR));
    if (!id) return false;
    const d = node.ownerDocument || (typeof document !== 'undefined' ? document : null);
    ensureDefs(d);
    const old = node.querySelector ? node.querySelector(`svg.${ICON_CLASS}`) : null;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const text = plainLabel(node.textContent);
    node.textContent = text;
    if (typeof node.insertAdjacentHTML === 'function') node.insertAdjacentHTML('afterbegin', iconMarkup(id));
    return true;
  }

  /** 遍历容器里所有 `[data-ww-icon]`（含容器自身）。返回画好的个数。 */
  function mount(root, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const scope = root || d;
    if (!scope) return 0;
    ensureDefs(d);
    const nodes = [];
    if (scope.getAttribute && scope.getAttribute(MARKER_ATTR)) nodes.push(scope);
    if (scope.querySelectorAll) for (const n of scope.querySelectorAll(`[${MARKER_ATTR}]`)) nodes.push(n);
    let n = 0;
    for (const node of nodes) if (mountNode(node)) n++;
    return n;
  }

  const api = {
    ICON_IDS, ICON_NAME, DEFS_ID, SYMBOL_PREFIX, ICON_CLASS, STROKE, SOLID, MARKS,
    LEAD_GLYPHS, MARKER_ATTR,
    clusters, isEmojiCluster, plainLabel,
    normalizeId, symbolId, defsMarkup, iconMarkup, labelMarkup, ensureDefs, mountNode, mount,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWIcons = api;
})(typeof window !== 'undefined' ? window : globalThis);
