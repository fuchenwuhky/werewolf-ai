/**
 * rng.js — 可播种、可快照/恢复的伪随机源（mulberry32）。
 *
 * 为什么引擎需要它：
 *  1. 断点恢复是"从锚点重放整个阶段"。只要阶段内有 `Math.random()`，重放出的发言顺序/平票抽签/
 *     技能询问顺序就会变 → 决策点错位 → 决策 journal（P1-1）永远命不中，恢复也会真的重打一遍 LLM。
 *  2. 验收要求"同配置可复现同一局"，随机性必须可控。
 *
 * 实现只需 32 位整数状态，因此可以整体塞进锚点快照里，恢复时精确续上。
 */
'use strict';

/** 由字符串派生 32 位种子（用于"同一 gameId 得到同一牌局"） */
function seedFrom(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小、快、分布够用；返回函数带 state()/restore() 以便快照 */
function makeRng(seed = 1) {
  let s = (Number(seed) >>> 0) || 1;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.state = () => s;
  rng.restore = (v) => { s = (Number(v) >>> 0) || 1; return rng; };
  return rng;
}

module.exports = { makeRng, seedFrom };
