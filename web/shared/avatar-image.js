/**
 * avatar-image.js — 自定义头像的**浏览器端**共享实现（M1 §4.1 第 2/3/4/7 条）
 *
 * 桌面 `web/app.js` 与手机 `web/m/m.js` 只保留"画在哪块 DOM"的差异，选图预检、裁切几何、
 * PNG 编码、体积守卫、HTTP 请求形状全部收在这里一份。这样"两端行为一致"是结构上的事实，
 * 而不是靠两处代码碰巧写得一样（改造前 `AVATAR_EMOJI` 就是这样长成两份的）。
 *
 * ── 服务端已经做过的事（本模块不重复实现，只对齐常量）────────────────────
 * 体积 >0 且 ≤2MiB、PNG 签名与 IHDR、**恰好 512×512**、只收 8-bit RGB(2)/RGBA(6)、
 * 拒绝畸形/截断、先算 SHA-256 再落盘、并**剥离 tEXt/zTXt/iTXt/eXIf/tIME 等块**
 * （见 `src/profiles/avatar.js`，那里是唯一判据）。
 * ⚠ 因此：服务端算出的哈希可能与你上传的 PNG 哈希**不同**，取图 URL 必须用**服务端返回的
 * `avatarUrl`**，绝不能自己拼上传时的哈希。本模块只提供 `mergeAvatarResult()` 把响应并回本地。
 *
 * ── 为什么解码走 `createImageBitmap` 而不是 `<img src=blob:>` ──────────────
 * 服务端 HTML 带 CSP `img-src 'self'`（`src/static.js:101`）：`blob:` 与 `data:` 的图片 URL
 * 会被浏览器**直接拦掉**，`<img>` 只会触发 error（表现为"选了图没反应/破图"）。
 * `createImageBitmap(file)` 直接解码 File 的字节，不经过 URL 加载，因此不受 `img-src` 约束，
 * 也不需要把用户图片变成 data-URI 常驻内存。裁切预览一律画在 `<canvas>` 上（canvas 不受 CSP 限制）。
 *
 * ── 2 MiB 那条文案的现实性（如实标注）──────────────────────────────────
 * 输出的 512×512 8-bit RGBA 未压缩只有 1 MiB，PNG 压缩后**实际上不可能**超过 2 MiB
 * （最高约 1.05 MiB）。所以 `checkEncodedSize` 是一条**防御性**守卫：它可被单测直接命中，
 * 但浏览器里跑不出真实超限样本 —— 报告里如实写明，不假装它经常触发。
 * 它的价值在于把"超限就必须拒绝、绝不许偷偷降采样/降色深"变成一条**可注入、可判红**的判据。
 */
'use strict';
(function (global) {
  /* ---------------------------------------------------------------- 常量 */

  /** 客户端预检上限：原始文件体积（§4.1 第 2 条） */
  const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
  /** 客户端预检上限：原始图片任一边长（§4.1 第 2 条） */
  const MAX_SOURCE_DIM = 8192;
  /** 产出边长：与服务端唯一允许的 512×512 一致（src/profiles/avatar.js 的 AVATAR_SIZE） */
  const OUTPUT_SIZE = 512;
  /** 产出体积上限：与服务端的 MAX_AVATAR_BYTES 一致（2 MiB） */
  const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
  const AVATAR_MIME = 'image/png';
  /** 上传时必须**精确**等于 image/png（带任何参数如 `; charset=utf-8` 会被服务端 415 拒） */
  const AVATAR_CONTENT_TYPE = 'image/png';
  /** 可选的来源格式；`image/jpg` 是部分 Windows 环境报出的非标准别名，仍是 JPEG */
  const ACCEPT_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp';

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.25;

  /** §4.1 第 4 条原文文案：超限时**必须**给出这一句，且不得自动降质 */
  const OVER_LIMIT_TEXT = '请选择更简单的图片或重新裁切';

  /* ---------------------------------------------------------------- 文案 */

  const MSG = {
    type: (t) => `只支持 PNG / JPEG / WebP 图片（当前：${t || '未知类型'}）`,
    empty: '图片是空文件（0 字节），请重新选择',
    tooBig: (size) => `图片超过 10 MiB（实际 ${(size / 1048576).toFixed(1)} MiB），请先压缩或换一张`,
    decode: '图片无法解码（文件可能损坏，或并不是真正的 PNG / JPEG / WebP）',
    noDecoder: '这个浏览器不支持本地图片解码（createImageBitmap 不可用），无法裁切头像',
    badDims: (w, h) => `图片尺寸异常（${w}×${h}），无法裁切`,
    dimsTooLarge: (w, h) => `图片尺寸 ${w}×${h} 超过 ${MAX_SOURCE_DIM}px 上限，请先缩小后再选`,
    encodeFailed: '图片编码失败（浏览器没能生成 PNG），原头像保持不变',
    encodedEmpty: '编码后的图片是空的，请换一张图片重试',
    tooLargeEncoded: OVER_LIMIT_TEXT,
  };

  /* ------------------------------------------------------- 预检（§4.1 第 2 条） */

  /** 原始文件的类型/体积预检。**在读盘解码之前**跑，不满足要给明确原因，绝不静默失败。 */
  function classifyFile(file) {
    const type = String((file && file.type) || '').trim().toLowerCase();
    const size = Number(file && file.size);
    if (!ACCEPT_MIME.includes(type)) return { ok: false, code: 'type', message: MSG.type(type) };
    if (!Number.isFinite(size) || size <= 0) return { ok: false, code: 'empty', message: MSG.empty };
    if (size > MAX_SOURCE_BYTES) return { ok: false, code: 'too-big', message: MSG.tooBig(size) };
    return { ok: true, type, bytes: size };
  }

  /** 解码后的宽高预检（§4.1 第 2 条：宽高均不超过 8192px）。 */
  function classifyDimensions(dim) {
    const w = Number(dim && dim.width);
    const h = Number(dim && dim.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return { ok: false, code: 'dimensions', message: MSG.badDims(w || 0, h || 0) };
    }
    if (w > MAX_SOURCE_DIM || h > MAX_SOURCE_DIM) {
      return { ok: false, code: 'dimensions-too-large', message: MSG.dimsTooLarge(w, h) };
    }
    return { ok: true, width: w, height: h };
  }

  /** 释放 ImageBitmap 占用的内存（不支持 close 的环境静默跳过） */
  function releaseBitmap(bitmap) {
    try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) { /* 忽略 */ }
  }

  /**
   * 解码一个 File/Blob（走 createImageBitmap，见文件头"为什么"）。
   * 解码器可注入，便于在 Node 里单测失败路径。
   */
  async function decodeSource(file, opts) {
    const o = opts || {};
    // 走 global.createImageBitmap（而不是裸标识符）：共享模块在 Node 下也要能被 require，
    // 这样既不需要 eslint 的 browser globals 白名单，也不会在 Node 里炸出 ReferenceError。
    const cib = o.createImageBitmap || (typeof global.createImageBitmap === 'function' ? global.createImageBitmap : null);
    if (typeof cib !== 'function') return { ok: false, code: 'no-decoder', message: MSG.noDecoder };
    let bitmap = null;
    try {
      bitmap = await cib(file);
    } catch (_) {
      return { ok: false, code: 'decode-failed', message: MSG.decode };
    }
    if (!bitmap || !(Number(bitmap.width) > 0) || !(Number(bitmap.height) > 0)) {
      releaseBitmap(bitmap);
      return { ok: false, code: 'decode-failed', message: MSG.decode };
    }
    return { ok: true, bitmap, width: Number(bitmap.width), height: Number(bitmap.height) };
  }

  /**
   * 完整预检：类型/体积 → 解码 → 宽高。任一步失败都返回**同一个形状**的拒绝
   * （`{ok:false, stage, code, message}`），调用方照 message 渲染即可。
   * @param opts.sizeOf / opts.typeOf 可覆盖取值方式（单测用纯对象即可，不必造 File）
   */
  async function prepareSource(file, opts) {
    const o = opts || {};
    const shape = {
      type: o.typeOf ? o.typeOf(file) : (file && file.type),
      size: o.sizeOf ? o.sizeOf(file) : (file && file.size),
    };
    const c1 = classifyFile(shape);
    if (!c1.ok) return { ok: false, stage: 'file', ...c1 };
    const dec = await decodeSource(file, o);
    if (!dec.ok) return { ok: false, stage: 'decode', ...dec };
    const c2 = classifyDimensions(dec);
    if (!c2.ok) {
      releaseBitmap(dec.bitmap);
      return { ok: false, stage: 'dimensions', ...c2, width: dec.width, height: dec.height };
    }
    return { ok: true, bitmap: dec.bitmap, width: dec.width, height: dec.height, type: c1.type, bytes: c1.bytes };
  }

  /* ---------------------------------------------------- 裁切几何（§4.1 第 3 条） */

  const clamp = (v, a, b) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));

  /**
   * 取一个有限数，否则回落默认值。
   * ⚠ 不能直接写 `Number.isFinite(Number(v))`：`Number(null) === 0`、`Number('') === 0`
   * 都是"有限数"，于是 `{cx: null}` 会被当成 cx=0 而把视图甩到左上角（而不是居中）。
   * 空值必须按"没给"处理。
   */
  function finiteOr(v, dflt) {
    if (v === null || v === undefined || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  function clampZoom(z) {
    return clamp(finiteOr(z, MIN_ZOOM), MIN_ZOOM, MAX_ZOOM);
  }

  /** "居中覆盖"（cover）的基准倍率：短边刚好铺满输出方框 */
  function baseScale(srcW, srcH, outSize) {
    const out = Number(outSize) > 0 ? Number(outSize) : OUTPUT_SIZE;
    return Math.max(out / Number(srcW), out / Number(srcH));
  }

  /**
   * 视图状态 = `{ zoom, cx, cy }`，其中 **cx/cy 是裁切窗中心在原图像素坐标系里的位置**。
   * 用"窗口中心"而不是"左上角偏移"当状态，是因为它天然适合缩放（绕当前视图中心缩放，
   * 而不是绕原图中心跳一下）与边界收敛（夹到 `[half, srcW-half]` 即可）。
   *
   * 返回值把派生量一起算好（scale / window），调用方不必重复推导，也就不会两处算法分叉。
   * 所有输入都先做有限性检查：NaN / 缺字段一律回落到"居中、1 倍"。
   */
  function viewOf(srcW, srcH, outSize, view) {
    const w = Number(srcW);
    const h = Number(srcH);
    const out = Number(outSize) > 0 ? Number(outSize) : OUTPUT_SIZE;
    const zoom = clampZoom(view && view.zoom);
    const scale = baseScale(w, h, out) * zoom;
    const win = out / scale; // 裁切窗边长（原图像素）
    const half = win / 2;
    return {
      zoom,
      scale,
      window: win,
      cx: clamp(finiteOr(view && view.cx, w / 2), half, w - half),
      cy: clamp(finiteOr(view && view.cy, h / 2), half, h - half),
    };
  }

  /** 初始视图：1 倍、居中覆盖（§4.1 第 3 条的"居中覆盖"就是这一支） */
  function initialView(srcW, srcH, outSize) {
    return viewOf(srcW, srcH, outSize, { zoom: MIN_ZOOM, cx: Number(srcW) / 2, cy: Number(srcH) / 2 });
  }

  /** 绕**当前视图中心**缩放（不是绕原图中心），缩放后仍然满足居中覆盖与边界收敛 */
  function zoomView(srcW, srcH, outSize, view, nextZoom) {
    const v = viewOf(srcW, srcH, outSize, view);
    return viewOf(srcW, srcH, outSize, { zoom: nextZoom, cx: v.cx, cy: v.cy });
  }

  /**
   * 拖动：`dxScreen/dyScreen` 是**显示画布的像素位移**（指针位移），换算成原图像素后
   * 反向移动裁切窗中心（手指往右拖 = 看到图片更靠左的部分）。
   */
  function dragView(srcW, srcH, outSize, view, dxScreen, dyScreen) {
    const v = viewOf(srcW, srcH, outSize, view);
    const dx = Number(dxScreen);
    const dy = Number(dyScreen);
    return viewOf(srcW, srcH, outSize, {
      zoom: v.zoom,
      cx: v.cx - (Number.isFinite(dx) ? dx : 0) / v.scale,
      cy: v.cy - (Number.isFinite(dy) ? dy : 0) / v.scale,
    });
  }

  /**
   * 交给 `drawImage` 的**源矩形**：边长恰好等于裁切窗覆盖的原图像素数，
   * 于是目标 512×512 一定是等比的（不会有拉伸/letterbox），这就是"居中覆盖裁成正方形"。
   */
  function sourceRect(srcW, srcH, outSize, view) {
    const v = viewOf(srcW, srcH, outSize, view);
    return { sx: v.cx - v.window / 2, sy: v.cy - v.window / 2, size: v.window, scale: v.scale };
  }

  /**
   * 把裁切结果画进一个方形画布（同一份几何，两端与预览共用）。
   * @param ctx 2D 上下文；`image` 只要有 width/height 且可被 drawImage 接受即可（含单测用的替身）
   * @returns 实际使用的源矩形；参数不可用时返回 null（调用方据此判失败）
   */
  function drawCrop(ctx, image, outSize, view) {
    const w = Number(image && image.width);
    const h = Number(image && image.height);
    const out = Number(outSize) > 0 ? Number(outSize) : OUTPUT_SIZE;
    if (!ctx || typeof ctx.drawImage !== 'function' || !(w > 0) || !(h > 0)) return null;
    const r = sourceRect(w, h, out, view);
    if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, out, out);
    ctx.drawImage(image, r.sx, r.sy, r.size, r.size, 0, 0, out, out);
    return r;
  }

  /* ---------------------------------------------- 编码与体积守卫（§4.1 第 3/4 条） */

  /** canvas → PNG Blob（**重新编码本身就会丢掉 EXIF/GPS 等元数据**，§4.1 第 3 条） */
  function canvasToPngBlob(canvas, toBlob) {
    const fn = toBlob || (canvas && typeof canvas.toBlob === 'function' ? canvas.toBlob.bind(canvas) : null);
    if (typeof fn !== 'function') return Promise.reject(new Error(MSG.encodeFailed));
    return new Promise((resolve) => {
      let settled = false;
      const done = (blob) => { if (!settled) { settled = true; resolve(blob || null); } };
      try {
        // 第三个参数保持默认：PNG 是无损格式，没有"质量"可调 —— 也就不存在悄悄降质的空间
        fn((blob) => done(blob), AVATAR_MIME);
      } catch (_) { done(null); }
    });
  }

  /**
   * 产出体积守卫（§4.1 第 4 条）。**绝不自动降采样/降色深**：
   * 超限就是超限，把原文文案交回调用方，由玩家决定"换图或重新裁切"。
   */
  function checkEncodedSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, code: 'empty', bytes: 0, message: MSG.encodedEmpty };
    if (n > MAX_AVATAR_BYTES) return { ok: false, code: 'too-large', bytes: n, message: MSG.tooLargeEncoded };
    return { ok: true, bytes: n };
  }

  function defaultCreateCanvas(w, h) {
    const c = (typeof document !== 'undefined' ? document : null);
    if (!c) throw new Error('没有可用的 document，无法创建画布');
    const canvas = c.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  /**
   * 裁切 → 编码 → 体积守卫，**一条流水线、只编码一次**。
   *
   * 为什么把三者放在同一个函数里：§4.1 第 4 条禁止"偷偷降到不可控画质" —— 如果编码与守卫分开写，
   * "编码一次超限 → 缩到 256 再编码一次"这种补丁就会很自然地长出来。放在一起之后，
   * 单测可以直接钉住 `{canvases: 1, encodes: 1}`：任何"再试一次更小尺寸"的改动都会让它变红。
   *
   * @param cfg.image        已解码的图源（ImageBitmap 或任何 drawImage 可接受物）
   * @param cfg.view         视图状态 {zoom,cx,cy}
   * @param cfg.outSize      产出边长（默认 512）
   * @param cfg.canvas       复用调用方已有的画布（裁切页的展示画布就是它，省一次拷贝）
   * @param cfg.createCanvas 画布工厂（单测注入，用来数"到底创建了几张画布"）
   * @param cfg.encode       编码器 (canvas) => Promise<Blob>（单测注入）
   */
  async function produceAvatar(cfg) {
    const c = cfg || {};
    const outSize = Number(c.outSize) > 0 ? Number(c.outSize) : OUTPUT_SIZE;
    const canvas = c.canvas || (c.createCanvas || defaultCreateCanvas)(outSize, outSize);
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    const rect = drawCrop(ctx, c.image, outSize, c.view);
    if (!rect) return { ok: false, code: 'draw-failed', message: MSG.encodeFailed, outSize };
    let blob = null;
    try {
      blob = await (c.encode ? c.encode(canvas) : canvasToPngBlob(canvas));
    } catch (_) { blob = null; }
    if (!blob) return { ok: false, code: 'encode-failed', message: MSG.encodeFailed, outSize };
    const size = Number(blob.size);
    const check = checkEncodedSize(size);
    if (!check.ok) return { ok: false, code: check.code, message: check.message, bytes: size, outSize, blob: null };
    return { ok: true, blob, bytes: size, outSize, rect };
  }

  /* -------------------------------------------------- HTTP 形状（§4.3 三个窄接口） */

  /**
   * `X-Profile-Revision` 只接受整数：给了非法整数服务端会 400。
   * 拿不到合法整数就**不带**这个头（服务端允许缺省），而不是发一个会被拒的值。
   *
   * 判据与 `src/api.js:110` 的 `parseProfileRevisionHeader()` **逐条同判**：
   * 服务端是 `Number(String(raw).trim())` 且要求 `Number.isInteger(n) && n >= 0`。
   * 因此这里也必须拒掉负数 —— 客户端发 `-3` 只会换来一次 400，整个保存失败；
   * 少一次并发校验（服务端把"缺省"当"不校验"）远好过保存直接报错。
   */
  function revisionHeader(revision) {
    if (revision === null || revision === undefined) return null;
    const raw = String(revision).trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return null;
    return String(n);
  }

  /**
   * `PUT /api/profiles/:id/avatar` 的请求形状。
   *
   * 两个**必须**在这里钉住的事实（服务端 `readAvatarBody` 的原文判据）：
   *   · `Content-Type` 精确为 `image/png` —— 带 `; charset=utf-8` 之类的参数会被 415 拒；
   *   · body 是**原始 PNG 字节**，不是 JSON、不是 base64。
   */
  function buildAvatarPut(cfg) {
    const c = cfg || {};
    const headers = { 'Content-Type': AVATAR_CONTENT_TYPE };
    const rev = revisionHeader(c.revision);
    if (rev !== null) headers['X-Profile-Revision'] = rev;
    return {
      url: `/api/profiles/${encodeURIComponent(String(c.profileId))}/avatar`,
      init: { method: 'PUT', headers, body: c.body },
    };
  }

  /** `DELETE /api/profiles/:id/avatar`（语义是"改用内置头像"：服务端不动 avatarId） */
  function buildAvatarDelete(cfg) {
    const c = cfg || {};
    const headers = {};
    const rev = revisionHeader(c.revision);
    if (rev !== null) headers['X-Profile-Revision'] = rev;
    return {
      url: `/api/profiles/${encodeURIComponent(String(c.profileId))}/avatar`,
      init: { method: 'DELETE', headers },
    };
  }

  /** 发一次请求并把 JSON 错误体翻成带 status 的 Error（错误一律是 JSON，不会是 HTML） */
  async function send(fetchImpl, req) {
    const res = await fetchImpl(req.url, req.init);
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  const putAvatar = (fetchImpl, cfg) => send(fetchImpl, buildAvatarPut(cfg));
  const deleteAvatar = (fetchImpl, cfg) => send(fetchImpl, buildAvatarDelete(cfg));

  /**
   * 把 `{ profile, avatarUrl }` 并回本地的档案摘要列表。
   *
   * ⚠ 这一步不是可选的搬运：`setAvatar` 返回的 `profile` 是 profile.json 的**原文**，
   * 里面**没有** `avatarUrl` 字段（`avatarUrl` 只在 `list()` 与这两个接口的**顶层**由
   * `avatarUrlOf()` 补出来）。若直接用 `resp.profile` 覆盖本地那条，`avatarUrl` 就丢了，
   * 界面随即回落成内置徽记 —— 表现为"提示保存成功，头像却没变"。
   * 所以这里显式把顶层 avatarUrl 挂上去再合并；DELETE 时它是 `null`，于是下一帧按
   * 档案自己的 `avatarId` 显示内置徽记（§4.1 第 6 条"绝不能回退成破图"）。
   *
   * @returns 合并后的那条（含 avatarUrl）；响应形状不对时返回 null
   */
  function mergeAvatarResult(profiles, resp) {
    const list = profiles || [];
    const p = resp && resp.profile;
    if (!p || !p.id) return null;
    const merged = { ...p, avatarUrl: (resp && resp.avatarUrl) || null };
    const i = list.findIndex((x) => x && x.id === p.id);
    if (i >= 0) list[i] = { ...list[i], ...merged };
    else list.push(merged);
    return merged;
  }

  const api = {
    MAX_SOURCE_BYTES, MAX_SOURCE_DIM, OUTPUT_SIZE, MAX_AVATAR_BYTES,
    AVATAR_MIME, AVATAR_CONTENT_TYPE, ACCEPT_MIME, ACCEPT_ATTR,
    MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, OVER_LIMIT_TEXT, MSG,
    classifyFile, classifyDimensions, decodeSource, prepareSource, releaseBitmap,
    clampZoom, baseScale, viewOf, initialView, zoomView, dragView, sourceRect, drawCrop,
    canvasToPngBlob, checkEncodedSize, produceAvatar,
    revisionHeader, buildAvatarPut, buildAvatarDelete, putAvatar, deleteAvatar, mergeAvatarResult,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWAvatarImage = api;
})(typeof window !== 'undefined' ? window : globalThis);
