/**
 * avatar-badge.js — 八个**内置头像**的唯一真值（M1 §4.1 第 1 条）
 *
 * 为什么要有这个文件：改造前桌面 `web/app.js:921` 与手机 `web/m/m.js:1118` 各有一份
 * **逐字相同**的 `AVATAR_EMOJI = { scholar:'🎓', hunter:'🏹', … }`。那正是计划书 §3 第 80/81 行
 * 要收敛的重复绑定；而且 §4.1 第 1 条原文要求内置头像用「统一风格的 SVG 徽记」，
 * emoji 字形做不到统一风格（各家字体一套配色、深浅底对比度不可控）。
 *
 * 因此这里收敛成**一份**：八个内置 id、它们的可读名字、八个 `<symbol>` 徽记的定义，
 * 以及"该显示什么"的判据（displaySource）。两端的引用点只做接线。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 *  ① **不要全局删除 emoji**（计划书 §3 第 78 行）。这里删掉的只是**头像字形**这一处；
 *     聊天内容、玩家姓名、角色/板子/图鉴文本里的 emoji 一律保留，本模块也不提供任何
 *     "清洗 emoji"的入口。原先的 `'👤'` 兜底字形同样属于头像字形，一并由徽记取代。
 *  ② **一份定义、`<use>` 引用**（与 `web/card-frame.js` 的 `frCrest*` 同一套做法）：
 *     八个 `<symbol>` 只在页面里注入一次，八个使用点各写一行 `<use>`，绝不十份内联重复。
 *  ③ **深浅底都清晰**：徽记只用 `currentColor`，颜色来自所在容器（正文骨白 / 古金都行）。
 *     它不写死任何十六进制色值 —— 那既是 `test/css.test.js` 六色白名单的要求，
 *     也让"深底清晰"与"浅底清晰"由同一份实现满足（跟随容器文字色，天然对比）。
 *
 * 零运行时依赖、无外部请求、可随尺寸缩放（viewBox + em 尺寸）。
 */
'use strict';
(function (global) {
  /** 八个内置 id：顺序即编辑页的展示顺序（与改造前 `Object.entries(AVATAR_EMOJI)` 一致） */
  const AVATAR_IDS = ['scholar', 'hunter', 'seer', 'wolf', 'witch', 'night', 'candle', 'mask'];

  /**
   * 服务端 `cleanAvatar()`（src/profiles/store.js:58）对未知值回落 `'scholar'`。
   * 这里用同一套回落，保证"档案里存着一个陌生 id"时两端显示的仍是同一个徽记。
   */
  const DEFAULT_AVATAR_ID = 'scholar';

  /** 可读名字：只在 **SVG 放不进去**的地方使用（`<option>` / 纯文本标签），也是徽记的无障碍名 */
  const AVATAR_NAME = {
    scholar: '学者', hunter: '猎人', seer: '先知', wolf: '狼',
    witch: '女巫', night: '夜', candle: '烛', mask: '面具',
  };

  const DEFS_ID = 'ww-avatar-defs';
  const SYMBOL_PREFIX = 'wwAv';
  const BADGE_CLASS = 'ww-avatar-badge';
  const IMG_CLASS = 'ww-avatar-img';

  /**
   * 统一的笔触属性：八个徽记共用同一套线宽/端点/连接，这才叫"统一风格"。
   * 写在 `<g>` 上一次，而不是每个 `<path>` 各写一遍（同风格不该靠八份复制维持）。
   */
  const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  /** 内部小面积实心（眼睛/气泡/星火）：与线稿同一色，靠形状而不是靠第二个颜色区分 */
  const SOLID = 'fill="currentColor" stroke="none"';

  /**
   * 八个徽记的线稿。共同约束（"统一风格"的可核对判据）：
   *   · 24×24 画布、内容收在 2px 安全边距内（圆形裁切与方形显示都不会蹭边）；
   *   · 只用直线/圆弧/圆，线宽统一 1.6、圆头圆角；
   *   · 语义与原来那八个 emoji 一一对应（学者=书、猎人=弓箭、先知=水晶球、狼=狼首、
   *     女巫=药瓶、夜=弯月、烛=蜡烛、面具=剧面具），所以视觉习惯不变；
   *   · 次要结构用 opacity 降权，而不是换颜色。
   */
  const MARKS = {
    // 学者：摊开的书（书脊 + 两页 + 两侧文字短线）
    scholar: `
      <path d="M12 7.4C9.2 5.6 6.6 5.5 3.8 7v10.4c2.8-1.5 5.4-1.4 8.2.4 2.8-1.8 5.4-1.9 8.2-.4V7c-2.8-1.5-5.4-1.4-8.2.4Z"/>
      <path d="M12 7.4v10.4"/>
      <path d="M6.5 9.6c1.2 0 2.3.3 3.2.8M6.5 12.3c1.2 0 2.3.3 3.2.8" opacity=".5"/>
      <path d="M17.5 9.6c-1.2 0-2.3.3-3.2.8M17.5 12.3c-1.2 0-2.3.3-3.2.8" opacity=".5"/>`,
    // 猎人：弓（弓臂 + 弦）与一支穿过它的箭（箭头/尾羽各两笔）
    hunter: `
      <path d="M4.6 4.6A13 13 0 0 1 19.4 19.4"/>
      <path d="M4.6 4.6 19.4 19.4" opacity=".5"/>
      <path d="M3 21 21 3"/>
      <path d="M21 3 14.9 4.6M21 3 19.4 9.1"/>
      <path d="M3 21 4.6 14.9M3 21 9.1 19.4"/>`,
    // 先知：水晶球 + 底座（球体左下补一道高光）
    seer: `
      <circle cx="12" cy="9.6" r="5.9"/>
      <path d="M9.4 6.8a3.9 3.9 0 0 0-1.1 2.9" opacity=".5"/>
      <path d="M8.6 20.9c0-3 1.5-5.4 3.4-5.4s3.4 2.4 3.4 5.4"/>
      <path d="M6.2 20.9h11.6"/>`,
    // 狼：尖耳狼首（轮廓含双耳与收窄的吻部）+ 斜眼 + 鼻吻
    wolf: `
      <path d="M6.2 5.4 9.6 8.3h4.8l3.4-2.9 1 8.5-7 7.1-7-7.1Z"/>
      <path d="M9.4 12.3l2.2-.9M14.6 12.3l-2.2-.9" opacity=".85"/>
      <path d="M12 14.8v2.3M10.3 17.8 12 19.5l1.7-1.7" opacity=".7"/>`,
    // 女巫：药瓶（软木塞 + 瓶颈 + 圆底）+ 液面 + 两颗气泡
    witch: `
      <path d="M9.4 3.6h5.2"/>
      <path d="M10.2 3.6v4.1l-3.6 6a5.4 5.4 0 0 0 10.8 0l-3.6-6V3.6Z"/>
      <path d="M7.7 13.4h8.6" opacity=".5"/>
      <circle cx="10.5" cy="16.9" r="1.05" ${SOLID} opacity=".9"/>
      <circle cx="14.1" cy="18.3" r=".75" ${SOLID} opacity=".7"/>`,
    // 夜：弯月（内外两条弧）+ 一颗四角星
    night: `
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
      <path d="M6.4 5.2 7.1 6.9 8.8 7.6 7.1 8.3 6.4 10 5.7 8.3 4 7.6 5.7 6.9Z" ${SOLID} opacity=".85"/>`,
    // 烛：火焰 + 烛芯 + 烛身 + 底座
    candle: `
      <path d="M12 4.2c2.1 2.2 3.4 4 3.4 5.7a3.4 3.4 0 0 1-6.8 0c0-1.7 1.3-3.5 3.4-5.7Z"/>
      <path d="M12 13.6v1.2" opacity=".7"/>
      <path d="M9.3 14.8h5.4v6.4H9.3Z"/>
      <path d="M7.4 21.2h9.2"/>`,
    // 面具：剧面具（上沿 + 圆底）+ 眉带 + 两个眼孔 + 笑口
    mask: `
      <path d="M4.6 5.8h14.8v7.4a7.4 7.4 0 0 1-14.8 0Z"/>
      <path d="M4.6 5.8c2.4 1.1 4.8 1.6 7.4 1.6s5-.5 7.4-1.6" opacity=".5"/>
      <circle cx="9" cy="11.6" r="1.35" ${SOLID}/>
      <circle cx="15" cy="11.6" r="1.35" ${SOLID}/>
      <path d="M9.4 16.6c1.5 1.2 3.7 1.2 5.2 0" opacity=".85"/>`,
  };

  /** id → 符号名（`wwAv` + 首字母大写）；查不到的一律回落默认 id */
  function symbolId(id) {
    return SYMBOL_PREFIX + id.charAt(0).toUpperCase() + id.slice(1);
  }

  /** 未知/缺失/非字符串的 avatarId 一律回落 `scholar`（与服务端 cleanAvatar 同一套回落） */
  function normalizeId(id) {
    return typeof id === 'string' && AVATAR_IDS.includes(id) ? id : DEFAULT_AVATAR_ID;
  }

  function nameOf(id) {
    return AVATAR_NAME[normalizeId(id)];
  }

  /**
   * 页面级 defs（八个 `<symbol>` 只注入一份）。
   * `width/height = 0` + `overflow:hidden` + `position:absolute`：不占布局、不进无障碍树。
   * 与 `web/card-frame.js` 的 `DEFS` 同一套写法。
   */
  function defsMarkup() {
    const symbols = AVATAR_IDS.map((id) => {
      const body = MARKS[id].trim();
      return `    <symbol id="${symbolId(id)}" viewBox="0 0 24 24"><g ${STROKE}>${body}</g></symbol>`;
    }).join('\n');
    return `<svg id="${DEFS_ID}" width="0" height="0" aria-hidden="true" focusable="false"` +
      ` xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
      ` style="position:absolute;width:0;height:0;overflow:hidden">\n  <defs>\n${symbols}\n  </defs>\n</svg>`;
  }

  /**
   * 一个徽记的展示标记（`<use>` 引用上面那份定义，不复制路径）。
   * 尺寸走 em：容器给 font-size（桌面 `.home-avatar` 34px、手机 `.m-profile-chip` 18px），
   * 徽记随字号缩放，缩字号/紧凑布局也不会缩到 0（触区与字号偏好都动不了它）。
   * 同时也写死 width/height 属性 —— 样式表万一没加载时仍有确定尺寸，不会退化成 SVG 默认的 300×150。
   */
  function badgeMarkup(id, opts) {
    const o = opts || {};
    const key = normalizeId(id);
    const cls = o.cls || BADGE_CLASS;
    const size = o.size || '1.2em';
    const href = `#${symbolId(key)}`;
    return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}"` +
      ` role="img" aria-label="${AVATAR_NAME[key]}" focusable="false">` +
      `<use href="${href}" xlink:href="${href}"/></svg>`;
  }

  /** 纯文本标签（SVG 放不进去的地方，例如 `<option>`）：用可读名字保住"哪个头像"这条信息 */
  function textLabel(id) {
    return AVATAR_NAME[normalizeId(id)];
  }

  /**
   * "当前该显示什么"的唯一判据（§4.1 第 4/6 条）：
   *   有 `avatarUrl` → 自定义头像图（服务端给的 URL，自带 `?v=<sha256>` 做缓存失效）；
   *   否则 → **按档案的 `avatarId` 显示内置徽记**。
   *
   * 关键在"否则"这一支：删除自定义头像（`DELETE …/avatar`）返回 `{ profile, avatarUrl: null }`，
   * 服务端**不会动** `avatarId`（src/api.js:1934 的原文「档案的 avatarId 一个字节都不动」）。
   * 所以前端也绝不能在这一步把 avatarId 丢掉或回落成空 —— 那才会变成破图/空位。
   * 返回结构永远是两者之一，**没有第三种"什么都不显示"**。
   */
  function displaySource(profile) {
    const p = profile || {};
    if (p.avatarUrl) return { kind: 'custom', src: p.avatarUrl };
    return { kind: 'builtin', badgeId: normalizeId(p.avatarId) };
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

  /**
   * 把"当前档案该显示的东西"画进一个展示位（两端唯一的渲染原语）。
   *
   * 失败路径按 §4.1 第 7 条处理：图**加载失败**时回落到内置徽记，绝不留一个破图/空位。
   * 注意这不是"先清空再上传"——上传是另一个函数的事；这里只在拿到结果之后渲染。
   *
   * @returns {'custom'|'builtin'|'none'} 实际渲染的种类（'none' 只在拿不到节点时出现）
   */
  function renderInto(node, profile, opts) {
    if (!node) return 'none';
    const d = node.ownerDocument || (typeof document !== 'undefined' ? document : null);
    ensureDefs(d);
    const src = displaySource(profile);
    // 回落的徽记**先算好**：监听器里不再读 profile，避免"加载失败时 profile 已被换成别的档案"这类竞态。
    const fallback = badgeMarkup(normalizeId(profile && profile.avatarId), opts);
    node.textContent = '';
    if (src.kind === 'custom') {
      const img = (d || document).createElement('img');
      img.className = IMG_CLASS;
      img.setAttribute('alt', '');
      img.setAttribute('decoding', 'async');
      // 加载失败（文件被外部删掉 / 哈希过期 404 / 解码失败）→ 回落内置徽记，绝不破图。
      // 用一次性监听：回落后不再有 img，因此不可能循环。
      // `node.contains(img)` 这一句是必须的：展示位会被后续渲染重用（切档/保存后再画一次），
      // 上一张图的 error 可能**迟到**到现在才到；不检查的话它会把新头像覆盖成旧档案的徽记。
      img.addEventListener('error', () => {
        if (typeof node.contains === 'function' && !node.contains(img)) return;
        node.textContent = '';
        node.insertAdjacentHTML('afterbegin', fallback);
      }, { once: true });
      img.src = src.src;
      node.appendChild(img);
      return 'custom';
    }
    node.insertAdjacentHTML('afterbegin', badgeMarkup(src.badgeId, opts));
    return 'builtin';
  }

  const api = {
    AVATAR_IDS, AVATAR_NAME, DEFAULT_AVATAR_ID, DEFS_ID, SYMBOL_PREFIX, BADGE_CLASS, IMG_CLASS,
    STROKE, SOLID, MARKS,
    normalizeId, nameOf, symbolId, defsMarkup, badgeMarkup, textLabel, displaySource, ensureDefs, renderInto,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWAvatarBadge = api;
})(typeof window !== 'undefined' ? window : globalThis);
