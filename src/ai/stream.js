/**
 * stream.js — 把"流式原始增量"变成可以直接展示给玩家的文本。
 *
 * 背景（用户反馈："AI 输出消息的时候会先出现 text 标签，等全部输入完才消失"）：
 * AI 的回复被 JSON schema 约束（见 schemas.js），所以 `delta.content` 累加出来的
 * 原始缓冲长这样：
 *
 *     {"text":"我是好人，昨晚过得很平静…","explode":false,"target":0}
 *
 * 模型是一个字一个字吐的，于是玩家先看到的是 `{"text":"我` 这种**壳子**，
 * 等整段输出完、正式解析成事件之后才"变正常"——中间那段就是出戏的来源。
 *
 * 这里只做一件很小的事：从半成品 JSON 里把 `text` 字段的值取出来（并还原转义）。
 * 还没吐到 `text` 的值就返回空串，让界面显示"正在思考…"而不是半个壳子。
 *
 * 刻意不去"猜"整个 JSON：解析半成品 JSON 必然失败，只能做定向提取。
 */
'use strict';

/** 键名 + 冒号 + 起始引号（容忍空格；键名固定是小写 text，见 schemas.js 的 TEXT） */
const TEXT_KEY = /"text"\s*:\s*"/;

/**
 * 还原 JSON 字符串字面量（可能还没闭合）。
 * 遇到**未转义**的收尾引号就停：后面的 `","explode":false}` 属于别的字段，不能带出来。
 * 跑到字符串末尾还没闭合 → 说明模型还在吐这一段，返回已收到的部分。
 */
function unescapePartial(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return out; // 未转义的引号 = 值结束
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) return out; // 反斜杠后还没吐出来，先不显示
    if (n === 'n') { out += '\n'; i++; continue; }
    if (n === 't') { out += '\t'; i++; continue; }
    if (n === 'r') { out += '\r'; i++; continue; }
    if (n === 'b') { out += '\b'; i++; continue; }
    if (n === 'f') { out += '\f'; i++; continue; }
    if (n === 'u') {
      const hex = s.slice(i + 2, i + 6);
      // \uXXXX 还没吐全：先不显示，等下一个增量
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    // \" \\ \/ 以及其它转义：原样取反斜杠后的字符
    out += n;
    i++;
  }
  return out;
}

/**
 * 从流式缓冲里取出可展示文本。
 * @param {string} raw 模型原始增量（`{"text":"…` 这种半成品 JSON）
 * @returns {string} 可以直接显示的人话；还取不到就是 ''
 */
function extractLiveText(raw) {
  if (!raw) return '';
  const s = String(raw);
  const m = TEXT_KEY.exec(s);
  if (m) return unescapePartial(s.slice(m.index + m[0].length));
  // 还没吐到 text 的值：只要开头像 JSON（`{`、`{"`、`{"te`…）就什么都别显示。
  // 有些模型会先说一句人话再给 JSON，那种情况原样显示前半句更自然。
  if (/^\s*[{[]/.test(s)) return '';
  return s;
}

module.exports = { extractLiveText, unescapePartial };
