/**
 * card-frame.js — 角色卡金属框（手绘 SVG，单一来源）
 * ============================================================================
 * 为什么是 SVG 而不是 CSS 渐变拼：
 *   原来用「多层 background 渐变 + box-shadow 内阴影 + 4 个圆点铆钉 + 一个 ✠ 字符」拼框，
 *   只能做出"一条扁平金带"，做不出真实的线脚（moulding）、斜接缝（miter）、金托宝石与卷草。
 *   现在整张框是一张手绘 SVG。
 *
 * 坐标系与"框带必须和 CSS 对齐"这个坑：
 *   viewBox = 0 0 100 150（2:3），1 单位 = 卡片宽度的 1%。
 *   框带 B = 7 单位 = CSS `padding: 7%`（百分比 padding 按**宽度**解析，四边一致）。
 *   纵向内缩不能用同一个变量：`bottom: 7%` 会按**高度**解析（= 10.5 单位），
 *   所以 CSS 另设 --band-y = 4.667%（= 7/150）。两者必须同步修改。
 *
 * 剖面（双线脚，外 → 内，单位）：
 *   0.00 外轮廓暗线 → 0.35 亮倒角 → 2.10 刻槽 → 2.60 凸轨 → 3.10 主平面
 *   → 5.10 刻槽 → 5.60 次凸轨 → 6.10 内凹 → 7.00 画窗阴影
 *   平滑过渡交给四条边的横截面渐变；刻槽与凸轨另外用**描边矩形**压上去 ——
 *   描边在四角是自然的斜接缝（miter join），这正是"真画框"的观感来源。
 */
'use strict';
(function (root) {
  const DEFS_ID = 'ww-card-frame-defs';
  /** 坐标系与几何常量：导出给测试用，保证 CSS 与 SVG 不会各改一半（错位是静默的） */
  const VIEW = { w: 100, h: 150 }; // viewBox：1 单位 = 卡宽 1%
  const BAND = 7;                  // 框带宽度（单位）；= CSS --band: 7% / --band-y: 4.667%
  const WINDOW_RX = 1.6;           // 画窗圆角（单位）；= CSS .role-art border-radius 1.6%/1.067%

  /** 金属剖面（沿框带横截面，从外到内）。四条边方向不同，各用一份。
   *  设计要点：大面积是**暗琥珀/青铜**，只有倒角与凸轨是窄窄的亮奶金 ——
   *  高饱和亮黄铺满整条带子会显得廉价（第一版就是这个问题）。 */
  const PROFILE = `
      <stop offset="0" stop-color="#0a0805"/>
      <stop offset=".04" stop-color="#3a2a0c"/>
      <stop offset=".09" stop-color="#d8c88e"/>
      <stop offset=".15" stop-color="#a8801f"/>
      <stop offset=".24" stop-color="#8a6a1e"/>
      <stop offset=".30" stop-color="#241a06"/>
      <stop offset=".35" stop-color="#cbb573"/>
      <stop offset=".42" stop-color="#8a6a1e"/>
      <stop offset=".52" stop-color="#6e5518"/>
      <stop offset=".60" stop-color="#241a06"/>
      <stop offset=".66" stop-color="#c0a45c"/>
      <stop offset=".72" stop-color="#5e4714"/>
      <stop offset=".82" stop-color="#3e2f0c"/>
      <stop offset=".90" stop-color="#1e1505"/>
      <stop offset="1" stop-color="#080502"/>`;

  /** 页面级 defs：渐变 + 角饰/宝石/卷草的可复用图形（页面只注入一份） */
  const DEFS = `
<svg id="${DEFS_ID}" width="0" height="0" aria-hidden="true" focusable="false"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <linearGradient id="frBandTop" x1="0" y1="0" x2="0" y2="1">${PROFILE}</linearGradient>
    <linearGradient id="frBandBottom" x1="0" y1="1" x2="0" y2="0">${PROFILE}</linearGradient>
    <linearGradient id="frBandLeft" x1="0" y1="0" x2="1" y2="0">${PROFILE}</linearGradient>
    <linearGradient id="frBandRight" x1="1" y1="0" x2="0" y2="0">${PROFILE}</linearGradient>

    <!-- 斜向抛光：左上受光、右下压暗，金属才有"面" -->
    <linearGradient id="frSheen" x1="0" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#fff8dc" stop-opacity=".22"/>
      <stop offset=".26" stop-color="#fff8dc" stop-opacity=".05"/>
      <stop offset=".55" stop-color="#000000" stop-opacity=".14"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".38"/>
    </linearGradient>

    <!-- 角徽章的凹座：径向渐隐的暗影，让徽章像"嵌进"金属而不是浮在上面。
         用渐变淡出（而不是实心大圆）是为了绝不越出外轮廓。 -->
    <radialGradient id="frSeat">
      <stop offset=".6" stop-color="#0a0602" stop-opacity=".55"/>
      <stop offset=".82" stop-color="#0a0602" stop-opacity=".26"/>
      <stop offset="1" stop-color="#0a0602" stop-opacity="0"/>
    </radialGradient>

    <!-- 画窗内影：很轻的一圈，让插画"嵌进去"（旧版 16px 黑内阴影太重，整张卡发灰） -->
    <radialGradient id="frVig" cx=".5" cy=".46" r=".78">
      <stop offset=".58" stop-color="#000" stop-opacity="0"/>
      <stop offset=".84" stop-color="#000" stop-opacity=".16"/>
      <stop offset="1" stop-color="#000" stop-opacity=".44"/>
    </radialGradient>

    <!-- 金属托座（角徽章与宝石金托共用） -->
    <radialGradient id="frBoss" cx=".33" cy=".26" r=".85">
      <stop offset="0" stop-color="#fffdf4"/>
      <stop offset=".20" stop-color="#f2e2a6"/>
      <stop offset=".46" stop-color="#c9a227"/>
      <stop offset=".72" stop-color="#8a6d1d"/>
      <stop offset=".92" stop-color="#4a380c"/>
      <stop offset="1" stop-color="#2e2306"/>
    </radialGradient>

    <!-- 宝石：台面亮、腰部深、边缘压暗 -->
    <radialGradient id="frStone" cx=".36" cy=".28" r=".8">
      <stop offset="0" stop-color="#ffd2d9"/>
      <stop offset=".18" stop-color="#ef5b70"/>
      <stop offset=".48" stop-color="#bc1a31"/>
      <stop offset=".8" stop-color="#7a0d1e"/>
      <stop offset="1" stop-color="#3a0410"/>
    </radialGradient>

    <!-- 四角浮雕：凹座 + **凹边四芒星**（不是同心圆 —— 圆形读数像"画了个靶"，
         凹边星有雕刻感）+ 中央宝石 + 两颗沿框带的铆钉。
         星形半径刻意只到 6.3：斜接缝要在星外侧与内侧各露出一段，占满角区就看不见缝了。
         只画左上角，其余三角 use + 镜像（几何完全对称） -->
    <g id="frCorner">
      <circle cx="3.5" cy="3.5" r="3.55" fill="url(#frSeat)"/>
      <path d="M3.5 0.62 Q4.14 2.86 6.38 3.5 Q4.14 4.14 3.5 6.38 Q2.86 4.14 0.62 3.5 Q2.86 2.86 3.5 0.62 Z"
            fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".42"/>
      <path d="M3.5 1.15 Q4 2.98 5.85 3.5 Q4 4.02 3.5 5.85 Q3 4.02 1.15 3.5 Q3 2.98 3.5 1.15 Z"
            fill="none" stroke="#fff3c8" stroke-width=".22" opacity=".42"/>
      <path d="M3.5 2.3 Q3.72 3.28 4.7 3.5 Q3.72 3.72 3.5 4.7 Q3.28 3.72 2.3 3.5 Q3.28 3.28 3.5 2.3 Z"
            fill="#2a1e06" opacity=".55"/>
      <circle cx="3.5" cy="3.5" r=".92" fill="url(#frStone)"/>
      <circle cx="3.5" cy="3.5" r=".92" fill="none" stroke="#2a0209" stroke-width=".18" opacity=".7"/>
      <ellipse cx="3.24" cy="3.22" rx=".32" ry=".2" fill="#fff" opacity=".8" transform="rotate(-30 3.24 3.22)"/>
      <circle cx="6.05" cy="3.5" r=".38" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".18"/>
      <circle cx="3.5" cy="6.05" r=".38" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".18"/>
    </g>

    <!-- 顶部宝石：八边台面切面 + 腰线 + 四个镶爪 + 高光 + 底部投影 -->
    <g id="frGem">
      <ellipse cx="0" cy=".85" rx="3.2" ry="2.4" fill="#100b02" opacity=".6"/>
      <circle r="2.95" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".45"/>
      <circle r="2.95" fill="none" stroke="#fff3c8" stroke-width=".2" opacity=".4"/>
      <path d="M-1.9 -1.9 L-1.05 -2.62 L1.05 -2.62 L1.9 -1.9 L1.9 1.9 L1.05 2.62 L-1.05 2.62 L-1.9 1.9 Z"
            fill="url(#frStone)" stroke="#200106" stroke-width=".24"/>
      <path d="M-1.9 -1.05 L-1.05 -1.05 M-1.9 1.05 L-1.05 1.05 M1.9 -1.05 L1.05 -1.05 M1.9 1.05 L1.05 1.05"
            stroke="#ff9aa8" stroke-width=".2" opacity=".3"/>
      <path d="M-1.05 -1.28 L-0.6 -2.05 L0.6 -2.05 L1.05 -1.28 L1.05 1.28 L0.6 2.05 L-0.6 2.05 L-1.05 1.28 Z"
            fill="none" stroke="#ffe4e8" stroke-width=".18" opacity=".4"/>
      <path d="M-1.05 -2.62 L-1.05 -1.28 M0 -2.62 V-2.05 M1.05 -2.62 L1.05 -1.28 M-1.9 -1.9 L-1.05 -1.28 M1.9 -1.9 L1.05 -1.28 M-1.9 1.9 L-1.05 1.28 M1.9 1.9 L1.05 1.28 M0 2.62 V2.05"
            stroke="#ffdde2" stroke-width=".16" opacity=".34"/>
      <ellipse cx="-.82" cy="-.9" rx=".66" ry=".42" fill="#fff" opacity=".78" transform="rotate(-30 -.82 -.9)"/>
      <circle cx="1.02" cy="1.12" r=".28" fill="#fff" opacity=".3"/>
      <path d="M-2.35 -2.35 q-.5 -.9 .35 -1.5" fill="none" stroke="url(#frBoss)" stroke-width=".7"/>
      <path d="M2.35 -2.35 q.5 -.9 -.35 -1.5" fill="none" stroke="url(#frBoss)" stroke-width=".7"/>
      <path d="M-2.35 2.35 q-.5 .9 .35 1.5" fill="none" stroke="url(#frBoss)" stroke-width=".7"/>
      <path d="M2.35 2.35 q.5 .9 -.35 1.5" fill="none" stroke="url(#frBoss)" stroke-width=".7"/>
    </g>

    <!-- 底部卷草：左右对称双卷 + 中央宝石。先描暗边再压亮线 = 双线錾刻 -->
    <g id="frFlourish">
      <path d="M-9.2 1.4 q3 -3.4 6.2 -1 q2 1.7 2.5 .2 q.5 -1.7 -1.9 -2 q-3.3 -.5 -6.8 2.8" fill="none" stroke="#120c02" stroke-width="1.5" opacity=".55"/>
      <path d="M-9.2 1.4 q3 -3.4 6.2 -1 q2 1.7 2.5 .2 q.5 -1.7 -1.9 -2 q-3.3 -.5 -6.8 2.8" fill="none" stroke="#f6ecc4" stroke-width=".62" opacity=".9"/>
      <path d="M-9.2 1.4 q3 -3.4 6.2 -1 q2 1.7 2.5 .2 q.5 -1.7 -1.9 -2 q-3.3 -.5 -6.8 2.8" fill="none" stroke="#8a6d1d" stroke-width=".22" opacity=".6"/>
      <path d="M9.2 1.4 q-3 -3.4 -6.2 -1 q-2 1.7 -2.5 .2 q-.5 -1.7 1.9 -2 q3.3 -.5 6.8 2.8" fill="none" stroke="#120c02" stroke-width="1.5" opacity=".55"/>
      <path d="M9.2 1.4 q-3 -3.4 -6.2 -1 q-2 1.7 -2.5 .2 q-.5 -1.7 1.9 -2 q3.3 -.5 6.8 2.8" fill="none" stroke="#f6ecc4" stroke-width=".62" opacity=".9"/>
      <path d="M9.2 1.4 q-3 -3.4 -6.2 -1 q-2 1.7 -2.5 .2 q-.5 -1.7 1.9 -2 q3.3 -.5 6.8 2.8" fill="none" stroke="#8a6d1d" stroke-width=".22" opacity=".6"/>
      <circle cx="0" cy="0" r=".95" fill="url(#frStone)" stroke="#120c02" stroke-width=".24"/>
      <ellipse cx="-.28" cy="-.32" rx=".34" ry=".22" fill="#fff" opacity=".75"/>
    </g>

    <!-- 框带中段的小菱形铆钉（顶边两颗 + 左右边各两颗），让长边不至于空旷 -->
    <g id="frStud">
      <path d="M0 -1.5 L1.15 0 L0 1.5 L-1.15 0 Z" fill="url(#frBoss)" stroke="#0f0b04" stroke-width=".26"/>
      <path d="M0 -1.5 L1.15 0 L0 1.5 L-1.15 0 Z" fill="none" stroke="#fff3c8" stroke-width=".16" opacity=".45"/>
      <path d="M-.42 -.55 L.42 -.55 L0 0 Z" fill="#fff" opacity=".3"/>
    </g>
  </defs>
</svg>`;

  /** 单张卡的框：四条斜接梯形（横截面渐变）+ 刻槽/凸轨描边 + 抛光高光 + 角徽章 + 宝石 + 卷草 + 铆钉 + 画窗内影 */
  const FRAME = `
<svg class="fr-svg" viewBox="0 0 100 150" preserveAspectRatio="none"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     aria-hidden="true" focusable="false">
  <path d="M0 0 H100 L93 7 H7 Z" fill="url(#frBandTop)"/>
  <path d="M0 150 H100 L93 143 H7 Z" fill="url(#frBandBottom)"/>
  <path d="M0 0 L7 7 V143 L0 150 Z" fill="url(#frBandLeft)"/>
  <path d="M100 0 L93 7 V143 L100 150 Z" fill="url(#frBandRight)"/>
  <path d="M0 0 H100 V150 H0 Z M7 7 H93 V143 H7 Z" fill="url(#frSheen)" fill-rule="evenodd"/>
  <g fill="none">
    <rect x=".25" y=".25" width="99.5" height="149.5" stroke="#060402" stroke-width=".5"/>
    <rect x="2.1" y="2.1" width="95.8" height="145.8" stroke="#2a1e06" stroke-width=".55" opacity=".85"/>
    <rect x="2.48" y="2.48" width="95.04" height="145.04" stroke="#cbb573" stroke-width=".42" opacity=".6"/>
    <rect x="4.2" y="4.2" width="91.6" height="141.6" stroke="#2a1e06" stroke-width=".5" opacity=".8"/>
    <rect x="4.62" y="4.62" width="90.76" height="140.76" stroke="#c0a45c" stroke-width=".34" opacity=".5"/>
    <!-- 斜接缝：真画框四条线脚在角上以 45° 相接。徽章盖住中段，外/内两段露出来 -->
    <path d="M0 0 L7 7 M100 0 L93 7 M0 150 L7 143 M100 150 L93 143" stroke="#120d04" stroke-width=".55" opacity=".85"/>
    <path d="M0.25 -0.25 L7.25 6.75 M99.75 -0.25 L92.75 6.75 M-0.25 149.75 L6.75 142.75 M100.25 149.75 L93.25 142.75"
          stroke="#e8d9a4" stroke-width=".3" opacity=".4"/>
    <rect x="6.5" y="6.5" width="87" height="137" rx="1.7" stroke="#f0e0b0" stroke-width=".45" opacity=".5"/>
    <rect x="6.9" y="6.9" width="86.2" height="136.2" rx="1.6" stroke="#070502" stroke-width="1.6"/>
  </g>
  <use href="#frCorner" xlink:href="#frCorner"/>
  <use href="#frCorner" xlink:href="#frCorner" transform="translate(100 0) scale(-1 1)"/>
  <use href="#frCorner" xlink:href="#frCorner" transform="translate(0 150) scale(1 -1)"/>
  <use href="#frCorner" xlink:href="#frCorner" transform="translate(100 150) scale(-1 -1)"/>
  <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(23 3.5)"/>
  <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(77 3.5)"/>
  <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(3.5 47) rotate(90)"/>
  <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(3.5 103) rotate(90)"/>
  <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(96.5 47) rotate(90)"/>
  <use class="fr-stud" href="#frStud" xlink:href="#frStud" transform="translate(96.5 103) rotate(90)"/>
  <use href="#frGem" xlink:href="#frGem" transform="translate(50 3.6)"/>
  <use href="#frFlourish" xlink:href="#frFlourish" transform="translate(50 146.4)"/>
  <rect x="7" y="7" width="86" height="136" rx="1.6" fill="url(#frVig)"/>
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

  const api = { html, ensureDefs, DEFS, FRAME, DEFS_ID, VIEW, BAND, WINDOW_RX };
  root.CardFrame = api;
  // 用 typeof 守卫而不是 root.module：被 require 的模块里 globalThis.module 是 undefined，
  // root.module 那条路永远不会执行（require 只会拿到空对象）。浏览器里没有 module，
  // typeof 判断让它整行不执行。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
