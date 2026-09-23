/**
 * card-frame.js — 角色卡金属框（手绘 SVG，单一来源）
 * ============================================================================
 * 设计目标：借鉴实体卡牌游戏（炉石/符文大地/昆特）的框体语言 ——
 *   ① **有解剖结构**：顶部徽记栏、中间画窗、底部铭牌，而不是"一圈金边"；
 *   ② **材质光照**：外缘暗口 → 受光亮倒角 → 青铜斜面 → 刻槽 → 细导轨 → 内凹；
 *      四条边各有一份横截面渐变，左上受光、右下压暗；
 *   ③ **嵌入式画窗**：画窗四周有暗凹槽 + 亮唇线 + 顶部内阴影，插画像"嵌进去"；
 *   ④ **可上色**：阵营/角色色通过 CSS 自定义属性注入（见 --fr-*），
 *      狼=血色、神=金碧、民=青铜、中立=紫 —— 对局里一眼能分辨阵营；
 *   ⑤ **两档细节**：见下面"两档"一节。
 *
 * 坐标系与"框带必须和 CSS 对齐"这个坑：
 *   viewBox = 0 0 100 150（2:3），1 单位 = 卡片宽度的 1%。
 *   框带不是等宽的（顶部要放徽记、底部要放铭牌），因此 CSS 的 padding 也必须不对称：
 *     左右 BX  = 7  单位 = CSS `padding-left/right: 7%`
 *     顶   BYT = 11 单位 = CSS `padding-top: 11%`      （百分比 padding 一律按**宽度**解析）
 *     底   BYB = 10 单位 = CSS `padding-bottom: 10%`
 *   纵向的"框带百分比"（给绝对定位的角色名用）另算：--band-y = 10/150 = 6.667%。
 *   改任何一个数字都必须同步 CSS，否则画窗与框带会错开 —— 而且**不会报错**，只是看起来歪，
 *   所以这几个常量都导出给测试（test/card-frame.test.js）。
 *
 * 两档细节（同一个 SVG 里画两套，靠容器查询切换）：
 *   卡宽 <  150px：侧栏身份卡只有 52px 宽，1 单位 ≈ 0.5px，线脚/卷草/铆钉全是亚像素，
 *                  渲染出来只会糊成一团。此时显示"粗档"：暗口 + 阵营色框面 + 亮唇线，
 *                  三条边界的对比度撑住小尺寸的识别度。
 *   卡宽 >= 150px：显示"细档"（完整的线脚剖面与全部装饰），它盖在粗档之上。
 *   默认（容器查询不支持的老 WebView）两档都画 → 看到的是细档，属"多画了细节"，不会坏。
 */
'use strict';
(function (root) {
  const DEFS_ID = 'ww-card-frame-defs';

  // ---------------------------------------------------------------- 几何常量
  const VIEW = { w: 100, h: 150 };  // viewBox：1 单位 = 卡宽 1%
  const BX = 7;                     // 左右框带 = CSS padding-left/right 7%
  const BYT = 11;                   // 顶部徽记栏 = CSS padding-top 11%
  const BYB = 10;                   // 底部铭牌栏 = CSS padding-bottom 10%
  const CH = 1.6;                   // 外轮廓切角（倒角），让卡看起来是"切"出来的
  const WINDOW_RX = 2;              // 画窗圆角 = CSS border-radius 2% / 1.333%

  const R = (n) => Number(n.toFixed(2));

  /** 外轮廓：切角八边形 */
  const OUTER = `M${CH} 0 H${VIEW.w - CH} L${VIEW.w} ${CH} V${VIEW.h - CH} L${VIEW.w - CH} ${VIEW.h} H${CH} L0 ${VIEW.h - CH} V${CH} Z`;
  /** 画窗轮廓 */
  const INNER = `M${BX} ${BYT} H${VIEW.w - BX} V${VIEW.h - BYB} H${BX} Z`;
  /** 框带（外轮廓 − 画窗），用 evenodd 一次填满；粗档底色、阵营染色、抛光都复用它 */
  const RING = `${OUTER} ${INNER}`;

  /** 四条边 + 四个角的斜接块：正好把框带铺满，角块与相邻边共用一条缝（真画框也是这么拼的） */
  const QUAD = {
    top: `M${CH} 0 H${VIEW.w - CH} L${VIEW.w - BX} ${BYT} H${BX} Z`,
    right: `M${VIEW.w} ${CH} V${VIEW.h - CH} L${VIEW.w - BX} ${VIEW.h - BYB} V${BYT} Z`,
    bottom: `M${VIEW.w - CH} ${VIEW.h} H${CH} L${BX} ${VIEW.h - BYB} H${VIEW.w - BX} Z`,
    left: `M0 ${VIEW.h - CH} V${CH} L${BX} ${BYT} V${VIEW.h - BYB} Z`,
    tl: `M0 ${CH} L${CH} 0 L${BX} ${BYT} Z`,
    tr: `M${VIEW.w - CH} 0 L${VIEW.w} ${CH} L${VIEW.w - BX} ${BYT} Z`,
    br: `M${VIEW.w} ${VIEW.h - CH} L${VIEW.w - CH} ${VIEW.h} L${VIEW.w - BX} ${VIEW.h - BYB} Z`,
    bl: `M${CH} ${VIEW.h} L0 ${VIEW.h - CH} L${BX} ${VIEW.h - BYB} Z`,
  };

  /** 金属剖面（沿框带横截面，从外到内）。大面积是**暗青铜**，只有倒角与细导轨是窄窄的亮奶金：
   *  高饱和亮黄铺满整条带子会显得廉价（这就是第一版的问题）。 */
  const PROFILE = `
      <stop offset="0" stop-color="#05030a"/>
      <stop offset=".05" stop-color="#160f05"/>
      <stop offset=".11" stop-color="#5c4512"/>
      <stop offset=".17" stop-color="#f2e2a8"/>
      <stop offset=".22" stop-color="#a8862a"/>
      <stop offset=".31" stop-color="#5c4512"/>
      <stop offset=".40" stop-color="#1e1405"/>
      <stop offset=".46" stop-color="#0c0803"/>
      <stop offset=".52" stop-color="#4c3a10"/>
      <stop offset=".58" stop-color="#a8905a"/>
      <stop offset=".64" stop-color="#4a3810"/>
      <stop offset=".73" stop-color="#1c1405"/>
      <stop offset=".81" stop-color="#0a0703"/>
      <stop offset=".88" stop-color="#33240c"/>
      <stop offset=".94" stop-color="#160f05"/>
      <stop offset="1" stop-color="#05030a"/>`;

  /** 粗档剖面：小尺寸专用。7 单位的框带在 52px 卡上只有 3.6px ——
   *  靠**同一套斜接梯形 + 更少的段数、更大的明暗差**做出"薄但有倒角"的金属，
   *  而不是一条纯色描边（纯色描边看起来像霓虹灯，廉价）。 */
  const PROFILE_BOLD = `
      <stop offset="0" stop-color="#04020a"/>
      <stop offset=".16" stop-color="#1c1408"/>
      <stop offset=".3" stop-color="#6b4f16"/>
      <stop offset=".42" stop-color="#e8d69c"/>
      <stop offset=".54" stop-color="#8a6a1e"/>
      <stop offset=".7" stop-color="#33240c"/>
      <stop offset=".86" stop-color="#120c04"/>
      <stop offset="1" stop-color="#05030a"/>`;

  /** 狼爪的几何（掌垫 + 四个趾）。要在 14px 的徽记里也读得出来，
   *  所以选"爪印"而不是狼头侧影：爪印是极简图形，缩到多小都认得出。
   *  趾要**窄而外张**：早先用圆椭圆，缩下去就糊成一朵云 ☁，读不出是爪。 */
  const PAW = `
        <path d="M0 3.5 C-2.1 3.5 -3.05 2.05 -2.68 .7 C-2.34 -.6 -1.22 -1.28 0 -1.28 C1.22 -1.28 2.34 -.6 2.68 .7 C3.05 2.05 2.1 3.5 0 3.5 Z"/>
        <ellipse cx="-2.72" cy="-1.85" rx=".88" ry="1.52" transform="rotate(-28 -2.72 -1.85)"/>
        <ellipse cx="-0.98" cy="-2.95" rx=".86" ry="1.62" transform="rotate(-10 -0.98 -2.95)"/>
        <ellipse cx="1.02" cy="-2.92" rx=".86" ry="1.62" transform="rotate(11 1.02 -2.92)"/>
        <ellipse cx="2.78" cy="-1.75" rx=".88" ry="1.52" transform="rotate(30 2.78 -1.75)"/>`;

  /** 徽记底盘：六边凹座（三个阵营共用）。大了才读得出是"徽记"而不是一颗扣子。 */
  const PLATE = `
        <path d="M-8 0 L-5.2 -4.35 H5.2 L8 0 L5.2 4.35 H-5.2 Z" fill="url(#frPlate)" stroke="#080502" stroke-width=".55"/>
        <path d="M-8 0 L-5.2 -4.35 H5.2 L8 0" fill="none" stroke="#cbb573" stroke-width=".34" opacity=".45"/>
        <path d="M-5.2 4.35 H5.2 L8 0" fill="none" stroke="#000" stroke-width=".3" opacity=".5"/>
        <path d="M-6.8 0 L-4.5 -3.55 H4.5 L6.8 0 L4.5 3.55 H-4.5 Z" fill="none" stroke="#f2e2a8" stroke-width=".16" opacity=".2"/>`;

  /** 神阵营徽记的图形：四芒星（神力 / 启示）。凹角用曲线，缩下去才不像"十字"。 */
  const STAR = `
        <path d="M0 -4.35 C.5 -1.5 1.5 -.5 4.35 0 C1.5 .5 .5 1.5 0 4.35 C-.5 1.5 -1.5 .5 -4.35 0 C-1.5 -.5 -.5 -1.5 0 -4.35 Z"/>`;

  /** 民阵营徽记的图形：麦苗（平民 / 收成）。
   *  ⚠ 走过一次弯路：一开始画的是"麦穗"（三对谷粒 + 顶粒），但谷粒之间只差 0.2 单位，
   *  在 16 单位的徽记里直接被"深色描边 + 阵营色填充"两遍画法糊成一个色块（像个叶子）。
   *  改成茎 + 四片分开的叶：每片都是独立轮廓，缩到 20px 也读得出是"苗"。
   *  全部用填充不用描边 —— 两遍画法只对填充路径成立。 */
  const WHEAT = `
        <path d="M-.32 4.25 C-.56 2.2 -.56 .3 -.36 -1.5 C-.12 -1.5 .12 -1.5 .34 -1.45 C.28 .4 .32 2.2 .34 4.25 Z"/>
        <path d="M-.3 -.95 C-1.5 -1.05 -2.7 -1.85 -3.5 -2.95 C-2.05 -3.0 -.85 -2.25 -.18 -1.15 Z"/>
        <path d="M.3 -.95 C1.5 -1.05 2.7 -1.85 3.5 -2.95 C2.05 -3.0 .85 -2.25 .18 -1.15 Z"/>
        <path d="M-.2 -1.2 C-1.15 -2.05 -1.6 -3.15 -1.45 -4.35 C-.4 -3.7 .35 -2.55 .2 -1.2 Z"/>
        <path d="M.2 -1.2 C1.15 -2.05 1.6 -3.15 1.45 -4.35 C.4 -3.7 -.35 -2.55 -.2 -1.2 Z"/>`;

  /** 第三方阵营徽记的图形：心（命运红线 / 爱慕）。心是最不会认错的符号，
   *  16 单位的徽记里缩到 14px 也能一眼读出来；红线不画，免得糊成一团。 */
  const HEART = `
        <path d="M0 4.15 C-2.6 1.95 -4.05 .45 -4.05 -1.25 C-4.05 -2.75 -2.95 -3.75 -1.65 -3.75 C-.9 -3.75 -.32 -3.3 0 -2.55 C.32 -3.3 .9 -3.75 1.65 -3.75 C2.95 -3.75 4.05 -2.75 4.05 -1.25 C4.05 .45 2.6 1.95 0 4.15 Z"/>`;

  /** 角色 → 阵营（外观用）。徽记与配色按阵营换（狼爪 / 神星 / 民麦 / 心），
   *  所以框层必须知道阵营。这份表与 src/engine/roles.js 的一致性由
   *  test/card-frame.test.js 逐条钉住：默认必须等于引擎的 category，
   *  只有 THIRD_PARTY 里的角色例外（否则就是"预言家卡上印狼爪"这种默默错下去的事）。 */
  const FACTION = {
    wolf: 'wolf', wolfking: 'wolf', whitewolfking: 'wolf', wolfbeauty: 'wolf', hiddenwolf: 'wolf',
    seer: 'god', witch: 'god', hunter: 'god', guard: 'god',
    idiot: 'god', knight: 'god', dreamer: 'god', crow: 'god',
    villager: 'villager',
    admirer: 'third',
  };

  /**
   * 第三方（独立于狼/神/民的第四种外观阵营，紫色 + 心形徽记）。
   *
   * ⚠ 这是**纯外观**概念，不动引擎：roles.js 里 category 仍然只有 wolf/god/villager
   *   （category 决定屠边判定），这里只决定牌框染成什么颜色、徽记画什么。
   *
   * 目前唯一进这个名单的是暗恋者：引擎里她 category='villager'，但胜负跟着暗恋对象走
   * （规则书原话"绑定到狼人随狼人获胜，绑到神职就算神职"），不属于任何固定阵营 ——
   * 正是"第三方"的那种角色。将来加丘比特 / 情侣这类真正独立胜利条件的角色，
   * 也只需把 id 加进这个数组，配色与徽记会自动跟上。
   */
  const THIRD_PARTY = ['admirer'];

  /** 页面级 defs：四个方向的剖面渐变 + 角块渐变 + 抛光 + 徽记/宝石/卷草（页面只注入一份） */
  const DEFS = `
<svg id="${DEFS_ID}" width="0" height="0" aria-hidden="true" focusable="false"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <linearGradient id="frBandTop" x1="0" y1="0" x2="0" y2="1">${PROFILE}</linearGradient>
    <linearGradient id="frBandBottom" x1="0" y1="1" x2="0" y2="0">${PROFILE}</linearGradient>
    <linearGradient id="frBandLeft" x1="0" y1="0" x2="1" y2="0">${PROFILE}</linearGradient>
    <linearGradient id="frBandRight" x1="1" y1="0" x2="0" y2="0">${PROFILE}</linearGradient>
    <!-- 粗档（小尺寸）专用剖面 -->
    <linearGradient id="frBoldTop" x1="0" y1="0" x2="0" y2="1">${PROFILE_BOLD}</linearGradient>
    <linearGradient id="frBoldBottom" x1="0" y1="1" x2="0" y2="0">${PROFILE_BOLD}</linearGradient>
    <linearGradient id="frBoldLeft" x1="0" y1="0" x2="1" y2="0">${PROFILE_BOLD}</linearGradient>
    <linearGradient id="frBoldRight" x1="1" y1="0" x2="0" y2="0">${PROFILE_BOLD}</linearGradient>
    <!-- 角块：受光最弱的一块，压暗后与两条边形成可见的斜接缝 -->
    <linearGradient id="frBandCornerT" x1="0" y1="0" x2=".6" y2="1">
      <stop offset="0" stop-color="#120c04"/><stop offset=".3" stop-color="#4a3612"/>
      <stop offset=".62" stop-color="#1c1406"/><stop offset="1" stop-color="#070502"/>
    </linearGradient>
    <linearGradient id="frBandCornerB" x1="0" y1="1" x2=".6" y2="0">
      <stop offset="0" stop-color="#120c04"/><stop offset=".3" stop-color="#3e2d0e"/>
      <stop offset=".62" stop-color="#1c1406"/><stop offset="1" stop-color="#070502"/>
    </linearGradient>
    <linearGradient id="frBoldCornerT" x1="0" y1="0" x2=".6" y2="1">
      <stop offset="0" stop-color="#0d0903"/><stop offset=".34" stop-color="#7a5c18"/>
      <stop offset=".6" stop-color="#241a06"/><stop offset="1" stop-color="#06040a"/>
    </linearGradient>
    <linearGradient id="frBoldCornerB" x1="0" y1="1" x2=".6" y2="0">
      <stop offset="0" stop-color="#0d0903"/><stop offset=".34" stop-color="#5c4512"/>
      <stop offset=".6" stop-color="#241a06"/><stop offset="1" stop-color="#06040a"/>
    </linearGradient>

    <!-- 小尺寸粗档：整体是一块"压暗的阵营色金属"，靠外暗口与内亮唇线撑对比度 -->
    <linearGradient id="frBold" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#4a3a18"/>
      <stop offset=".18" stop-color="#241a0a"/>
      <stop offset=".5" stop-color="#120c06"/>
      <stop offset=".82" stop-color="#1e1508"/>
      <stop offset="1" stop-color="#0a0704"/>
    </linearGradient>

    <!-- 斜向抛光：左上受光、右下压暗，金属才有"面" -->
    <linearGradient id="frSheen" x1="0" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#fff8dc" stop-opacity=".18"/>
      <stop offset=".3" stop-color="#fff8dc" stop-opacity=".04"/>
      <stop offset=".58" stop-color="#000000" stop-opacity=".14"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".34"/>
    </linearGradient>

    <!-- 画窗顶部内阴影：插画"陷进去"的关键一道（比四周平均加深更真实） -->
    <linearGradient id="frTopShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity=".5"/>
      <stop offset=".45" stop-color="#000" stop-opacity=".16"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <!-- 画窗四周的暗角 -->
    <radialGradient id="frVig" cx=".5" cy=".46" r=".78">
      <stop offset=".58" stop-color="#000" stop-opacity="0"/>
      <stop offset=".84" stop-color="#000" stop-opacity=".14"/>
      <stop offset="1" stop-color="#000" stop-opacity=".4"/>
    </radialGradient>

    <!-- 金属托座（徽记底、铆钉共用） -->
    <radialGradient id="frBoss" cx=".33" cy=".26" r=".85">
      <stop offset="0" stop-color="#fffdf4"/>
      <stop offset=".2" stop-color="#f2e2a6"/>
      <stop offset=".46" stop-color="#c9a227"/>
      <stop offset=".72" stop-color="#8a6d1d"/>
      <stop offset=".92" stop-color="#4a380c"/>
      <stop offset="1" stop-color="#2e2306"/>
    </radialGradient>
    <!-- 徽记底盘：中心稍亮的凹面 -->
    <radialGradient id="frPlate" cx=".5" cy=".38" r=".72">
      <stop offset="0" stop-color="#3a2c10"/>
      <stop offset=".6" stop-color="#1d1508"/>
      <stop offset="1" stop-color="#0a0703"/>
    </radialGradient>

    <!-- 蚀刻纹（细档的框面）：45° 细密排线，模拟金属拉丝/滚花。
         只在细档出现，且很淡 —— 太明显就从"拉丝金属"变成了"木纹" -->
    <pattern id="frHatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="3" height="3" fill="none"/>
      <path d="M0 0 V3" stroke="#f6e8b8" stroke-width=".22" opacity=".1"/>
      <path d="M1.5 0 V3" stroke="#000" stroke-width=".3" opacity=".15"/>
    </pattern>

    <!-- ============ 徽记底盘（三个阵营共用：六边凹座） ============ -->
    <!-- ============ 狼阵营徽记：月牙 + 狼爪；也是无阵营时（牌背）的品牌记号 ============ -->
    <g id="frCrest">
      ${PLATE}
      <!-- 月牙（银白）：比爪印大一圈，从两侧与上方露出来 -->
      <path d="M0.7 -4.15 A4.15 4.15 0 1 0 0.7 4.15 A3.25 3.25 0 1 1 0.7 -4.15 Z"
            fill="#e6ecf7" opacity=".5"/>
      <path d="M0.7 -4.15 A4.15 4.15 0 0 0 0.7 4.15" fill="none" stroke="#fff" stroke-width=".26" opacity=".5"/>
      <path d="M0.7 -4.15 A3.25 3.25 0 0 0 0.7 4.15" fill="none" stroke="#7c8798" stroke-width=".2" opacity=".4"/>
      <!-- 狼爪：先用"深色 + 粗描边"整组描一遍当轮廓（组内互相覆盖，所以看不出接缝），
           再用阵营色填一遍盖住内部描边 -->
      <g fill="#140d03" stroke="#140d03" stroke-width=".72">${PAW}
      </g>
      <g fill="var(--fr-accent, #e8c45c)">${PAW}
      </g>
      <!-- 掌垫左上高光 + 掌垫下缘暗部（一明一暗才有浮雕感，否则是贴上去的剪影）+ 爪尖小高光 -->
      <path d="M-1.75 1.55 C-1.5 .35 -.75 -.25 0 -.35 C-.55 .2 -1.1 1.1 -1.75 1.55 Z" fill="#fff8dc" opacity=".34"/>
      <path d="M1.95 2.55 C2.6 1.5 2.7 .6 2.45 -.15 C2.35 1.05 2.2 1.95 1.95 2.55 Z" fill="#0d0802" opacity=".45"/>
      <ellipse cx="-0.95" cy="-3.25" rx=".38" ry=".5" fill="#fff8dc" opacity=".3"/>
      <ellipse cx="1.0" cy="-3.22" rx=".38" ry=".5" fill="#fff8dc" opacity=".3"/>
    </g>

    <!-- ============ 神阵营徽记：四芒星（神力 / 启示） ============ -->
    <g id="frCrestGod">
      ${PLATE}
      <g fill="#140d03" stroke="#140d03" stroke-width=".7">${STAR}
      </g>
      <g fill="var(--fr-accent, #e8c45c)">${STAR}
      </g>
      <path d="M-1.05 -1.5 C-.4 -.7 -.2 -.4 0 0 C-.5 -.35 -1.0 -.85 -1.05 -1.5 Z" fill="#fff8dc" opacity=".38"/>
      <circle cx="0" cy="0" r=".6" fill="#fff8dc" opacity=".5"/>
      <!-- 两角小火花：让"神"的徽记比狼爪更亮、更"在放光" -->
      <path d="M3.3 -2.95 L3.62 -3.5 L3.94 -2.95 L3.62 -2.4 Z" fill="var(--fr-accent, #e8c45c)" opacity=".75"/>
      <path d="M-3.94 -2.95 L-3.62 -3.5 L-3.3 -2.95 L-3.62 -2.4 Z" fill="var(--fr-accent, #e8c45c)" opacity=".75"/>
    </g>

    <!-- ============ 民阵营徽记：麦苗（平民 / 收成） ============ -->
    <g id="frCrestVil">
      ${PLATE}
      <g fill="#140d03" stroke="#140d03" stroke-width=".62">${WHEAT}
      </g>
      <g fill="var(--fr-accent, #cfe0a0)">${WHEAT}
      </g>
      <path d="M-.5 3.3 C-.7 2 -.7 .5 -.45 -1 C-.3 .5 -.26 2 -.16 3.3 Z" fill="#fff8dc" opacity=".24"/>
      <ellipse cx="0" cy="-3.0" rx=".28" ry=".6" fill="#fff8dc" opacity=".3"/>
    </g>

    <!-- ============ 第三方阵营徽记：心（命运红线 / 爱慕） ============ -->
    <g id="frCrestThird">
      ${PLATE}
      <g fill="#140d03" stroke="#140d03" stroke-width=".7">${HEART}
      </g>
      <g fill="var(--fr-accent, #e0b0ff)">${HEART}
      </g>
      <path d="M-2.15 -1.9 C-2.7 -1.55 -2.95 -1.0 -2.9 -.45 C-2.55 -1.25 -1.9 -1.7 -1.15 -1.85 Z" fill="#fff8dc" opacity=".4"/>
      <ellipse cx="-1.5" cy="-1.75" rx=".5" ry=".72" transform="rotate(-35 -1.5 -1.75)" fill="#fff8dc" opacity=".3"/>
    </g>

    <!-- ============ 底部铭牌：浅弧托板 + 中央菱形 ============ -->
    <g id="frPlateOrn">
      <path d="M-19 0 Q0 -3.1 19 0 Q0 3.1 -19 0 Z" fill="url(#frPlate)" stroke="#0a0703" stroke-width=".4"/>
      <path d="M-19 0 Q0 -3.1 19 0" fill="none" stroke="#cbb573" stroke-width=".28" opacity=".42"/>
      <path d="M-19 0 Q0 3.1 19 0" fill="none" stroke="#000" stroke-width=".26" opacity=".5"/>
      <path d="M-12.6 0 H-4.2 M12.6 0 H4.2" stroke="#8a6d1d" stroke-width=".3" opacity=".5"/>
      <path d="M0 -1.7 L1.5 0 L0 1.7 L-1.5 0 Z" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".3"/>
      <path d="M0 -1.7 L1.5 0 L0 1.7 L-1.5 0 Z" fill="none" stroke="#fff3c8" stroke-width=".18" opacity=".5"/>
      <circle cx="-9" cy="0" r=".5" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".2"/>
      <circle cx="9" cy="0" r=".5" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".2"/>
    </g>

    <!-- ============ 角饰：画窗四角的弧形托角（经典画框语言，任何尺寸都读得出来） ============
         只画左上，其余三角 use + 镜像。局部原点 = **画窗角**，弧向画窗内张开。 -->
    <g id="frCorner">
      <!-- 弧下的投影，让它像"压"在插画上 -->
      <path d="M0 13.5 A13.5 13.5 0 0 1 13.5 0" fill="none" stroke="#000" stroke-width="2.6" opacity=".4"/>
      <!-- 弧本体：暗边 → 金属 → 亮线（三层叠出圆雕感） -->
      <path d="M0 13.5 A13.5 13.5 0 0 1 13.5 0" fill="none" stroke="#0d0802" stroke-width="1.6"/>
      <path d="M0 13.5 A13.5 13.5 0 0 1 13.5 0" fill="none" stroke="url(#frBoss)" stroke-width="1.05"/>
      <path d="M-.35 12.9 A13.1 13.1 0 0 1 12.9 -.35" fill="none" stroke="#fff6d8" stroke-width=".26" opacity=".5"/>
      <!-- 弧中点的菱形宝石（阵营色） -->
      <path d="M4.1 1.85 L6.35 4.1 L4.1 6.35 L1.85 4.1 Z" fill="#0d0802"/>
      <path d="M4.1 2.45 L5.75 4.1 L4.1 5.75 L2.45 4.1 Z" fill="url(#frBoss)"/>
      <path d="M4.1 2.9 L5.3 4.1 L4.1 5.3 L2.9 4.1 Z" fill="var(--fr-accent, #c9a227)"/>
      <path d="M3.35 3.35 L4.1 2.9 L4.55 3.35 L4.1 3.7 Z" fill="#fff" opacity=".5"/>
      <!-- 弧两端的铆钉 -->
      <circle cx="0" cy="13.5" r=".78" fill="url(#frBoss)" stroke="#0d0802" stroke-width=".28"/>
      <circle cx="13.5" cy="0" r=".78" fill="url(#frBoss)" stroke="#0d0802" stroke-width=".28"/>
      <path d="M-.4 13.2 L.4 13.2 M13.2 -.4 L13.2 .4" stroke="#fff6d8" stroke-width=".22" opacity=".5"/>
    </g>

    <!-- 框带中段的小菱形铆钉（顶边两颗 + 左右各两颗），长边不至于空旷 -->
    <g id="frStud">
      <path d="M0 -1.5 L1.15 0 L0 1.5 L-1.15 0 Z" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".26"/>
      <path d="M0 -1.5 L1.15 0 L0 1.5 L-1.15 0 Z" fill="none" stroke="#fff3c8" stroke-width=".16" opacity=".45"/>
      <path d="M-.42 -.55 L.42 -.55 L0 0 Z" fill="#fff" opacity=".3"/>
    </g>
  </defs>
</svg>`;

  /** 生成四条边 + 四角斜接块的填充路径；prefix 决定用哪一套剖面渐变（细档 frBand / 粗档 frBold） */
  const bandPaths = (prefix = 'frBand') =>
    `<path d="${QUAD.top}" fill="url(#${prefix}Top)"/>
  <path d="${QUAD.bottom}" fill="url(#${prefix}Bottom)"/>
  <path d="${QUAD.left}" fill="url(#${prefix}Left)"/>
  <path d="${QUAD.right}" fill="url(#${prefix}Right)"/>
  <path d="${QUAD.tl}" fill="url(#${prefix}CornerT)"/>
  <path d="${QUAD.tr}" fill="url(#${prefix}CornerT)"/>
  <path d="${QUAD.br}" fill="url(#${prefix}CornerB)"/>
  <path d="${QUAD.bl}" fill="url(#${prefix}CornerB)"/>`;

  /**
   * 单张卡的框，自下而上叠：
   *   粗档（框带 → 下染色 → 暗口/唇线 → 上染色）
   *   → 细档（框带 → 斜接缝 → 拉丝 → 下染色 → 导轨/凹槽 → 抛光 → 上染色 → 装饰）
   *   → 画窗内影（顶部内阴影 + 四周暗角，粗档细档都要）
   * 细档的框带与粗档用的是同一组斜接梯形路径，只是换了一套剖面渐变 ——
   * 所以细档能把粗档整条盖住（覆盖性由 test/card-frame.test.js 的网格采样钉住）。
   */
  const FRAME = `
<svg class="fr-svg" viewBox="0 0 ${VIEW.w} ${VIEW.h}" preserveAspectRatio="none"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     aria-hidden="true" focusable="false">
  <!-- ① 粗档：卡宽 < 100px 时细档整组隐藏，看到的就是这一层。
          不是"纯色描边"：同一套斜接梯形换成 8 段粗剖面，在 3.6px 里也做出倒角与暗口。 -->
  <g class="fr-bold">
    ${bandPaths('frBold')}
    <path class="fr-tint-under" d="${RING}" fill-rule="evenodd" fill="var(--fr-tint, #000)"/>
    <path d="${OUTER}" fill="none" stroke="#04020a" stroke-width="1.4"/>
    <path d="${INNER}" fill="none" stroke="var(--fr-accent, #c9a227)" stroke-width="1.1" opacity=".4"/>
    <path d="${INNER}" fill="none" stroke="#fff3c8" stroke-width=".42" opacity=".34"/>
    <path class="fr-tint" d="${RING}" fill-rule="evenodd" fill="var(--fr-tint, #000)"/>
  </g>

  <!-- ② 细档：完整线脚（大尺寸） -->
  <g class="fr-fine">
    ${bandPaths('frBand')}
    <!-- 斜接缝：真画框四条线脚在角上以 45° 相接（角块压暗 + 一道缝） -->
    <g fill="none">
      <path d="M0 ${CH} L${BX} ${BYT} M${CH} 0 L${BX} ${BYT}" stroke="#080502" stroke-width=".38" opacity=".7"/>
      <path d="M${VIEW.w} ${CH} L${VIEW.w - BX} ${BYT} M${VIEW.w - CH} 0 L${VIEW.w - BX} ${BYT}" stroke="#080502" stroke-width=".38" opacity=".7"/>
      <path d="M0 ${VIEW.h - CH} L${BX} ${VIEW.h - BYB} M${CH} ${VIEW.h} L${BX} ${VIEW.h - BYB}" stroke="#080502" stroke-width=".38" opacity=".7"/>
      <path d="M${VIEW.w} ${VIEW.h - CH} L${VIEW.w - BX} ${VIEW.h - BYB} M${VIEW.w - CH} ${VIEW.h} L${VIEW.w - BX} ${VIEW.h - BYB}" stroke="#080502" stroke-width=".38" opacity=".7"/>
      <path d="M.4 ${CH + 0.4} L${BX - 0.6} ${BYT - 0.6} M${CH + 0.4} .4 L${BX - 0.6} ${BYT - 0.6}"
            stroke="#e8d9a4" stroke-width=".2" opacity=".2"/>
    </g>
    <path d="${RING}" fill-rule="evenodd" fill="url(#frHatch)"/>
    <!-- 阵营染色第一层（导轨之下）：把框面实染成阵营色 -->
    <path class="fr-tint-under" d="${RING}" fill-rule="evenodd" fill="var(--fr-tint, #000)"/>
    <g fill="none">
      <!-- ④ 刻线：外口 / 主导轨 / 次导轨 / 内凹，都描在框带上（描边的四角是自然斜接缝） -->
      <rect x=".3" y=".3" width="99.4" height="149.4" rx="${CH}" stroke="#04020a" stroke-width=".6"/>
      <rect x="2.6" y="3.4" width="94.8" height="143.2" stroke="#1e1405" stroke-width=".55" opacity=".8"/>
      <rect x="2.98" y="3.86" width="94.04" height="142.28" stroke="#cbb573" stroke-width=".4" opacity=".5"/>
      <rect x="4.6" y="6.4" width="90.8" height="137.2" stroke="#1e1405" stroke-width=".5" opacity=".75"/>
      <rect x="4.98" y="6.82" width="90.04" height="136.36" stroke="#c0a45c" stroke-width=".32" opacity=".42"/>
      <!-- 画窗凹槽：亮唇线 → 黑台阶 → 外口暗线，插画才像"嵌"进去而不是贴上去 -->
      <rect x="${BX - 1.5}" y="${BYT - 1.5}" width="${VIEW.w - 2 * BX + 3}" height="${VIEW.h - BYT - BYB + 3}"
            rx="${WINDOW_RX + 1.2}" stroke="#f0e0b0" stroke-width=".42" opacity=".45"/>
      <rect x="${BX - 0.95}" y="${BYT - 0.95}" width="${VIEW.w - 2 * BX + 1.9}" height="${VIEW.h - BYT - BYB + 1.9}"
            rx="${WINDOW_RX + 0.75}" stroke="#06040a" stroke-width="1.5"/>
      <rect x="${BX - 0.2}" y="${BYT - 0.2}" width="${VIEW.w - 2 * BX + 0.4}" height="${VIEW.h - BYT - BYB + 0.4}"
            rx="${WINDOW_RX + 0.15}" stroke="#0a0703" stroke-width=".9"/>
    </g>
    <path d="${RING}" fill-rule="evenodd" fill="url(#frSheen)"/>
    <!-- ③ 阵营染色分两层，这是关键：
          · 第一层在导轨**之下**（上面那条），把框面实染成阵营色；
          · 第二层在这里、导轨**之上**，只给 45% 的浓度罩一层色相 ——
            整条框带（含亮导轨）统一带上阵营色，但金属的明暗对比还在。
         只染一层时试过两种极端：只染下层 → 亮导轨仍是纯金，看着还是"金框"；
         只染上层且浓度拉满 → 金色被压没，框体发灰发闷。 -->
    <path class="fr-tint" d="${RING}" fill-rule="evenodd" fill="var(--fr-tint, #000)"/>
    <!-- ⑤ 装饰：边中铆钉、顶部徽记、底部铭牌、画窗四角托角 -->
    <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(26 6.6)"/>
    <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(74 6.6)"/>
    <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(3.5 52) rotate(90)"/>
    <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(3.5 98) rotate(90)"/>
    <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(96.5 52) rotate(90)"/>
    <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(96.5 98) rotate(90)"/>
    <!-- 徽记按阵营换：默认（无 data-faction，例如牌背）露狼爪 —— 那是这个游戏的品牌记号。
         三个都画好放在这里，由 CSS 按 data-faction 切换显示，避免在 JS 里拼分支。 -->
    <g class="fr-crest-wolf"><use href="#frCrest" xlink:href="#frCrest" transform="translate(50 5.5)"/></g>
    <g class="fr-crest-god"><use href="#frCrestGod" xlink:href="#frCrestGod" transform="translate(50 5.5)"/></g>
    <g class="fr-crest-vil"><use href="#frCrestVil" xlink:href="#frCrestVil" transform="translate(50 5.5)"/></g>
    <g class="fr-crest-third"><use href="#frCrestThird" xlink:href="#frCrestThird" transform="translate(50 5.5)"/></g>
    <use class="fr-plate" href="#frPlateOrn" xlink:href="#frPlateOrn" transform="translate(50 ${VIEW.h - 5})"/>
    <use class="fr-corner" href="#frCorner" xlink:href="#frCorner" transform="translate(${BX} ${BYT})"/>
    <use class="fr-corner" href="#frCorner" xlink:href="#frCorner" transform="translate(${VIEW.w - BX} ${BYT}) scale(-1 1)"/>
    <use class="fr-corner" href="#frCorner" xlink:href="#frCorner" transform="translate(${BX} ${VIEW.h - BYB}) scale(1 -1)"/>
    <use class="fr-corner" href="#frCorner" xlink:href="#frCorner" transform="translate(${VIEW.w - BX} ${VIEW.h - BYB}) scale(-1 -1)"/>
  </g>

  <!-- ⑥ 画窗：顶部内阴影 + 四周暗角（粗档细档都要，否则小卡插画像贴纸） -->
  <rect x="${BX}" y="${BYT}" width="${VIEW.w - 2 * BX}" height="${Math.min(16, VIEW.h - BYT - BYB)}"
        fill="url(#frTopShade)"/>
  <rect x="${BX}" y="${BYT}" width="${VIEW.w - 2 * BX}" height="${VIEW.h - BYT - BYB}" fill="url(#frVig)"/>
</svg>`;

  let injected = false;

  /** 注入页面级 defs（只注一次）。没有 document 时静默跳过，便于在 Node 里单测字符串。 */
  function ensureDefs() {
    if (injected || typeof document === 'undefined' || !document.body) return false;
    if (document.getElementById(DEFS_ID)) { injected = true; return true; }
    const box = document.createElement('div');
    box.innerHTML = DEFS.trim();
    const svg = box.firstElementChild;
    if (svg) document.body.insertBefore(svg, document.body.firstChild);
    injected = true;
    return true;
  }

  /** 生成一张卡的框层标记（会按需注入 defs） */
  function html() {
    ensureDefs();
    return FRAME.trim();
  }

  /**
   * 角色 id 的统一清理：只放行 `[\w-]`（属性值要写进 DOM，非法字符一律剔除）。
   * `roleAttrs()`、新主题映射、素材路径三处共用同一个原语 —— 免得三处各自清理、
   * 各自忘记处理空值，最后出现"主题是 neutral、data-role 却还是原文"这类不一致。
   * @param {string} [rid]
   * @returns {string} 清理后的 id（空值 → 空串）
   */
  const sanitizeRole = (rid) => String(rid == null ? '' : rid).replace(/[^\w-]/g, '');

  /**
   * 取角色对应的数据集属性（单一原语，`roleAttr()` 与调用方 `dataset` 赋值都走这里，
   * 免得两处各自清理字符、各自忘记带阵营）。
   * @param {string} [rid] 角色 id
   * @returns {{role?: string, faction?: string}}
   */
  function roleAttrs(rid) {
    if (!rid) return {};
    const id = sanitizeRole(rid);
    if (!id) return {};
    return FACTION[id] ? { role: id, faction: FACTION[id] } : { role: id };
  }

  /**
   * 角色卡的外层 <div> 需要带 `data-role="<id>"` 与 `data-faction="<阵营>"`：
   * 框带的阵营染色、角色专属强调色（徽记 / 托角宝石）与**徽记图形**全部由 style.css 里
   * `.card-frame[data-role=...]` / `[data-faction=...]` 那组规则决定 ——
   * 这样"每个角色一张卡"的配色只有一处来源，调用方只负责把 id 带过来。
   * @param {string} [rid] 角色 id；空值返回空串（无角色卡走默认金色 + 狼爪品牌徽记）
   */
  function roleAttr(rid) {
    const a = roleAttrs(rid);
    let out = '';
    if (a.role) out += ` data-role="${a.role}"`;
    if (a.faction) out += ` data-faction="${a.faction}"`;
    return out;
  }

  /* ==========================================================================
   * SKIN-02：统一挂载接口（V3「月蚀圣龛」素材，源自 design/card-frames/v3/）
   * --------------------------------------------------------------------------
   * 为什么必须有共享挂载层，而不是让桌面 / 手机 / 图鉴各自拼一张卡：
   *   · **主题映射**只要抄错一处，就会出现"预言家牌上印狼爪"这种不报错的错；三份映射必然漂移。
   *   · **画窗裁切与 1024×1536 坐标系**同理：抄第二份就会出现"两端立绘裁得不一样"。
   *   · **素材路径**在桌面 `/`、手机 `/m/`、两种原生壳下各不相同，逐调用点打补丁必然漏一个。
   *   · **身份可见性**最危险：未知身份必须是同一张 neutral 牌背，DOM / URL / ARIA /
   *     预加载请求都不得带出真实秘密角色 —— 只有共享层能守住"绝不先渲染正面"。
   *
   * 与旧接口的关系（**没有替换任何旧 API**）：
   *   · `html()` 仍返回框层**字符串**（app.js / m.js / codex.js 仍在用），`roleAttr()` /
   *     `roleAttrs()` 的 `wolf / god / villager / third` 分类原样保留（codex.js 的分区依赖它）。
   *   · 新接口 `mount(host, options)` 返回**节点**并替换宿主子节点（沿用设计包 `ReliquaryCards.mount`
   *     的契约）。两者返回类型不同，所以这里是**新增**而不是改写 `html()`。
   *   · 新主题命名只在这里映射一次：wolf→wolf、god→oracle、villager→village、third→fate，
   *     未知/不可见 → neutral。`fate` 只是暗恋者的外观，不是引擎新增阵营。
   * ========================================================================== */

  /** 素材坐标系：设计包 frame-kit.js 的 viewBox 与裁切路径**逐字迁移**，两端不手抄第二套 */
  const R3_VIEW = { w: 1024, h: 1536 };
  const R3_WINDOW = 'M104 372 Q122 278 218 222 C318 156 402 172 512 242 C622 172 706 156 806 222 Q902 278 920 372 V1209 Q908 1282 843 1316 H181 Q116 1282 104 1209Z';
  /** 大卡画窗：立绘 <image> 的落位（968 裁切用 R3_WINDOW） */
  const R3_ART = { x: 76, y: 108, w: 872, h: 1308 };
  /** 小卡简化矩形裁切（大卡拱形画窗在小尺寸会糊成一团） */
  const R3_COMPACT_CUT = { x: 66, y: 103, w: 892, h: 1313, rx: 8 };

  /** 阵营外观 → 设计包主题名（唯一映射点；引擎 category / 旧外观键都不因此改变） */
  const FACTION_THEME = { wolf: 'wolf', god: 'oracle', villager: 'village', third: 'fate' };
  /** 所有不可见身份、未知/非法角色 id 的统一主题 */
  const NEUTRAL_THEME = 'neutral';

  /** 角色 → 主题（由 FACTION + FACTION_THEME 派生，杜绝两张表各写一遍） */
  const THEME = {};
  for (const id of Object.keys(FACTION)) THEME[id] = FACTION_THEME[FACTION[id]] || NEUTRAL_THEME;

  /**
   * 生产角色名（仅作**兜底**）：与 `src/engine/roles.js` 的 `name` 逐条一致，由
   * test/card-frame-skin.test.js 钉住。真正的名称来源是调用方（服务端角色资料 / i18n），
   * `mount({ name })` 传什么就用什么；这里绝不用设计演示页里那套固定中文替代生产文案。
   */
  const ROLE_NAMES = {
    villager: '平民', wolf: '狼人', wolfking: '狼王', whitewolfking: '白狼王',
    seer: '预言家', witch: '女巫', hunter: '猎人', guard: '守卫', idiot: '白痴',
    knight: '骑士', dreamer: '摄梦人', wolfbeauty: '狼美人', crow: '乌鸦',
    hiddenwolf: '隐狼', admirer: '暗恋者',
  };
  const NAME_UNKNOWN = '未揭示';
  const ARIA_HIDDEN = '统一牌背，身份未揭示';

  /** 组件外框 ≤112px 走 R2 精雕小框，>112px 走大卡材质（施工说明 §SKIN-02 的统一切换阈值） */
  const COMPACT_MAX = 112;
  /** 全卡严格 2:3（230×345，不是旧的 230×330） */
  const RATIO = 3 / 2;
  /** 施工说明钉住的六个场景宽度（测试与调用方都读这一份，不各写一套魔数） */
  const SIZES = { phone: 52, desktop: 62, codex: 132, codexBig: 210, flip: 230, inspect: 320 };

  const ASSET_DIR = 'assets/card-frames/v3/';
  const ART_DIR = 'assets/roles/';
  const KIT_CSS = 'shared/card-frame-kit.css';
  const KIT_CSS_ID = 'ww-card-kit-css';
  const BACK_FIELD = 'card-back-field.svg';

  let assetBaseOverride = null;
  let artBaseOverride = null;

  /**
   * 共享脚本自身的 URL，**在脚本执行的那一刻**取一次。
   *
   * 为什么必须现在取：`document.currentScript` 只在脚本执行期间有值；等调用方在若干毫秒后
   * 调 `mount()` 时它已经是 `null` 了。那时再走"按页面 URL 兜底"虽然也能算对（桌面 `/`、
   * 手机 `/m/` 退一级），但页面一旦被放在更深的子路径（或换个壳的入口页），就会算错 ——
   * 而路径算错的表现是"图全裂"，不是报错。这里把它钉在第一手来源上。
   */
  const SELF_SRC = (() => {
    try {
      const cs = typeof document !== 'undefined' && document.currentScript;
      return cs && cs.src ? String(cs.src) : '';
    } catch (_) { return ''; }
  })();

  const withSlash = (u) => {
    const s = String(u == null ? '' : u);
    if (!s) return '';
    return s.endsWith('/') ? s : `${s}/`;
  };

  /**
   * 站点公开资源根（**共享层唯一路径来源**）。
   *
   * 为什么不能在每个调用点写相对路径：桌面页在 `/`、手机页在 `/m/`，同一个 `card-frame.js`
   * 却被两页分别以 `/card-frame.js` 与 `../card-frame.js` 引入 —— 相对路径在两端解析结果不同。
   * 这里以**共享脚本自身的 URL**（脚本加载时捕获的 SELF_SRC）为基准，因此：
   *   · 桌面 `http(s)://host/`            → `/assets/card-frames/v3/`
   *   · 手机 `http(s)://host/m/`          → 同样是 `/assets/…`（脚本 URL 不在 /m/ 下，天然正确）
   *   · Capacitor 安卓壳（`http://localhost` / `https://localhost`）与 Electron（`file://`）同理，
   *     因为 `new URL(相对路径, 脚本URL)` 在每种 scheme 下都按该 scheme 的规则解析。
   * 兜底顺序：显式 override → 脚本 URL → 页面 URL 目录（并把结尾的 `m/` 退回一级）→ `'/'`。
   * @returns {string} 以 `/` 结尾的绝对（或根相对）URL
   */
  function publicRoot() {
    const stripM = (dir) => (/\/m\/$/.test(dir) ? dir.replace(/\/m\/$/, '/') : dir);
    if (SELF_SRC) {
      try { return stripM(new URL('.', SELF_SRC).href); } catch (_) { /* 非绝对 URL：走下一档 */ }
    }
    try {
      const href = typeof location !== 'undefined' && location.href ? String(location.href) : '';
      if (href) return stripM(new URL('.', href).href);
    } catch (_) { /* 无 DOM / 非法 URL：走根相对兜底 */ }
    return '/';
  }

  /** 卡框素材目录（桌面 `/assets/card-frames/v3/`；原生壳按各自 scheme 解析） */
  function assetBase() {
    const forced = (() => {
      try { return root.__WW_CARD_ASSET_BASE__; } catch (_) { return null; }
    })();
    if (typeof forced === 'string' && forced) return withSlash(forced);
    if (assetBaseOverride) return withSlash(assetBaseOverride);
    try { return new URL(ASSET_DIR, publicRoot()).href; } catch (_) { return `/${ASSET_DIR}`; }
  }

  /** 角色立绘目录（沿用既有 web/assets/roles/，本次不重绘角色图） */
  function artBase() {
    if (artBaseOverride) return withSlash(artBaseOverride);
    try { return new URL(ART_DIR, publicRoot()).href; } catch (_) { return `/${ART_DIR}`; }
  }

  /** 把一个**清单内**的素材名字解析成可加载 URL（不接受任意路径，防注入/防越权引用） */
  function assetUrl(name) {
    const base = assetBase();
    try { return new URL(String(name), base).href; } catch (_) { return base + String(name); }
  }

  function artUrl(rid) {
    const base = artBase();
    try { return new URL(`${sanitizeRole(rid)}.png`, base).href; } catch (_) { return `${base}${sanitizeRole(rid)}.png`; }
  }

  /** 共享渲染层样式的 URL（SKIN-03 也可以改为页面静态 <link>，本函数与 ensureStyles 都幂等） */
  function stylesheetUrl() {
    try { return new URL(KIT_CSS, publicRoot()).href; } catch (_) { return `/${KIT_CSS}`; }
  }

  /**
   * 注入共享卡牌样式（只注一次，共用同一份缓存）。
   * 为什么由 JS 注入而不是改 index.html：本工作包（SKIN-00/01/02）不得改页面文件；
   * SKIN-03 若改成静态 `<link>`，这里会自动识别已有引用并只补 id，不重复加载。
   */
  function ensureStyles(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.head) return null;
    const existing = d.getElementById(KIT_CSS_ID);
    if (existing) return existing;
    const href = stylesheetUrl();
    let found = null;
    try {
      for (const link of d.querySelectorAll('link[rel="stylesheet"]')) {
        const raw = String(link.getAttribute('href') || '');
        if (link.href === href || raw.endsWith(KIT_CSS)) { found = link; break; }
      }
    } catch (_) { /* 极老 WebView 的 querySelectorAll 差异：忽略，直接插一条 */ }
    if (found) { found.id = KIT_CSS_ID; return found; }
    const link = d.createElement('link');
    link.id = KIT_CSS_ID;
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-ww-card-kit', '1');
    d.head.appendChild(link);
    return link;
  }

  /** 显式覆盖素材/立绘目录（原生壳从应用公开资源根构造绝对 URL 时用；传空恢复自动解析） */
  function setAssetBase(u) { assetBaseOverride = u ? String(u) : null; }
  function setArtBase(u) { artBaseOverride = u ? String(u) : null; }

  /**
   * 主题：`revealed` **严格等于 true** 才使用角色 id，否则一律 neutral。
   *
   * 这里比 `roleAttrs()` **更严**：含非法字符（`wo"lf`）或非字符串的输入直接当作"未知"，
   * 不做"剔掉非法字符再试试看"。理由：属性清理是为了"不破坏 DOM"，而主题与素材路径是
   * **信任边界** —— 把 `wo"lf` 折叠成 `wolf` 等于让一份畸形输入命中一张真实角色的牌面。
   * 旧接口 `roleAttr()` 的宽松行为原样保留（已有调用方与既有测试依赖）。
   * @param {string} [roleId]
   * @param {boolean} [revealed] "当前视角允许知道该身份"（不是照搬公开翻牌字段）
   * @returns {'wolf'|'oracle'|'village'|'fate'|'neutral'}
   */
  function themeOf(roleId, revealed) {
    if (revealed !== true) return NEUTRAL_THEME;
    const id = roleKey(roleId);
    return (id && THEME[id]) || NEUTRAL_THEME; // 未知/非法 id 中性回退
  }

  /** 严格角色 id：必须是字符串、非空、且清理前后完全相同（否则算未知 → neutral） */
  function roleKey(roleId) {
    if (typeof roleId !== 'string' || !roleId) return '';
    return sanitizeRole(roleId) === roleId ? roleId : '';
  }

  /** 角色名（仅在 revealed 时使用；未知角色同样回退成中性文案，不泄露也不瞎猜） */
  function nameOf(roleId, revealed) {
    if (themeOf(roleId, revealed) === NEUTRAL_THEME) return NAME_UNKNOWN;
    return ROLE_NAMES[roleKey(roleId)] || NAME_UNKNOWN;
  }

  /**
   * 已知宽度 → 固定几何（严格 2:3；取整后的比例误差 ≤1 CSS px）。
   * @param {number} width CSS px
   * @returns {{width:number,height:number,compact:boolean}|null}
   */
  function sizeOf(width) {
    const w = Number(width);
    if (!Number.isFinite(w) || w <= 0) return null;
    const px = Math.max(1, Math.round(w));
    return { width: px, height: Math.round(px * RATIO), compact: px <= COMPACT_MAX };
  }

  /**
   * 空间不足时**等比缩小**（检视卡最高参考 320×480、翻牌 230×345 都走这里）。
   * @param {number} width 期望宽度
   * @param {{width?:number,height?:number,maxWidth?:number,maxHeight?:number}} [avail] 可用宽高
   */
  function fitSize(width, avail) {
    const base = sizeOf(width);
    if (!base) return null;
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const maxW = num(avail && (avail.width || avail.maxWidth));
    const maxH = num(avail && (avail.height || avail.maxHeight));
    let scale = 1;
    if (maxW) scale = Math.min(scale, maxW / base.width);
    if (maxH) scale = Math.min(scale, maxH / base.height);
    if (scale >= 1) return { ...base, scaled: false };
    const w = Math.max(1, Math.floor(base.width * scale));
    return { width: w, height: Math.round(w * RATIO), compact: w <= COMPACT_MAX, scaled: true };
  }

  // ------------------------------------------------------------------ DOM 渲染

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  let clipSeq = 0;

  /** 一次性创建 + 属性写入（`xlink:href` 与 `href` 同写：老 WebView 只认前者） */
  function svgNode(d, tag, attrs) {
    const node = d.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attrs || {})) {
      node.setAttribute(key, String(attrs[key]));
      if (key === 'href') { try { node.setAttributeNS(XLINK_NS, 'xlink:href', String(attrs[key])); } catch (_) { /* 忽略 */ } }
    }
    return node;
  }

  /** 纯装饰图：不参与点击、不进读屏、不拖拽 */
  function decorationNode(d, cls, src) {
    const img = d.createElement('img');
    img.className = cls;
    img.src = src;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;
    img.decoding = 'async';
    return img;
  }

  /**
   * 按当前档位**按需创建**材质层。
   *
   * ⚠ 这是 SKIN-02 最硬的一条：小卡（≤112px）**根本不创建** `reliquary-metal.png`（约 1.94MiB）
   *   与完整 SVG 兜底 —— 不创建就不请求。设计包的展示组件是把所有层都插进去再用 CSS 隐藏，
   *   那条路在 52px 常驻牌上会白下载约 1.94MiB；生产适配不照搬演示 DOM。
   *   （SW 安装时的一次性离线预缓存不在此限，那是离线能力的代价，不是组件流量。）
   */
  function buildLayers(st) {
    if (!st.compact) {
      if (st.compactImg) { st.compactImg.remove(); st.compactImg = null; }
      if (!st.metal) {
        st.metal = decorationNode(st.d, 'r3-material', st.url('reliquary-metal.png'));
        st.metal.addEventListener('error', () => { st.card.dataset.materialError = 'true'; });
        st.card.appendChild(st.metal);
      }
      if (!st.vector) {
        st.vector = decorationNode(st.d, 'r3-vector', st.url(`frame-${st.theme}.svg`));
        st.vector.addEventListener('error', () => { st.vector.hidden = true; st.card.dataset.vectorError = 'true'; });
        st.card.appendChild(st.vector);
      }
      if (!st.accent) {
        st.accent = decorationNode(st.d, 'r3-accent', st.url(`accent-${st.theme}.svg`));
        st.accent.addEventListener('error', () => { st.accent.hidden = true; st.card.dataset.accentError = 'true'; });
        st.card.appendChild(st.accent);
      }
    } else {
      if (st.metal) { st.metal.remove(); st.metal = null; }
      if (st.vector) { st.vector.remove(); st.vector = null; }
      if (st.accent) { st.accent.remove(); st.accent = null; }
      if (!st.compactImg) {
        st.compactImg = decorationNode(st.d, 'r3-compact', st.url(`compact-${st.theme}.svg`));
        st.compactImg.addEventListener('error', () => { st.compactImg.hidden = true; st.card.dataset.compactError = 'true'; });
        st.card.appendChild(st.compactImg);
      }
    }
  }

  /** 宽度未知（未传 width）的卡：用**一个共享** ResizeObserver 跨过 112px 时切档；断开的卡自动摘掉 */
  const autoWatch = new Set();
  let autoRO = null;

  function watchAuto(st, RO) {
    if (!autoRO) {
      autoRO = new RO(() => {
        for (const entry of [...autoWatch]) {
          const shell = entry.shell;
          if (!shell.isConnected) { autoRO.unobserve(shell); autoWatch.delete(entry); continue; }
          const w = shell.getBoundingClientRect ? shell.getBoundingClientRect().width : shell.offsetWidth;
          if (!w) continue;
          const want = w <= COMPACT_MAX;
          if (want === entry.compact) continue;
          entry.compact = want;
          shell.dataset.detail = want ? 'compact' : 'big';
          buildLayers(entry);
        }
      });
    }
    autoWatch.add(st);
    autoRO.observe(st.shell);
  }

  /** 摘掉某张卡的监听（宿主被移除时调用；不调用也会在下一次回调里自愈） */
  function unmount(host) {
    if (host && typeof host.replaceChildren === 'function') host.replaceChildren();
    for (const entry of [...autoWatch]) {
      if (!host || entry.host === host || !entry.shell.isConnected) {
        if (autoRO) autoRO.unobserve(entry.shell);
        autoWatch.delete(entry);
      }
    }
    return null;
  }

  /**
   * **产品唯一卡牌挂载入口**（桌面 / 手机 / 图鉴 / 检视都走这里）。
   *
   * @param {Element} host 只装牌面的宿主元素（**不要**传整个弹层/含按钮的容器：会替换其全部子节点）
   * @param {object} [options]
   * @param {string} [options.roleId] 角色 id（只在 `revealed === true` 时才会被使用）
   * @param {boolean} [options.revealed] "当前视角允许知道该身份"；缺省/非 true ⇒ 统一 neutral 牌背
   * @param {string} [options.name] 名称（来自服务端角色资料/i18n）；缺省用 ROLE_NAMES 兜底
   * @param {number} [options.width] 显式宽度（52/62/132/210/230/320…）；缺省吃容器宽度
   * @param {boolean} [options.compact] 强制小卡（旧 WebView 没有容器查询时由调用方显式指定）
   * @param {'hybrid'|'vector'} [options.render] `vector` = 只用完整 SVG（跳过金属 PNG）
   * @param {string} [options.assetBase] 覆盖卡框素材目录（原生壳用）
   * @param {string} [options.artBase] 覆盖立绘目录（原生壳用）
   * @returns {Element} 新建的 `.r3-shell`
   */
  function mount(host, options) {
    if (!host || typeof host.replaceChildren !== 'function') {
      throw new TypeError('CardFrame.mount(host, options)：host 必须是只装牌面的容器元素');
    }
    const d = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!d) throw new Error('CardFrame.mount 需要 DOM 环境');
    const opts = options || {};

    // ① 可见性先于一切：未获知身份 ⇒ 后半段代码拿不到任何角色线索（DOM/URL/ARIA 都不会带）
    const revealed = opts.revealed === true;
    const roleId = revealed ? roleKey(opts.roleId) : '';
    const known = !!(roleId && THEME[roleId]);
    const theme = themeOf(opts.roleId, revealed);
    const name = known ? String(opts.name || ROLE_NAMES[roleId] || NAME_UNKNOWN) : NAME_UNKNOWN;

    // ② 路径统一由共享层给出（可用 options 覆盖；调用点不写相对路径补丁）
    const base = withSlash(opts.assetBase || assetBase());
    const art = withSlash(opts.artBase || artBase());
    const url = (n) => { try { return new URL(String(n), base).href; } catch (_) { return base + String(n); } };

    // ③ 几何：给了宽度就**显式选档**（老 WebView 不依赖容器查询）；没给才交给响应式
    const size = sizeOf(opts.width);
    const compact = opts.compact === true || !!(size && size.compact);

    ensureStyles(d);

    const shell = d.createElement('div');
    shell.className = 'r3-shell';
    shell.dataset.theme = theme;
    shell.dataset.render = opts.render === 'vector' ? 'vector' : 'hybrid';
    shell.dataset.detail = compact ? 'compact' : 'big';
    if (size) {
      shell.style.width = `${size.width}px`;
      shell.style.height = `${size.height}px`;
    }

    const card = d.createElement('div');
    card.className = 'r3-card';
    card.setAttribute('role', 'img');
    card.setAttribute('aria-label', known ? `${name}角色牌` : ARIA_HIDDEN);
    if (known) card.dataset.role = roleId; // 未知/不可见都不写 data-role

    // 画窗：立绘通过 SVG <image> + clipPath 覆盖，原始角色 PNG 不改、不裁成贴图
    const artSvg = svgNode(d, 'svg', { viewBox: `0 0 ${R3_VIEW.w} ${R3_VIEW.h}`, class: 'r3-art', 'aria-hidden': 'true', focusable: 'false' });
    const defs = svgNode(d, 'defs', {});
    const clipId = `r3-window-${++clipSeq}`;
    const clip = svgNode(d, 'clipPath', { id: clipId });
    clip.appendChild(svgNode(d, 'path', { d: R3_WINDOW, class: 'r3-cut-full' }));
    clip.appendChild(svgNode(d, 'rect', {
      x: R3_COMPACT_CUT.x, y: R3_COMPACT_CUT.y, width: R3_COMPACT_CUT.w, height: R3_COMPACT_CUT.h,
      rx: R3_COMPACT_CUT.rx, class: 'r3-cut-compact',
    }));
    defs.appendChild(clip);
    // 未获知身份 ⇒ 统一中性牌背内衬；这里**不会**出现 `${roleId}.png` 这个 URL
    const picture = svgNode(d, 'image', {
      x: R3_ART.x, y: R3_ART.y, width: R3_ART.w, height: R3_ART.h,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': `url(#${clipId})`,
      href: known ? `${art}${roleId}.png` : url(BACK_FIELD),
    });
    picture.addEventListener('error', () => { card.dataset.artError = 'true'; });
    artSvg.appendChild(defs);
    artSvg.appendChild(picture);
    card.appendChild(artSvg);

    const state = { d, card, shell, host, theme, compact, url, metal: null, vector: null, accent: null, compactImg: null };
    buildLayers(state);

    const title = d.createElement('span');
    title.className = 'r3-title';
    title.textContent = name; // 只用文本节点写入：玩家/角色文案绝不拼成 SVG/HTML
    title.setAttribute('aria-hidden', 'true');
    card.appendChild(title);

    shell.appendChild(card);
    host.replaceChildren(shell);

    // ④ 宽度未知时才需要响应式切档（显式宽度的卡不留任何尺寸监听器）
    if (!size) {
      const view = d.defaultView || null;
      const RO = (view && view.ResizeObserver) || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
      if (RO) watchAuto(state, RO);
    }
    return shell;
  }

  // 共享样式在**脚本加载时**就注入，而不是等第一次 mount()：
  // 卡牌往往首屏就出现，晚一步注入会让第一张卡先以"没有框"的状态画一帧（表现为闪一下）。
  // 无 DOM 的环境（Node 单测）由 ensureStyles 自己静默返回 null；注入失败也绝不阻断脚本。
  try { ensureStyles(); } catch (_) { /* 样式问题不该让卡牌脚本本身挂掉 */ }

  const api = {
    html, ensureDefs, roleAttr, roleAttrs, DEFS, FRAME, DEFS_ID, FACTION, THIRD_PARTY, VIEW, BX, BYT, BYB, CH, WINDOW_RX, OUTER, INNER, RING, QUAD, bandPaths, R,
    // SKIN-02：统一挂载层（唯一卡牌入口）
    mount, unmount, themeOf, nameOf, sizeOf, fitSize, assetBase, artBase, assetUrl, artUrl,
    setAssetBase, setArtBase, stylesheetUrl, ensureStyles, sanitizeRole,
    THEME, FACTION_THEME, NEUTRAL_THEME, ROLE_NAMES, NAME_UNKNOWN, COMPACT_MAX, RATIO, SIZES,
    R3_VIEW, R3_WINDOW, R3_ART, R3_COMPACT_CUT, ASSET_DIR, ART_DIR, KIT_CSS,
  };
  root.CardFrame = api;
  // 用 typeof 守卫而不是 root.module：被 require 的模块里 globalThis.module 是 undefined，
  // root.module 那条路永远不会执行（require 只会拿到空对象）。浏览器里没有 module，
  // typeof 判断让它整行不执行。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
