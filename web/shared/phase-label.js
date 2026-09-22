/**
 * phase-label.js — 对局阶段中文名的**唯一真值**（桌面 app.js 与手机 m.js 共用同一份）
 *
 * 为什么需要它：两端原来各写一张**逐字相同**的阶段表（`const PHASE_LABEL = { setup: '开局', … }`，
 * 8 个键、8 条文案）。两张表没有任何门禁对拍，单边改一个字（"天亮" → "黎明"）不会有任何测试发现 ——
 * 同一个阶段在电脑与手机上叫两个名字，而这恰恰是"两端同一套信息架构"最容易被悄悄破坏的地方。
 * 现在收敛成一份：两端各留一行
 *     const PHASE_LABEL = window.WWPhaseLabel.PHASE_LABEL;
 * 引用的是**同一个文件里的同一个对象**（不是两份拷贝）；键集合与文案由 test/phase-label.test.js
 * 用一份冻结台账逐字钉住，单边改文案 / 删键 / 加键都会判红。
 *
 * 键的来源：服务端引擎的阶段枚举（`src/engine/render.js` 另有一张同为这 8 个键的 Node 侧表，
 * 供 AI 上下文渲染用）。浏览器不能 require 服务端模块，所以这里按**同一套键**另存一份；
 * 两端这一份只负责"阶段值 → 中文名"的展示映射，不含任何业务流程。
 *
 * 契约（与 web/shared/ 下其它模块同一套写法）：
 *   · 零依赖、无副作用：不碰 DOM、不碰 localStorage、不发请求；
 *   · 未定义的阶段值由调用方自己兜底（两端原本就是 `PHASE_LABEL[v.phase] || v.phase`），
 *     本模块**不**提供"猜一个名字"的默认值 —— 未知阶段原样透出比编一个名字诚实。
 */
'use strict';
(function (global) {
  /**
   * 阶段值 → 中文名。键与文案是**冻结契约**：改任何一条都要同步
   * test/phase-label.test.js 的 FROZEN 台账（那是防止单边漂移的那道门）。
   */
  const PHASE_LABEL = {
    setup: '开局', night: '夜晚', dawn: '天亮', sheriff: '警长竞选',
    speech: '白天发言', vote: '放逐投票', pk: 'PK 环节', over: '结算',
  };

  const api = { PHASE_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWPhaseLabel = api;
})(typeof window !== 'undefined' ? window : globalThis);
