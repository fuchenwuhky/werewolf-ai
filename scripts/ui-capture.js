/**
 * ui-capture.js —— 把 ui-check 的真实截图落到**仓内**目录，并逐张核对"名称 / 路由 / 视口"三者一致。
 *
 * 为什么需要它：scripts/ui-check.js:37 把截图硬编码写到 logs/ui-shots/，而 logs/ 是 gitignore 的运行时目录；
 * docs/construction-status-and-guidance-2026-09-23.md:203-205 明确"忽略目录里的截图是审查证据、不是随 Git 交付的资产"，
 * :195 又要求"每批提交至少 1440x900、390x844 的真实新截图，且截图名称、路由、当前页面必须一致"。
 * 所以这里既做搬运，也做**可复跑的核对**：从 PNG 的 IHDR 读真实宽高（零依赖），与文件名声明的视口逐个比对，
 * 任何一张不符就整体判失败（退出码 1），不生成"看起来对"的证据。
 *
 * 用法：node scripts/ui-capture.js [--batch C2] [--apply]
 *   不带 --apply 时只做核对与预演（打印计划），带 --apply 才写入 docs/evidence/<batch>/。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname ? path.join(__dirname, '..') : process.cwd();
const SRC = path.join(ROOT, 'logs', 'ui-shots');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BATCH = argOf('--batch', 'C2');
const APPLY = process.argv.includes('--apply');
const DEST = path.join(ROOT, 'docs', 'evidence', BATCH);

/** 零依赖读 PNG 宽高：签名 8 字节 + 长度 4 + 'IHDR' 4，随后 4 字节宽、4 字节高（大端）。 */
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    const n = fs.readSync(fd, head, 0, 24, 0);
    if (n < 24) return null;
    if (head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } finally { fs.closeSync(fd); }
}

/**
 * 路由/页面登记：按**文件名前缀**匹配（ui-check 的真实命名形如 `18-1440x900-desktop-profile.png`、
 * `R03-390x844-手机玩家中心控件.png`、`R04-历史分页-首屏.png`）。视口一律从名字里的 NNNxNNN 解析，
 * 不在这里重复声明 —— 声明与实测对不上时下面会直接判失败。
 */
const PREFIX = [
  ['18-', { route: '/', page: 'desktop-profile-center' }],
  ['19a-', { route: '/', page: 'desktop-avatar-crop' }],
  ['19b-', { route: '/', page: 'desktop-avatar-after-delete' }],
  ['R03-', { route: '/m/', page: 'mobile-profile-center-controls' }],
  ['R04-', { route: '/', page: 'desktop-history-paging' }],
  // R05 这张拍的是「玩家档案」列表（其中有一局未结束），不是"归档被拦"的现场：
  // 拦截提示走的是 alert，而 ui-check 把 alert 打了桩，页面上没有可见弹窗。
  // 页面名跟着改成画面真实内容，避免登记表里再出现一处名不副实。
  ['R05-', { route: '/', page: 'desktop-profiles-with-running-game' }],
  ['14-', { route: '/m/', page: 'mobile-game-320x568' }],
  ['15-', { route: '/m/', page: 'mobile-home-320x568' }],
  ['16-', { route: '/m/', page: 'mobile-profile-320x568' }],
  ['17-', { route: '/m/', page: 'mobile-profile-center-390x844' }],
  ['07a-', { route: '/', page: 'desktop-midgame' }],
  ['07-final-', { route: '/', page: 'desktop-final-coach' }],
  ['07b-', { route: '/', page: 'desktop-flip' }],
  ['07c-', { route: '/', page: 'desktop-flip-open' }],
  ['13-r01-', { route: '/', page: 'desktop-setup-pendingid' }],
  ['13-mobile-', { route: '/m/', page: 'mobile-game' }],
  ['12-empty-knife-', { route: '/', page: 'desktop-refuse-empty-knife' }],
  ['12b-', { route: '/', page: 'desktop-annotation-deleted' }],
  ['08-', { route: '/', page: 'desktop-coach-text' }],
  ['10-', { route: '/', page: 'desktop-resume-card' }],
  // 余下前缀按 ui-check 的实际命名补齐：不补就会落到 unregistered__root__…
  // （那样只有实测视口与源文件名可核，路由与页面名这条证据是弱的）。
  ['01-', { route: '/', page: 'desktop-loading-guard' }],
  ['02-', { route: '/', page: 'desktop-setup-top' }],
  ['02b-', { route: '/', page: 'desktop-setup-lower' }],
  ['02c-', { route: '/', page: 'desktop-codex' }],
  ['02d-', { route: '/', page: 'desktop-codex-dynamic' }],
  ['03-', { route: '/', page: 'desktop-english' }],
  ['04-', { route: '/', page: 'desktop-offline' }],
  ['05-', { route: '/m/', page: 'mobile-boards' }],
  ['06-', { route: '/m/', page: 'mobile-rules' }],
  ['06b-', { route: '/m/', page: 'mobile-codex' }],
  ['06c-', { route: '/m/', page: 'mobile-codex-detail' }],
  ['06d-', { route: '/m/', page: 'mobile-codex-page2' }],
  ['06e-', { route: '/m/', page: 'mobile-profile-trash' }],
  ['09-', { route: '/', page: 'desktop-trash-empty' }],
  ['09b-', { route: '/', page: 'desktop-trash-list' }],
  ['09c-', { route: '/', page: 'desktop-trash-restored' }],
  ['09d-', { route: '/', page: 'desktop-trash-after-fail' }],
  ['13b-', { route: '/m/', page: 'mobile-gear-settings' }],
  ['13c-', { route: '/m/', page: 'mobile-summary' }],
  ['13d-', { route: '/m/', page: 'mobile-esc-close' }],
  ['13e-', { route: '/m/', page: 'mobile-annotation-cleared' }],
  ['20a-', { route: '/m/', page: 'mobile-avatar-crop' }],
  ['20b-', { route: '/m/', page: 'mobile-avatar-after-delete' }],
  // D 批（M4 局中精修）出图点：跨宽度切换（1024 宽屏档 / 960 抽屉档）与长内容（长笔记）。
  // 全部 route 都是对局屏（就是根路由里的 #screen-game），页面名写清是哪一种宽度与形态。
  ['M4-1024x900-', { route: '/', page: 'desktop-game-wide-3col' }],
  ['M4-960x900-midgame-drawer-open', { route: '/', page: 'desktop-game-960-drawer-open' }],
  ['M4-960x900-', { route: '/', page: 'desktop-game-960-drawer' }],
  ['M4-long-', { route: '/', page: 'desktop-game-long-note' }],
  // E 批（M5/M6）Android 真机档：MuMu 上启动已装包后由 adb screencap 取的真机截图。
  // 它不属于 1440x900 / 390x844 这两档，实测为 1920x1080（当时设备是横屏）——
  // 硬档判据按区间（桌面宽 ≥1280、手机宽 ≤430）计算，这一张自然落在桌面档，不需要特例。
  ['EMU-', { route: '/', page: 'device-mumu-android12-app' }],
  ['emu-', { route: '/', page: 'device-mumu-android12-app' }],
];
const metaOf = (f) => { const hit = PREFIX.find(([p]) => f.startsWith(p)); return hit ? hit[1] : {}; };

function plan() {
  if (!fs.existsSync(SRC)) {
    console.error('✗ 找不到截图源目录：' + SRC + '（先跑 scripts/ui-check.js --full --strict）');
    return 1;
  }
  const files = fs.readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  if (!files.length) { console.error('✗ ' + SRC + ' 里没有 PNG'); return 1; }

  const rows = [];
  let bad = 0;
  for (const f of files) {
    const size = pngSize(path.join(SRC, f));
    const m = /(\d{3,4})x(\d{3,4})/.exec(f);
    const declared = m ? { w: Number(m[1]), h: Number(m[2]) } : null;
    const meta = metaOf(f);
    const route = meta.route || null;
    const page = meta.page || null;
    const reasons = [];
    if (!size) reasons.push('不是可解析的 PNG');
    // guidance :195 只要求"截图名称、路由、当前页面一致"（防止张冠李戴），并不要求视口写进文件名；
    // 实测宽高（PNG 头）本身才是最客观的证据，所以这里不再因"名字没写视口"判废。
    // 名字里若声明了视口，则必须与实测一致（声明不该是假的）。
    if (size && declared && (size.w !== declared.w || size.h !== declared.h)) {
      reasons.push('实测 ' + size.w + 'x' + size.h + ' 与文件名声明 ' + declared.w + 'x' + declared.h + ' 不符');
    }
    // 空白/未画完帧一律判废（事故记录）：真机那张 1920x1080 有 99.90% 的像素是同一个 RGBA(241,240,244,255)，
    // 看图软件衬白底就是一片纯白 —— 它却因为"PNG 有效、宽高对得上"蒙混进仓过。
    // 判据必须是像素而不是文件字节数（我早期那版看字节数，还把报警降级成了只记录，等于没判）。
    if (size) {
      const { statsOf } = require('./png-stats.js');
      const st = statsOf(fs.readFileSync(path.join(SRC, f)));
      if (st.error) reasons.push('像素统计失败：' + st.error);
      else if (st.blank) reasons.push(st.reason);
    }
    if (reasons.length) bad += 1;
    rows.push({ f, size, declared, route, page, reasons });
  }

  // 硬档按**区间**判定：真实桌面内视口实测为 1418x802（窗口/滚动条所致），要求整值 1440x900 会永远判缺；
  // 手机档同理按宽度归并（390x844 / 390x700 / 320x568 都算手机档）。判据只看实测宽高。
  const isDesktopTier = (s) => s.w >= 1280 && s.h >= 700;
  const isMobileTier = (s) => s.w <= 430 && s.h >= 480;
  const rowsOk = rows.filter((r) => !r.reasons.length && r.size);
  const missing = [];
  if (!rowsOk.some((r) => isDesktopTier(r.size))) missing.push('桌面档（实测宽 ≥1280）');
  if (!rowsOk.some((r) => isMobileTier(r.size))) missing.push('手机档（实测宽 ≤430）');

  console.log('源目录：' + SRC + '（' + files.length + ' 张）');
  rows.forEach((r) => {
    const dim = r.size ? r.size.w + 'x' + r.size.h : '?';
    const tag = r.reasons.length ? '✗' : '✓';
    console.log('  ' + tag + ' ' + r.f + '  实测=' + dim + ' 路由=' + (r.route || '?') + ' 页面=' + (r.page || '?')
      + (r.reasons.length ? '  ← ' + r.reasons.join('；') : ''));
  });
  if (missing.length) console.log('  ✗ 缺少 guidance :195 的强制档：' + missing.join('、'));

  if (!APPLY) { console.log('（预演模式：加 --apply 才写盘；当前不合规 ' + bad + ' 张）'); return bad || missing.length ? 1 : 0; }

  fs.mkdirSync(DEST, { recursive: true });
  let wrote = 0;
  let seq = 0;
  for (const r of rows) {
    if (r.reasons.length) continue;
    seq += 1;
    // 目标文件名一律用**实测**宽高（declared 仅强制档保证非空）；page/route 对未登记前缀会缺省，
    // 这里必须自己兜底，否则 .replace 会撞 null（上一版就是这两个空指针把 --apply 打死）。
    const page = r.page || 'unregistered';
    const routeKey = (r.route || '/').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
    // 末段追加**源文件名主干**：三段的"页面__路由__实测视口"对未登记前缀会重名，
    // 上一版就因此静默覆盖（45 张源图只落下 22 个不同名字），还会让"写入 N 张"的计数失真。
    const stem = r.f.replace(/\.png$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
    // 序号段：中文名主干会被压成下划线，同前缀同视口的两张就会重名 —— 序号天然唯一，
    // 并让"源图 ↔ 落盘文件"一一对应可核对（上一版正因缺这一段而覆盖掉 1 张）。
    const seqTag = String(seq).padStart(2, '0');
    const dst = path.join(DEST, seqTag + '-' + page + '__' + routeKey + '__' + r.size.w + 'x' + r.size.h + '__' + stem + '.png');
    fs.copyFileSync(path.join(SRC, r.f), dst);
    wrote += 1;
  }
  // 自查：**落盘文件数**必须等于合规源图数。上一版只统计拷贝次数，于是命名碰撞静默覆盖后
  // 仍然报"已写入 44 张"（实际只有 22 个文件）—— 这条守卫就是为了不再让这种事通过。
  const onDisk = fs.readdirSync(DEST).filter((f) => f.toLowerCase().endsWith('.png')).length;
  const expect = rows.filter((r) => !r.reasons.length).length;
  console.log('已写入 ' + DEST + '：拷贝 ' + wrote + ' 次，落盘 ' + onDisk + ' 个文件，合规源图 ' + expect + ' 张');
  if (onDisk !== expect) {
    console.error('✗ 落盘文件数与合规源图数不一致（命名碰撞会静默覆盖）—— 视为失败');
    return 1;
  }
  return bad || missing.length ? 1 : 0;
}

process.exit(plan());
