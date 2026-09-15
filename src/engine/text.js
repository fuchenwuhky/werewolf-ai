/**
 * text.js — 引擎侧纯文本工具（不依赖任何 AI 模块，见 lint 规则 engine-no-ai）
 *
 * 用途：把**玩家可自行填写的短文本**（昵称、人格标签等）清洗成能安全嵌进提示词结构行的形式。
 * 这些字段会出现在 `3号Alice` 这样的结构行里，换行或结构标记会直接破坏提示词版面，
 * 甚至让玩家伪造出"【局面快照】/【系统指令】"这类结构行。
 *
 * 注意分工：本模块只管"单行字段"；玩家**发言正文**的 Spotlighting（带校验码的标记块）
 * 在 src/ai/spotlight.js —— 那属于 AI 上下文组装的事，引擎不需要知道。
 */
'use strict';

/** 结构标记字符：玩家文本里出现即剔除（这些字符只应由引擎自己写出来） */
const STRUCTURAL_CHARS = /[【】〔〕\[\]{}]/g;

/**
 * 单行化 + 剔除结构标记 + 截断。
 * @param {*} text 原始文本（null/undefined → 空串）
 * @param {number} maxLen 截断长度
 */
function sanitizeInline(text, maxLen = 20) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ') // 控制字符与行分隔符
    .replace(STRUCTURAL_CHARS, '')
    .replace(/[◆─]{2,}/g, '')                                   // 结构行符号
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

module.exports = { sanitizeInline };
