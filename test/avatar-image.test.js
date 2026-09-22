/**
 * avatar-image.test.js — 自定义头像的浏览器端共享实现（M1 §4.1 第 2/3/4/7 条）
 *
 * 桌面 web/app.js 与手机 web/m/m.js 共用这一份。这里在 Node 下把**所有不依赖真实浏览器**的
 * 部分逐条钉住：预检顺序与文案、cover 裁切几何、编码与体积守卫、HTTP 请求形状、响应合并。
 *
 * 三条最要紧的性质（也是反向注入要打的三条）：
 *   ① 预检必须在**解码之前**拦住超限/超尺寸的文件（否则"先解码一张 20000×20000 的图"会卡死页面）；
 *   ② 删除自定义头像后必须仍然按档案自己的 `avatarId` 显示内置徽记（`avatarUrl=null` 不是"什么都不显示"）；
 *   ③ 产出超 2 MiB 时**只能拒绝**，绝不许偷偷降采样/降色深 —— 用"恰好创建 1 张画布、恰好编码 1 次"钉住。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const M = require('../web/shared/avatar-image');
const { makeDataDir, makeApiIn, terminateAfter } = require('./helpers-tmpdir');
const png = require('./helpers-png');

const MiB = 1024 * 1024;

/** 计数用的解码器替身 */
function decodeStub({ width = 1000, height = 800, fail = false, calls } = {}) {
  return async () => {
    if (calls) calls.n++;
    if (fail) throw new Error('boom');
    return { width, height, close() { if (calls) calls.closed++; } };
  };
}

/** 计数用的 2D 上下文替身：只记录 drawImage 的实参 */
function ctxStub() {
  const drawn = [];
  return {
    drawn,
    clearRect() { },
    drawImage(...args) { drawn.push(args); },
  };
}

/** 计数用的画布替身 */
function canvasStub({ encode = null, noCtx = false } = {}) {
  const ctx = ctxStub();
  const canvas = {
    width: 0, height: 0,
    encodes: 0,
    getContext: () => (noCtx ? null : ctx),
    _ctx: ctx,
    toBlob(cb) { canvas.encodes++; Promise.resolve().then(() => cb(encode || { size: 4096 })); },
  };
  return canvas;
}

/* ------------------------------------------------- 常量与服务端对齐（同一个判据的两个副本） */

test('常量与服务端一致：512 输出、2MiB 上限、精确 image/png、10MiB/8192px 预检', () => {
  const server = require('../src/profiles/avatar');
  assert.strictEqual(M.OUTPUT_SIZE, server.AVATAR_SIZE, '产出边长必须等于服务端唯一允许的 512');
  assert.strictEqual(M.MAX_AVATAR_BYTES, server.MAX_AVATAR_BYTES, '体积上限必须与服务端同一数值');
  assert.strictEqual(M.AVATAR_CONTENT_TYPE, server.AVATAR_MIME, 'Content-Type 必须与服务端期望逐字相同');
  assert.strictEqual(M.MAX_SOURCE_BYTES, 10 * MiB);
  assert.strictEqual(M.MAX_SOURCE_DIM, 8192);
  assert.deepStrictEqual(M.ACCEPT_MIME.slice(0, 3), ['image/png', 'image/jpeg', 'image/jpg']);
  assert.ok(M.ACCEPT_MIME.includes('image/webp'));
  assert.deepStrictEqual([M.MIN_ZOOM, M.MAX_ZOOM, M.ZOOM_STEP], [1, 4, 0.25]);
  assert.strictEqual(M.OVER_LIMIT_TEXT, '请选择更简单的图片或重新裁切', '§4.1 第 4 条原文文案');
});

/* ------------------------------------------------------------------ ① 预检 */

test('预检·类型：只收 PNG/JPEG/WebP，其余给出明确原因（不静默失败）', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'IMAGE/PNG', ' image/png ']) {
    assert.strictEqual(M.classifyFile({ type, size: 1024 }).ok, true, `${type} 应当被接受`);
  }
  for (const type of ['image/gif', 'image/svg+xml', 'text/plain', '', null, undefined]) {
    const r = M.classifyFile({ type, size: 1024 });
    assert.strictEqual(r.ok, false, `${String(type)} 必须被拒绝`);
    assert.strictEqual(r.code, 'type');
    assert.match(r.message, /PNG \/ JPEG \/ WebP/, '文案必须说清收哪几种');
    assert.ok(r.message.length > 8, '文案必须可读，不能是空串');
  }
});

test('预检·体积：空文件与超过 10MiB 都要拒，文案带实际数值', () => {
  assert.strictEqual(M.classifyFile({ type: 'image/png', size: 10 * MiB }).ok, true, '恰好 10MiB 应当通过（上限是"不超过"）');
  const over = M.classifyFile({ type: 'image/png', size: 10 * MiB + 1 });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.code, 'too-big');
  assert.match(over.message, /10 MiB/);
  assert.match(over.message, /10\.0 MiB/, '要带上实际体积，玩家才知道差多少');
  for (const size of [0, -1, NaN, undefined, null, 'abc']) {
    const r = M.classifyFile({ type: 'image/png', size });
    assert.strictEqual(r.ok, false, `size=${String(size)} 必须被拒绝`);
    assert.strictEqual(r.code, 'empty');
    assert.match(r.message, /空文件/);
  }
  assert.strictEqual(M.classifyFile(undefined).ok, false, '连文件都没有时同样给可读拒绝');
});

test('预检·尺寸：宽高都要 ≤8192，异常尺寸不留 NaN 文案', () => {
  assert.strictEqual(M.classifyDimensions({ width: 8192, height: 8192 }).ok, true);
  assert.strictEqual(M.classifyDimensions({ width: 8192, height: 1 }).ok, true);
  const wide = M.classifyDimensions({ width: 8193, height: 100 });
  assert.strictEqual(wide.ok, false);
  assert.strictEqual(wide.code, 'dimensions-too-large');
  assert.match(wide.message, /8193×100/);
  assert.match(wide.message, /8192px/);
  const tall = M.classifyDimensions({ width: 100, height: 9000 });
  assert.strictEqual(tall.code, 'dimensions-too-large', '只看宽度是不够的');
  for (const dim of [{ width: 0, height: 10 }, { width: 10, height: 0 }, { width: -5, height: 5 }, {}, { width: NaN, height: 5 }]) {
    const r = M.classifyDimensions(dim);
    assert.strictEqual(r.ok, false, `${JSON.stringify(dim)} 必须被拒绝`);
    assert.strictEqual(r.code, 'dimensions');
    assert.ok(!/NaN|undefined/.test(r.message), `文案不得出现 NaN/undefined：「${r.message}」`);
  }
});

test('预检·解码：失败/空结果都要给可读原因，且不抛出去', async () => {
  const bad = await M.decodeSource({}, { createImageBitmap: decodeStub({ fail: true }) });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'decode-failed');
  assert.match(bad.message, /无法解码/);

  const zero = await M.decodeSource({}, { createImageBitmap: async () => ({ width: 0, height: 0, close() { } }) });
  assert.strictEqual(zero.ok, false);
  assert.strictEqual(zero.code, 'decode-failed');

  const none = await M.decodeSource({}, { createImageBitmap: null });
  assert.strictEqual(none.ok, false, '环境没有解码器时也必须明确说"不能裁切"，而不是假装成功');

  const ok = await M.decodeSource({}, { createImageBitmap: decodeStub({ width: 640, height: 480 }) });
  assert.deepStrictEqual([ok.ok, ok.width, ok.height], [true, 640, 480]);
});

test('预检·顺序：超限文件在**解码之前**就被拦住（不得先解码一张超大图）', async () => {
  const calls = { n: 0, closed: 0 };
  const r = await M.prepareSource({ type: 'image/png', size: 12 * MiB }, { createImageBitmap: decodeStub({ calls }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'file');
  assert.strictEqual(r.code, 'too-big');
  assert.strictEqual(calls.n, 0, '预检必须排在解码之前 —— 否则大图会先把页面拖死');

  const calls2 = { n: 0, closed: 0 };
  const r2 = await M.prepareSource({ type: 'image/png', size: 12 * MiB }, { createImageBitmap: decodeStub({ calls: calls2 }) });
  assert.strictEqual(r2.stage, 'file');
  assert.strictEqual(calls2.closed, 0);
});

test('预检·顺序：尺寸超限在解码之后判，并把已解码的位图释放掉（不漏内存）', async () => {
  const calls = { n: 0, closed: 0 };
  const r = await M.prepareSource({ type: 'image/png', size: 1024 }, { createImageBitmap: decodeStub({ width: 20000, height: 100, calls }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'dimensions');
  assert.strictEqual(r.code, 'dimensions-too-large');
  assert.strictEqual(calls.n, 1, '宽高只能解码后才知道 —— 这一步必然已经解码');
  assert.strictEqual(calls.closed, 1, '拒绝时必须 close()，否则每选一次大图就漏一块位图');
  assert.strictEqual(M.releaseBitmap({ close() { throw new Error('x'); } }), undefined, 'close 抛错也不得冒泡');
  assert.strictEqual(M.releaseBitmap(null), undefined);
});

test('预检·成功路径：类型/体积/宽高都通过时返回位图与原始信息', async () => {
  const r = await M.prepareSource({ type: 'image/webp', size: 2048 }, { createImageBitmap: decodeStub({ width: 3000, height: 2000 }) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.width, r.height, r.type, r.bytes], [3000, 2000, 'image/webp', 2048]);
  assert.ok(r.bitmap);
});

/* --------------------------------------------------------- ② 裁切几何（cover） */

test('居中覆盖：横图/竖图/方图在 1 倍下都是"短边铺满、长边居中"', () => {
  const land = M.sourceRect(1024, 512, 512, M.initialView(1024, 512, 512));
  assert.deepStrictEqual([land.sx, land.sy, land.size], [256, 0, 512], '横图：横向居中、纵向铺满');
  const port = M.sourceRect(512, 1024, 512, M.initialView(512, 1024, 512));
  assert.deepStrictEqual([port.sx, port.sy, port.size], [0, 256, 512], '竖图：纵向居中、横向铺满');
  const square = M.sourceRect(800, 800, 512, M.initialView(800, 800, 512));
  assert.deepStrictEqual([square.sx, square.sy, square.size], [0, 0, 800], '方图：整张都是裁切窗');
});

test('源矩形永远是正方形（等比，不会被拉成椭圆/拉伸）', () => {
  for (const [w, h] of [[1024, 512], [512, 1024], [3000, 2000], [100, 100], [1, 9000]]) {
    for (const zoom of [1, 1.75, 4]) {
      const r = M.sourceRect(w, h, 512, { zoom, cx: w / 2, cy: h / 2 });
      assert.ok(Math.abs(r.size) > 0, `${w}×${h}@${zoom} 的裁切窗不能退化成 0`);
    }
  }
});

test('缩放：绕当前视图中心缩放（不是绕原图中心跳一下），并夹在 [1,4]', () => {
  const base = M.initialView(1024, 512, 512);
  assert.strictEqual(base.zoom, 1);
  assert.strictEqual(M.clampZoom(0.2), 1, '不许缩到 1 倍以下（否则出现留白/letterbox）');
  assert.strictEqual(M.clampZoom(99), 4);
  assert.strictEqual(M.clampZoom(NaN), 1);
  assert.strictEqual(M.clampZoom('2.5'), 2.5, '字符串数字要能用（range 控件给的就是字符串）');

  // 先把视图拖到偏左，再放大：中心必须保持不动
  const dragged = M.dragView(1024, 512, 512, base, 200, 0);
  assert.ok(dragged.cx < base.cx, '向右拖 = 看到更靠左的内容');
  const zoomed = M.zoomView(1024, 512, 512, dragged, 2);
  assert.ok(Math.abs(zoomed.cx - dragged.cx) < 1e-9, '放大不得把视图中心甩走');
  assert.ok(Math.abs(zoomed.cy - dragged.cy) < 1e-9);
  assert.strictEqual(zoomed.window, dragged.window / 2, '2 倍 ⇒ 裁切窗边长减半');
});

test('拖动：位移按当前倍率换算，且夹在原图边界内（不会露出空白边）', () => {
  const base = M.initialView(1024, 512, 512);
  const moved = M.dragView(1024, 512, 512, base, 100, 0);
  assert.strictEqual(moved.cx, base.cx - 100, '1 倍时 1 屏幕像素 = 1 原图像素');
  const zoomed = M.zoomView(1024, 512, 512, base, 2);
  const moved2 = M.dragView(1024, 512, 512, zoomed, 100, 0);
  assert.strictEqual(moved2.cx, zoomed.cx - 50, '2 倍时同样的手指位移只走一半原图像素');

  const left = M.dragView(1024, 512, 512, base, 99999, 0);
  assert.strictEqual(left.cx, 256, '拖到最左：裁切窗左边贴住图片左边缘（cx = 半个窗）');
  const right = M.dragView(1024, 512, 512, base, -99999, 0);
  assert.strictEqual(right.cx, 768, '拖到最右：贴住右边缘');
  const up = M.dragView(512, 1024, 512, M.initialView(512, 1024, 512), 0, 99999);
  const down = M.dragView(512, 1024, 512, M.initialView(512, 1024, 512), 0, -99999);
  assert.deepStrictEqual([up.cy, down.cy], [256, 768], '竖图上下都能拖到边界（横轴则锁死居中）');
  const fixedX = M.dragView(1024, 512, 512, base, 500, 500);
  assert.strictEqual(fixedX.cy, 256, '横图纵轴没有余量：怎么拖都必须居中');
  assert.strictEqual(M.dragView(1024, 512, 512, base, NaN, 'x').cx, base.cx, '非法位移一律按 0 处理（不得产生 NaN 视图）');
});

test('viewOf：脏输入收敛成"1 倍居中"，绝不产出 NaN', () => {
  for (const v of [null, undefined, {}, { zoom: 'x', cx: 'y', cy: null }, { zoom: -3, cx: NaN, cy: Infinity }]) {
    const out = M.viewOf(1024, 512, 512, v);
    for (const k of ['zoom', 'scale', 'window', 'cx', 'cy']) {
      assert.ok(Number.isFinite(out[k]), `${JSON.stringify(v)} → ${k} 必须是有限数，实际 ${out[k]}`);
    }
    assert.strictEqual(out.zoom, 1);
    assert.strictEqual(out.cx, 512);
  }
});

test('drawCrop：把 sourceRect 交给 drawImage，参数不合法时返回 null（不抛）', () => {
  const ctx = ctxStub();
  const image = { width: 1024, height: 512 };
  const rect = M.drawCrop(ctx, image, 512, M.initialView(1024, 512, 512));
  assert.strictEqual(ctx.drawn.length, 1);
  assert.deepStrictEqual(ctx.drawn[0], [image, 256, 0, 512, 512, 0, 0, 512, 512]);
  assert.deepStrictEqual(rect, M.sourceRect(1024, 512, 512, M.initialView(1024, 512, 512)));
  assert.strictEqual(M.drawCrop(null, image, 512, M.initialView(1024, 512, 512)), null);
  assert.strictEqual(M.drawCrop(ctx, { width: 0, height: 10 }, 512, {}), null, '退化图源必须返回 null 而不是画一坨');
  assert.strictEqual(M.drawCrop({}, image, 512, {}), null, '没有 drawImage 的上下文必须返回 null');
});

/* --------------------------------------------- ③ 编码与体积守卫（不偷偷降质） */

test('体积守卫：恰好 2MiB 通过；超 1 字节就拒绝并用 §4.1 第 4 条原文文案', () => {
  assert.deepStrictEqual(M.checkEncodedSize(2 * MiB), { ok: true, bytes: 2 * MiB });
  const over = M.checkEncodedSize(2 * MiB + 1);
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.code, 'too-large');
  assert.strictEqual(over.message, M.OVER_LIMIT_TEXT);
  assert.strictEqual(over.message, '请选择更简单的图片或重新裁切');
  assert.strictEqual(M.checkEncodedSize(0).code, 'empty');
  assert.strictEqual(M.checkEncodedSize(-1).code, 'empty');
});

test('produceAvatar：成功路径恰好创建 1 张画布、恰好编码 1 次，画的是 512×512 的裁切结果', async () => {
  const calls = { canvases: 0, encodes: 0 };
  const canvas = canvasStub({ encode: { size: 12345 } });
  const r = await M.produceAvatar({
    image: { width: 3000, height: 2000 },
    view: M.initialView(3000, 2000, 512),
    outSize: 512,
    canvas,
    encode: (c) => { calls.encodes++; return M.canvasToPngBlob(c); },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bytes, 12345);
  assert.strictEqual(r.outSize, 512);
  assert.strictEqual(calls.encodes, 1);
  assert.strictEqual(canvas.encodes, 1);
  assert.strictEqual(canvas._ctx.drawn.length, 1, '只画一次：没有"先试小尺寸再说"的余地');
  assert.deepStrictEqual(canvas._ctx.drawn[0].slice(5), [0, 0, 512, 512], '目标矩形必须是 512×512');
});

test('produceAvatar：超 2MiB **只拒绝、不降质** —— 恰好 1 张画布、恰好 1 次编码', async () => {
  const created = [];
  const encodeCalls = [];
  const canvas = canvasStub({ encode: { size: 2 * MiB + 1 } });
  const r = await M.produceAvatar({
    image: { width: 1024, height: 1024 },
    view: M.initialView(1024, 1024, 512),
    canvas,
    createCanvas: (w, h) => { created.push([w, h]); return canvas; },
    encode: (c) => { encodeCalls.push([c.width, c.height]); return M.canvasToPngBlob(c); },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'too-large');
  assert.strictEqual(r.message, M.OVER_LIMIT_TEXT);
  assert.strictEqual(r.blob, null, '被拒时绝不能把 blob 交给调用方（那等于默许上传一张超限图）');
  assert.strictEqual(encodeCalls.length, 1, '只允许编码一次：任何"缩到更小再编一次"都会让这条变红');
  assert.strictEqual(canvas._ctx.drawn.length, 1, '只允许画一次：不许偷偷降采样重画');
  assert.deepStrictEqual(encodeCalls[0], [canvas.width, canvas.height]);
  assert.strictEqual(created.length, 0, '调用方给了画布就不该再创建新的');
});

test('produceAvatar：编码返回 null / 抛错 / 没有 2D 上下文都要给可读失败，不抛出去', async () => {
  const base = { image: { width: 100, height: 100 }, view: M.initialView(100, 100, 512) };
  const nulled = await M.produceAvatar({ ...base, canvas: canvasStub({ encode: null }), encode: () => Promise.resolve(null) });
  assert.strictEqual(nulled.ok, false);
  assert.strictEqual(nulled.code, 'encode-failed');
  assert.ok(nulled.message.length > 8);

  const thrown = await M.produceAvatar({ ...base, canvas: canvasStub(), encode: () => Promise.reject(new Error('boom')) });
  assert.strictEqual(thrown.ok, false);
  assert.strictEqual(thrown.code, 'encode-failed');

  const noCtx = await M.produceAvatar({ ...base, canvas: canvasStub({ noCtx: true }), encode: () => Promise.resolve({ size: 10 }) });
  assert.strictEqual(noCtx.ok, false);
  assert.strictEqual(noCtx.code, 'draw-failed');
});

/* --------------------------------------------------- HTTP 形状（§4.3 的三个窄接口） */

test('PUT 形状：Content-Type **精确** image/png（带参数会被服务端 415），body 是原始字节', () => {
  const blob = { size: 10, type: 'image/png' };
  const { url, init } = M.buildAvatarPut({ profileId: 'abc-123', revision: 7, body: blob });
  assert.strictEqual(url, '/api/profiles/abc-123/avatar');
  assert.strictEqual(init.method, 'PUT');
  assert.strictEqual(init.headers['Content-Type'], 'image/png');
  assert.strictEqual(init.headers['Content-Type'], M.AVATAR_CONTENT_TYPE);
  assert.ok(!/;|charset/i.test(init.headers['Content-Type']), '任何参数（含 charset）都会被服务端 415 拒绝');
  assert.strictEqual(init.headers['X-Profile-Revision'], '7', 'revision 必须以整数字符串发出');
  assert.strictEqual(init.body, blob, 'body 就是原始 PNG 字节，不做 base64/JSON 包装');
  assert.strictEqual(M.buildAvatarPut({ profileId: 'a/b c', revision: 1, body: blob }).url, '/api/profiles/a%2Fb%20c/avatar');
});

test('revision 头：只发服务端会接受的整数；非法值宁可不带（带非法值服务端直接 400）', () => {
  assert.strictEqual(M.revisionHeader(0), '0', 'revision 0 是合法整数');
  assert.strictEqual(M.revisionHeader('12'), '12');
  assert.strictEqual(M.revisionHeader(' 7 '), '7');
  // 负数必须拒：服务端 parseProfileRevisionHeader（src/api.js:114）有 `n < 0` 一档，发了必然 400
  for (const bad of [-3, '-3', null, undefined, '', 'abc', 1.5, '1.5', NaN, Infinity, -Infinity, {}, [], true, false]) {
    assert.strictEqual(M.revisionHeader(bad), null, `${JSON.stringify(bad)} 不该被当成 revision 发出去`);
  }
  const noRev = M.buildAvatarPut({ profileId: 'p', revision: 'abc', body: { size: 1 } });
  assert.ok(!('X-Profile-Revision' in noRev.init.headers), '拿不到合法整数就不带这个头（服务端允许缺省）');
  const negative = M.buildAvatarPut({ profileId: 'p', revision: -1, body: { size: 1 } });
  assert.ok(!('X-Profile-Revision' in negative.init.headers), '负数 revision 必须降级成"不带"，而不是换来一次 400');
});

test('DELETE 形状：method DELETE、带 revision、无 body 无 Content-Type', () => {
  const { url, init } = M.buildAvatarDelete({ profileId: 'p1', revision: 9 });
  assert.strictEqual(url, '/api/profiles/p1/avatar');
  assert.strictEqual(init.method, 'DELETE');
  assert.strictEqual(init.headers['X-Profile-Revision'], '9');
  assert.ok(!('Content-Type' in init.headers), 'DELETE 没有 body，不该发 Content-Type');
  assert.strictEqual(init.body, undefined);
});

test('putAvatar / deleteAvatar：成功返回 JSON；失败抛带 status 的 Error（错误体是 JSON）', async () => {
  const okFetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({ profile: { id: 'p' }, avatarUrl: `${url}?v=hash`, method: init.method }) });
  const put = await M.putAvatar(okFetch, { profileId: 'p', revision: 1, body: { size: 1 } });
  assert.strictEqual(put.method, 'PUT');
  assert.match(put.avatarUrl, /^\/api\/profiles\/p\/avatar\?v=hash$/);

  const del = await M.deleteAvatar(okFetch, { profileId: 'p', revision: 2 });
  assert.strictEqual(del.method, 'DELETE');

  const errFetch = async () => ({ ok: false, status: 415, json: async () => ({ error: 'Content-Type 必须是 image/png' }) });
  await assert.rejects(() => M.putAvatar(errFetch, { profileId: 'p', body: {} }), (e) => {
    assert.strictEqual(e.status, 415, '状态码必须带出来，调用方要据此给可读文案');
    assert.match(e.message, /image\/png/);
    return true;
  });
  const brokenBody = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
  await assert.rejects(() => M.deleteAvatar(brokenBody, { profileId: 'p' }), (e) => e.status === 500 && /HTTP 500/.test(e.message));
});

/* --------------------------------------- ④ 响应合并（删了自定义头像也必须还站得住） */

test('mergeAvatarResult：必须把顶层 avatarUrl 挂到 profile 上再合并（否则等于"保存成功但头像没变"）', () => {
  const list = [{ id: 'p', nickname: '甲', avatarId: 'scholar', avatarUrl: null, revision: 3 }];
  const merged = M.mergeAvatarResult(list, {
    profile: { id: 'p', nickname: '甲', avatarId: 'wolf', revision: 4 },
    avatarUrl: '/api/profiles/p/avatar?v=beef',
  });
  assert.strictEqual(merged.avatarUrl, '/api/profiles/p/avatar?v=beef', '响应里的 profile 原文没有 avatarUrl 字段，必须由顶层补上');
  assert.strictEqual(list[0].avatarUrl, '/api/profiles/p/avatar?v=beef');
  assert.strictEqual(list[0].revision, 4, 'revision 必须跟着更新，否则下一次保存会 409');
  assert.strictEqual(list[0].nickname, '甲', '局部字段不得被响应里缺的键抹掉');
  assert.strictEqual(list.length, 1);
});

test('mergeAvatarResult：删除自定义头像后 avatarUrl=null，但档案的 avatarId 原样保留（绝不回退成破图）', () => {
  const list = [{ id: 'p', avatarId: 'mask', avatarUrl: '/api/profiles/p/avatar?v=old', revision: 5 }];
  // 服务端 DELETE 的响应形状：profile 是 profile.json 原文（avatarId 不变），顶层 avatarUrl 为 null
  const merged = M.mergeAvatarResult(list, { profile: { id: 'p', avatarId: 'mask', revision: 6 }, avatarUrl: null });
  assert.strictEqual(merged.avatarUrl, null);
  assert.strictEqual(merged.avatarId, 'mask', '删除 = 改用内置头像：avatarId 必须还在，界面据此显示对应徽记');
  assert.strictEqual(list[0].avatarId, 'mask');
  assert.strictEqual(list[0].revision, 6);
  // 与徽记模块的判据连起来看：null 的 avatarUrl ⇒ 显示该档案 avatarId 的徽记
  const badge = require('../web/shared/avatar-badge');
  assert.deepStrictEqual(badge.displaySource(list[0]), { kind: 'builtin', badgeId: 'mask' });
});

test('mergeAvatarResult：新档案追加、脏响应返回 null、不污染入参对象', () => {
  const list = [];
  const added = M.mergeAvatarResult(list, { profile: { id: 'new', avatarId: 'seer' }, avatarUrl: '/u?v=1' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(added.avatarUrl, '/u?v=1');
  assert.strictEqual(M.mergeAvatarResult(list, null), null);
  assert.strictEqual(M.mergeAvatarResult(list, {}), null);
  assert.strictEqual(M.mergeAvatarResult(list, { profile: {} }), null, '缺 id 的 profile 不该被塞进列表');
  assert.strictEqual(M.mergeAvatarResult(null, { profile: { id: 'x' } }).id, 'x', '没有列表时也要给出合并结果');
  const source = { id: 'p', avatarId: 'wolf' };
  M.mergeAvatarResult([], { profile: source, avatarUrl: '/u' });
  assert.ok(!('avatarUrl' in source), '不得就地改写入参 profile（它可能是 responses 里别人还在用的对象）');
});

/* ------------------------------------------------ ⑤ 客户端 ↔ 真实服务端对齐（端到端）

   上面几条只证明"客户端造出来的东西符合我们自己的期望"。这一条把 buildAvatarPut / buildAvatarDelete
   造出的请求**原样**打给真实 Api（真 HTTP、真 PNG 字节），证明服务端确实接受它：
     · Content-Type 精确 image/png 不会被 415 拦；
     · revision 头语义与 src/api.js:110 同判（因此负数的处置必须一致，见下面那条反证）。
   隔离：走 test/helpers-tmpdir.js 的独占 dataDir，不碰仓库里的 saves/。 */

test('端到端对齐：客户端造出的 PUT/DELETE 被真实服务端接受，删除后回退到 avatarId', async (t) => {
  const dataDir = makeDataDir('av-client-align');
  const { api } = makeApiIn(dataDir);
  terminateAfter(t, api, dataDir);
  await api._profileMigrationReady;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    api.handle(req, res, decodeURIComponent(u.pathname), u.searchParams);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) => fetch(base + url, init);
  try {
    const created = await (await fetch(`${base}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '端到端对齐', avatarId: 'seer' }),
    })).json();
    const pid = created.profile.id;
    const good = png.makePng();

    // ① 上传：用客户端自己的构建函数，body 就是原始 PNG 字节
    const put = await M.putAvatar(fetchImpl, { profileId: pid, revision: created.profile.revision, body: good });
    assert.ok(put.avatarUrl, '服务端必须回一个 avatarUrl（取图只能用它，不能自己拼哈希）');
    assert.strictEqual(put.profile.avatarId, 'seer', '自定义头像不得改动 avatarId');
    assert.match(put.avatarUrl, /^\/api\/profiles\/[^/]+\/avatar\?v=[0-9a-f]{64}$/, 'URL 必须带内容哈希版本');
    const badge = require('../web/shared/avatar-badge');
    const list = [{ id: pid, avatarId: 'seer', nickname: '端到端对齐', revision: created.profile.revision }];
    const merged = M.mergeAvatarResult(list, put);
    assert.strictEqual(merged.avatarUrl, put.avatarUrl);
    assert.deepStrictEqual(badge.displaySource(merged), { kind: 'custom', src: put.avatarUrl });

    // ② 反证：负数 revision 确实会被服务端 400（所以客户端必须把它降级成"不带"）
    const negative = await fetch(`${base}/api/profiles/${pid}/avatar`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png', 'X-Profile-Revision': '-1' }, body: good,
    });
    assert.strictEqual(negative.status, 400, '负数 revision 必须被服务端拒 —— 这正是客户端要提前降级的原因');
    assert.strictEqual(M.revisionHeader(-1), null, '客户端不得发出服务端会拒的值');

    // ③ 换成内置：DELETE 走客户端构建函数；avatarId 一个字节都不动
    const del = await M.deleteAvatar(fetchImpl, { profileId: pid, revision: put.profile.revision });
    assert.strictEqual(del.avatarUrl, null);
    assert.strictEqual(del.profile.avatarId, 'seer');
    const afterDelete = M.mergeAvatarResult(list, del);
    assert.strictEqual(afterDelete.avatarUrl, null);
    assert.deepStrictEqual(badge.displaySource(afterDelete), { kind: 'builtin', badgeId: 'seer' },
      '删除后必须显示该档案 avatarId 的内置徽记 —— 不是空白，也不是破图');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
