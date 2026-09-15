/**
 * tokens.js — 提示词的 token 估算
 *
 * 单独成文件是为了打破一个循环依赖：`context.js` 要调用 `memory.js` 做记忆检索，
 * 而检索必须按 token 预算取舍，两边都需要估算函数。
 * 估计算法是"中文为主、GLM 约 1.5~1.8 字/token，取保守值"——**唯一实现**，
 * 不允许各处再抄一份（抄出来的第二份一旦和第一份不一致，预算就会算错，且很难发现）。
 */
'use strict';

/** 中文为主文本的 token 估算（保守偏大，宁可少放内容也不要超预算） */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 1.5);
}

module.exports = { estimateTokens };
