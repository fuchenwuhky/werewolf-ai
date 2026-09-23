#!/usr/bin/env node
/**
 * png-stats.js —— 零依赖 PNG 像素统计：判定一张截图是"真界面"还是"空白帧"。
 *
 * 为什么要有它（事故记录）：
 *   Android 真机验证脚本原先只看"前台 Activity 是不是目标包"就截图，结果在 MuMu 上拍到的是
 *   **启动窗口的背景色**：整张 1920x1080 有 99.90% 的像素是同一个 RGBA(241,240,244,255)，
 *   看图软件里就是一片纯白。更糟的是我早期用"文件必须大于 20000 字节"当判据 —— 它其实**报了红**，
 *   我却在另一次假红时把它降级成"只记录不判据"，等于掐掉了唯一说真话的信号。
 *   所以这里改成直接看**像素**：解 IHDR、拼 IDAT、inflate、逐行解滤波，再统计出现最多的那个像素色占比。
 *   判据：最高频像素占比 > 99% ⇒ 空白帧（正常界面不会被一个颜色占掉 99%）。
 *
 * 用法：
 *   node scripts/png-stats.js docs/evidence            # 递归扫目录
 *   node scripts/png-stats.js a.png b.png              # 指定文件
 *   PNG_STAT_QUIET=1 node scripts/png-stats.js docs/evidence   # 单行输出，便于汇总
 *
 * 退出码：0 = 全部是有效画面；1 = 存在空白帧或读取失败（每条都打印原因与占比）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** 解码 PNG（仅 8bit RGB/RGBA，覆盖 screencap 与 CDP 截图的输出）→ {w,h,bpp,pixels} */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf[0] !== 0x89 || buf.slice(1, 4).toString('latin1') !== 'PNG') {
    return { error: '不是 PNG' };
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return { error: `暂只支持 8bit 的 RGB/RGBA（本图 colorType=${colorType} bitDepth=${bitDepth}）` };
  }
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return { error: 'inflate 失败：' + e.message }; }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) return { error: `数据不足：${raw.length} < ${h * (stride + 1)}` };
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const base = y * (stride + 1);
    const ft = raw[base];
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[base + 1 + x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      cur[x] = v;
    }
    cur.copy(px, y * stride);
    prev = cur;
  }
  return { w, h, bpp, colorType, pixels: px };
}

/** 统计：最高频像素色及其占比、唯一色数、全透明像素占比，并给出判定 */
function statsOf(buf) {
  const d = decodePng(buf);
  if (d.error) return { error: d.error, blank: true };
  const { w, h, bpp, colorType, pixels } = d;
  const n = w * h;
  const hist = new Map();
  let alphaZero = 0;
  let sumR = 0; let sumG = 0; let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * bpp;
    const r = pixels[o]; const g = pixels[o + 1]; const b = pixels[o + 2];
    const key = colorType === 6 ? r + ',' + g + ',' + b + ',' + pixels[o + 3] : r + ',' + g + ',' + b;
    hist.set(key, (hist.get(key) || 0) + 1);
    if (colorType === 6 && pixels[o + 3] === 0) alphaZero += 1;
    sumR += r; sumG += g; sumB += b;
  }
  let modalKey = ''; let modalCount = 0;
  for (const [k, v] of hist) if (v > modalCount) { modalCount = v; modalKey = k; }
  const modalShare = modalCount / n;
  const transparent = /,0$/.test(modalKey);
  // 阈值为何是 25%：实测数据说话。
  //   · 190 张已交付截图里，**正常界面的最高频像素占比上限只有 8.08%**（唯一色 2893~17405）；
  //   · 而 MuMu 上"应用刚起、界面还没画完"的帧是 96.02%（唯一色 503），启动窗口背景是 99.90%（唯一色 42）。
  // 一开始我定的是 99%，结果 96% 那种半成品帧照样通过（实测漏放了一张 21KB 的深色空图）——
  // 所以要卡在 8.08% 与 96% 之间：取 25%，离正常上限有 3 倍余量，离半成品帧也有 3.8 倍余量。
  const blank = modalShare > 0.25;
  return {
    w, h, bytes: buf.length, pixels: n,
    modal: 'RGBA(' + modalKey + ')', modalShare,
    alphaZeroShare: colorType === 6 ? alphaZero / n : 0,
    distinct: hist.size,
    avg: [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)],
    blank,
    reason: blank
      ? '最高频像素 ' + ((modalShare * 100).toFixed(2)) + '%' + (transparent ? '（且为全透明）' : '') + ' ⇒ 空白/未画完帧（阈值 25%）'
      : '有画面内容（最高频 ' + ((modalShare * 100).toFixed(2)) + '%）',
  };
}

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name), out);
  else if (/\.png$/i.test(p)) out.push(p);
  return out;
}

function main() {
  const files = [];
  for (const a of process.argv.slice(2)) {
    try { walk(a, files); } catch (e) { console.error('跳过 ' + a + '：' + e.message); }
  }
  if (!files.length) { console.error('用法：node scripts/png-stats.js <文件或目录> [...]'); process.exit(2); }
  const quiet = process.env.PNG_STAT_QUIET === '1';
  let bad = 0; const blanks = [];
  for (const f of files) {
    let s;
    try { s = statsOf(fs.readFileSync(f)); } catch (e) { s = { error: String(e && e.message || e), blank: true }; }
    const name = f.split(/[\\/]/).slice(-2).join('/');
    if (s.error) { console.log('✗ ' + name + '\n    ' + s.error); bad += 1; blanks.push(name); continue; }
    if (quiet) {
      console.log((s.blank ? 'BLANK' : 'OK   ') + ' ' + (s.modalShare * 100).toFixed(2).padStart(6) + '%  ' + String(s.distinct).padStart(6) + '色  ' + name);
    } else {
      console.log((s.blank ? '✗' : '✓') + ' ' + name + '  ' + s.w + 'x' + s.h + '  ' + s.bytes + 'B  唯一色=' + s.distinct + '  平均色=(' + s.avg.join(',') + ')');
      console.log('    最高频 ' + s.modal + ' 占 ' + (s.modalShare * 100).toFixed(2) + '%（全透明像素占 ' + (s.alphaZeroShare * 100).toFixed(2) + '%）');
      console.log('    → ' + s.reason);
    }
    if (s.blank) { bad += 1; blanks.push(name); }
  }
  console.log('\n合计 ' + files.length + ' 张：有画面内容 ' + (files.length - bad) + ' 张，空白或读取失败 ' + bad + ' 张');
  if (blanks.length) console.log('问题清单：\n  ' + blanks.join('\n  '));
  process.exit(bad ? 1 : 0);
}

module.exports = { decodePng, statsOf };
if (require.main === module) main();
