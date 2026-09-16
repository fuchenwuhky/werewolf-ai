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

    <!-- ============ 顶部徽记：月牙 + 狼爪（阵营色由 var(--fr-accent) 注入） ============ -->
    <g id="frCrest">
      <!-- 底盘：六边凹座（大了才读得出是"徽记"而不是一颗扣子） -->
      <path d="M-8 0 L-5.2 -4.35 H5.2 L8 0 L5.2 4.35 H-5.2 Z" fill="url(#frPlate)" stroke="#080502" stroke-width=".55"/>
      <path d="M-8 0 L-5.2 -4.35 H5.2 L8 0" fill="none" stroke="#cbb573" stroke-width=".34" opacity=".45"/>
      <path d="M-5.2 4.35 H5.2 L8 0" fill="none" stroke="#000" stroke-width=".3" opacity=".5"/>
      <path d="M-6.8 0 L-4.5 -3.55 H4.5 L6.8 0 L4.5 3.55 H-4.5 Z" fill="none" stroke="#f2e2a8" stroke-width=".16" opacity=".2"/>
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
    <use class="fr-crest" href="#frCrest" xlink:href="#frCrest" transform="translate(50 5.5)"/>
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
   * 角色卡的外层 <div> 需要带 `data-role="<id>"`：框带的阵营染色与
   * 角色专属强调色（徽记 / 托角宝石）全部由 style.css 里
   * `.card-frame[data-role=...]` 那组规则决定 —— 这样"每个角色一张卡"的
   * 配色只有一处来源，调用方只负责把 id 带过来。
   * @param {string} [rid] 角色 id；空值返回空串（无角色卡走默认金色）
   */
  function roleAttr(rid) {
    if (!rid) return '';
    return ` data-role="${String(rid).replace(/[^\w-]/g, '')}"`;
  }

  const api = { html, ensureDefs, roleAttr, DEFS, FRAME, DEFS_ID, VIEW, BX, BYT, BYB, CH, WINDOW_RX, OUTER, INNER, RING, QUAD, bandPaths, R };
  root.CardFrame = api;
  // 用 typeof 守卫而不是 root.module：被 require 的模块里 globalThis.module 是 undefined，
  // root.module 那条路永远不会执行（require 只会拿到空对象）。浏览器里没有 module，
  // typeof 判断让它整行不执行。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
