/**
 * errors.js — 跨层共用的错误类型（放在中立层，避免 engine 反向依赖 ai）
 */
'use strict';

/**
 * LLM 侧不可重试的致命错误：配额耗尽 / 套餐权限受限 / 鉴权失败。
 * 语义：重试无意义，且**绝不能降级**（降级＝随机票＝一局烂棋），应暂停对局并明示原因。
 */
class LlmFatalError extends Error {
  constructor({ kind = 'policy', code = '', message = '', nextFlushTime = null } = {}) {
    super(message || `LLM 不可用（${kind}${code ? ' ' + code : ''}）`);
    this.name = 'LlmFatalError';
    this.fatal = true;
    this.kind = kind;                 // 'quota' | 'policy'
    this.code = code;                 // 服务商业务码，如 1308 / 1313
    this.nextFlushTime = nextFlushTime; // 配额重置时间（若服务商给出）
    this.retryable = false;
  }
}

/**
 * 对局因外部原因暂停：既不是结束，也不是判负。
 * 沿流程栈解到 runGame 即停止驱动，状态与锚点原样保留，等待恢复。
 */
class GamePaused extends Error {
  constructor(info = {}) {
    super('对局已暂停');
    this.name = 'GamePaused';
    this.code = 'GAME_PAUSED';
    this.info = info;
  }
}

module.exports = { LlmFatalError, GamePaused };
