/**
 * tokens.js — 提示词的 token 估算
 *
 * 单独成文件是为了打破一个循环依赖：`context.js` 要调用 `memory.js` 做记忆检索，
 * 而检索必须按 token 预算取舍，两边都需要估算函数。**唯一实现**，
 * 不允许各处再抄一份（抄出来的第二份一旦和第一份不一致，预算就会算错，且很难发现）。
 *
 * 旧算法是 `len / 1.5`（假设 1.5 字/token）。对 GLM 系中文，实测更接近 **1 字 ≈ 1 token**，
 * 也就是旧算法**系统性低估约 1.5 倍**：预算写 12000，实际塞进去接近 18000 ——
 * 后果不只是"更贵/更慢"，而是**裁剪决策跟着一起错**：
 * 该留的当天发言被裁掉、该折叠的十天前死讯却留着（详见 docs/fluency-plan.md B3）。
 *
 * 新算法按字符类别估，并且**一律向上取整、宁可估大**：
 *   · CJK 汉字/假名/全角标点：1 字 ≈ 1 token
 *   · ASCII：4 字符 ≈ 1 token
 *   · 其余（拉丁扩展/一般标点/emoji 等）：2 字符 ≈ 1 token
 * 估大的代价是"少放一点内容"，估小的代价是"超预算 + 裁错"，两害相权取前者。
 */
'use strict';

/** 是否为"一字一 token"的表意文字/全角字符 */
function isWide(c) {
  return (
    (c >= 0x3000 && c <= 0x303f) ||   // CJK 标点
    (c >= 0x3040 && c <= 0x30ff) ||   // 平假名/片假名
    (c >= 0x3400 && c <= 0x4dbf) ||   // CJK 扩展 A
    (c >= 0x4e00 && c <= 0x9fff) ||   // CJK 基本区
    (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容表意
    (c >= 0xff00 && c <= 0xffef) ||   // 全角形式
    (c >= 0x20000 && c <= 0x2ebef)    // CJK 扩展 B~F
  );
}

/** 中文为主文本的 token 估算（保守偏大，宁可少放内容也不要超预算） */
function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let wide = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (isWide(c)) wide++;
    else if (c < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(wide + ascii / 4 + other / 2);
}

module.exports = { estimateTokens, isWide };
