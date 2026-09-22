/**
 * m2e-export-native.test.js — M2-e「桌面(Electron) + 安卓」两臂的验证
 *
 * 本批只做这两臂（浏览器臂与 web/** 归下一批，见施工书开头的范围限定块），所以这里覆盖：
 *
 *   ① **真跑**的部分：`desktop/export-core.js`（零 Electron 依赖的纯逻辑核心）——
 *      三态归一化、profileId 白名单、本机同源 URL 拼接、精确同源判据、保存文件名净化、
 *      错误文案限长。它是 `desktop/main.js` 与 preload 契约的**唯一实现**，不是测试里另抄的一份。
 *   ② **读源码钉形状**的部分：Electron 的 preload 暴露面 / IPC 通道一致性 / build.files /
 *      既有安全策略未放宽；Android 的注入名 / 三态 JSON / ACTION_CREATE_DOCUMENT / 流式拷贝。
 *      —— 打包被明令禁止（EXE/APK 验收属 M6），所以"主进程不会被 electron 加载"的这部分
 *      只能靠源码级断言 + 报告里的静态核对；**但安卓那边另有一份真编译证据**（见文件末的说明）。
 *
 * 为什么 Electron 逻辑不写在 main.js 里而是抽到 export-core.js：main.js 一加载就
 * `require('electron')` → 读 `app.isPackaged` → 抢单实例锁，在 `node --test` 里根本加载不起来；
 * 逻辑留在里面就一条也测不到（那才是真正的"未验证"）。抽出来后两边消费同一份实现。
 *
 * ⚠ 本文件刻意不碰 test/emoji-preserve.test.js / icons.test.js / player-center.test.js
 *   （另一个子代理正在改它们）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../desktop/export-core');
const transfer = require('../src/profiles/transfer');

const ROOT = path.join(__dirname, '..');
const readRel = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PRELOAD = readRel('desktop/preload.js');
const MAIN = readRel('desktop/main.js');
const JAVA = readRel('app/android/app/src/main/java/com/werewolfai/app/MainActivity.java');
const DESKTOP_PKG = JSON.parse(readRel('desktop/package.json'));

/**
 * 只保留"代码"，丢掉块注释 —— 否定性扫描（"不得出现 X"）必须扫代码：
 * 文件头注释里为了讲清楚"不暴露 ipcMain / 只用 @JavascriptInterface"本来就会写出这些词，
 * 扫注释会得到假红，而假红的下场通常是有人把注释删掉、真代码照样违规。
 * 只去 `/* *​/` 块注释（本项目的解释性文字都在块注释里）；行注释与字符串原样保留，
 * 于是"把违规代码藏进字符串"不会被这条宽恕掉。
 */
const stripBlockComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const PRELOAD_CODE = stripBlockComments(PRELOAD);
const JAVA_CODE = stripBlockComments(JAVA);

/** 按起止标记切出一段源码（标记缺失 ⇒ 直接断言失败，不让"切不到"变成"没断言"） */
function section(src, from, to, label) {
  const a = src.indexOf(from);
  assert.notStrictEqual(a, -1, `源码里找不到起点标记（${label}）：${from}`);
  const b = to ? src.indexOf(to, a) : -1;
  assert.notStrictEqual(b, -1, `源码里找不到终点标记（${label}）：${to}`);
  return src.slice(a, b);
}

// ─────────────────────────────────────────────────────────── ① 三态归一化（纯逻辑，真跑）

test('M2-e 三态：取值集合就是 saved/cancelled/failed，没有第四种、没有布尔', () => {
  assert.deepStrictEqual([...core.STATUSES], ['saved', 'cancelled', 'failed']);
});

test('M2-e 三态：只有字面量 saved 才是成功 —— ok/success/true/1 一律落 failed（未经确认不宣称保存成功）', () => {
  for (const bogus of ['ok', 'success', 'done', 'SAVED', 'Saved', 'saved ', true, 1, 0, null, undefined, '', {}, []]) {
    const r = core.normalizeResult({ status: bogus });
    assert.strictEqual(r.status, 'failed', `status=${JSON.stringify(bogus)} 绝不能被归一化成成功`);
    assert.ok(r.error && typeof r.error === 'string', '失败必须带可读 error');
  }
  assert.strictEqual(core.normalizeStatus('success'), 'failed');
  assert.strictEqual(core.normalizeStatus(undefined), 'failed');
  assert.strictEqual(core.normalizeStatus('saved'), 'saved');
});

test('M2-e 三态：声明 saved 却不带落盘路径 ⇒ 判 failed（不许凭空宣称保存成功）', () => {
  for (const noPath of [{ status: 'saved' }, { status: 'saved', path: '' }, { status: 'saved', path: '   ' }, { status: 'saved', path: 42 }]) {
    const r = core.normalizeResult(noPath);
    assert.strictEqual(r.status, 'failed', `${JSON.stringify(noPath)} 没有真实落盘路径，不能算保存成功`);
  }
  assert.throws(() => core.savedResult(''), /真实的落盘路径/);
  assert.deepStrictEqual(core.savedResult('C:\\x\\a.json'), { status: 'saved', path: 'C:\\x\\a.json' });
});

test('M2-e 三态：取消是正常结局（不是失败，不带 error），非对象输入一律 failed', () => {
  const c = core.normalizeResult({ status: 'cancelled', error: '不该出现' });
  assert.deepStrictEqual(c, { status: 'cancelled' });
  assert.deepStrictEqual(core.cancelledResult(), { status: 'cancelled' });
  for (const junk of ['saved', 'cancelled', 42, null, undefined, true, ['saved']]) {
    assert.strictEqual(core.normalizeResult(junk).status, 'failed', `${JSON.stringify(junk)} 不是三态对象`);
  }
});

test('M2-e 三态：错误文案单行化 + 限长（IPC 返回值不留换行/超长报文）', () => {
  const long = 'x'.repeat(core.MAX_ERROR_LEN * 3);
  const r = core.failedResult(new Error(`第一行\n第二行\r\n${long}`));
  assert.strictEqual(r.status, 'failed');
  assert.ok(!/[\r\n]/.test(r.error), '不得残留换行');
  assert.strictEqual(r.error.length, core.MAX_ERROR_LEN, '必须被截到 MAX_ERROR_LEN');
  for (const junk of [undefined, null, '', new Error('')]) {
    const f = core.failedResult(junk);
    assert.strictEqual(f.status, 'failed');
    assert.ok(f.error.length > 0, '哪怕没有 message 也要给非空说明');
  }
  assert.strictEqual(core.sanitizeError({ message: '  a  b  ' }), 'a b');
});

test('M2-e 三态：showSaveDialog 的取消判据（canceled=true 或拿不到路径都算取消）', () => {
  assert.deepStrictEqual(core.classifySaveDialogResult({ canceled: true, filePath: 'C:\\a.json' }), { status: 'cancelled' });
  assert.deepStrictEqual(core.classifySaveDialogResult({ canceled: false, filePath: '' }), { status: 'cancelled' });
  assert.deepStrictEqual(core.classifySaveDialogResult({ canceled: false }), { status: 'cancelled' });
  assert.deepStrictEqual(core.classifySaveDialogResult(undefined), { status: 'cancelled' });
  assert.deepStrictEqual(core.classifySaveDialogResult({ canceled: false, filePath: 'C:\\a.json' }),
    { status: 'save', filePath: 'C:\\a.json' });
});

// ─────────────────────────────────────────────────── ② profileId 白名单 / 主进程自拼 URL

test('M2-e Electron：主进程自己把 profileId 拼成本机同源 URL（不接受调用方给 URL/路径）', () => {
  assert.strictEqual(core.buildExportUrl(3210, 'abc-123'), 'http://127.0.0.1:3210/api/profiles/abc-123/export');
  assert.strictEqual(core.buildExportUrl(51234, 'A_b-9'), 'http://127.0.0.1:51234/api/profiles/A_b-9/export');
});

test('M2-e Electron：profileId 白名单在拼接前拒绝路径穿越 / 任意 URL / 注入字符', () => {
  const bad = [
    '../secret', '..', 'a/b', 'a\\b', 'a%2fb', '%2e%2e%2f', '', ' ', 'a b', 'a\tb', 'a\nb',
    'a?x=1', 'a#b', 'a&b', 'http://evil.com', 'file:///etc/passwd', 'C:\\Windows\\win.ini',
    'a'.repeat(65), '档案', 'a;b', 'a|b', 'a*b', "a'b", 'a"b', 'a<b',
  ];
  for (const id of bad) {
    assert.throws(() => core.buildExportUrl(3210, id), /profileId/, `必须拒绝：${JSON.stringify(id)}`);
  }
  for (const junk of [undefined, null, 42, {}, [], true, Symbol('x')]) {
    assert.throws(() => core.buildExportUrl(3210, junk), TypeError, `必须拒绝非字符串：${String(junk)}`);
  }
  // 端口也必须是真的端口：0/负数/超范围/非整数/字符串 都拼不出 URL
  for (const port of [0, -1, 65536, 3210.5, '3210', NaN, null, undefined]) {
    assert.throws(() => core.buildExportUrl(port, 'ok-id'), /端口/, `必须拒绝端口：${String(port)}`);
  }
  assert.strictEqual(core.PROFILE_ID_RE.test('a'.repeat(64)), true, '恰好 64 位应通过（边界内）');
});

// ─────────────────────────────────────────── ③ 精确同源判据（SEC-03 语义，不许被放松）

test('M2-e Electron：精确同源判据挡住 SEC-03 的构造（includes 式判据会把它们误判成站内）', () => {
  const origin = 'http://127.0.0.1:3210';
  assert.strictEqual(core.isSameOrigin('http://127.0.0.1:3210/api/profiles/x/export', origin), true);
  assert.strictEqual(core.isSameOrigin('http://127.0.0.1:3210/', origin), true);
  const evil = [
    'http://evil.com/?127.0.0.1:3210',        // 旧 includes 判据的经典绕过
    'http://evil.com/#http://127.0.0.1:3210',
    'http://127.0.0.1:3210.evil.com/',        // 前缀相同、origin 不同
    'http://127.0.0.1:3210@evil.com/',        // user-info 伪装
    'http://127.0.0.1:3211/',                 // 端口不同
    'http://127.0.0.1:32100/',
    'https://127.0.0.1:3210/',                // 协议不同
    'http://localhost:3210/',                 // 主机名不同（Electron 侧只认 127.0.0.1）
    'http://[::1]:3210/',
    'data:text/html,<script>1</script>',
    'javascript:alert(1)',
    'file:///C:/Windows/win.ini',
    '', 'not a url', null, undefined,
  ];
  for (const url of evil) {
    assert.strictEqual(core.isSameOrigin(url, origin), false, `必须判为非站内：${String(url)}`);
  }
  assert.strictEqual(core.isSameOrigin('http://127.0.0.1:3210/', ''), false, 'origin 为空时一律拒绝');
});

test('M2-e Electron：拼好的 URL 还要再过一遍同源判据才允许触网', () => {
  assert.strictEqual(core.assertLocalExportUrl('http://127.0.0.1:3210/api/profiles/x/export', 3210),
    'http://127.0.0.1:3210/api/profiles/x/export');
  assert.throws(() => core.assertLocalExportUrl('http://evil.com/x', 3210), /同源/);
  assert.throws(() => core.assertLocalExportUrl('http://127.0.0.1:3211/x', 3210), /同源/);
});

// ─────────────────────────────────────────────────────────── ④ 保存文件名净化 / 上限对账

test('M2-e Electron：保存文件名永不带路径分隔符（服务端头里的 ../../ 也带不出目录）', () => {
  assert.strictEqual(core.safeFileName('../../etc/passwd'), 'passwd');
  assert.strictEqual(core.safeFileName('..\\..\\evil.json'), 'evil.json');
  assert.strictEqual(core.safeFileName('C:\\Windows\\system32\\x.json'), 'x.json');
  assert.strictEqual(core.safeFileName('a/b/c.json'), 'c.json');
  assert.strictEqual(core.safeFileName('..'), core.DEFAULT_FILE_NAME);
  assert.strictEqual(core.safeFileName('.'), core.DEFAULT_FILE_NAME);
  assert.strictEqual(core.safeFileName(null), core.DEFAULT_FILE_NAME);
  assert.strictEqual(core.safeFileName('   '), core.DEFAULT_FILE_NAME);
  assert.ok(!/[\\/]/.test(core.safeFileName('..\\..\\..\\a/b\\c.json')), '结果绝不含分隔符');
  assert.strictEqual(core.safeFileName('a<b>c:d"e|f?g*h.json'), 'a_b_c_d_e_f_g_h.json');
  assert.strictEqual(core.safeFileName('x'.repeat(500)).length, 128);
  assert.strictEqual(core.safeFileName('ww-profile-砚舟-2026-09-21.json'), 'ww-profile-砚舟-2026-09-21.json', '正常昵称文件名原样保留');
});

test('M2-e Electron：从 Content-Disposition 取建议文件名，异常输入不抛错也不越界', () => {
  assert.strictEqual(core.suggestedFileName("attachment; filename*=UTF-8''%E7%A0%9A%E8%88%9F-2026-09-21.json"),
    '砚舟-2026-09-21.json');
  assert.strictEqual(core.suggestedFileName('attachment; filename="ww.json"'), 'ww.json');
  assert.strictEqual(core.suggestedFileName(undefined), core.DEFAULT_FILE_NAME);
  assert.strictEqual(core.suggestedFileName("attachment; filename*=UTF-8''..%2F..%2Fevil.json"), 'evil.json');
  assert.strictEqual(core.suggestedFileName("attachment; filename*=UTF-8''%ZZ"), core.DEFAULT_FILE_NAME,
    '非法百分号编码不许抛错，退到默认名');
  const joined = core.describeTarget(path.join('C:', 'Users', 'x', 'Documents'), '../../evil.json');
  assert.strictEqual(path.dirname(joined), path.join('C:', 'Users', 'x', 'Documents'), 'defaultPath 必须就落在目标目录里');
});

test('M2-e 上限：Electron 侧的字节上限与导入导出契约（src/profiles/transfer.js）同值 —— 漂移即判红', () => {
  assert.strictEqual(core.MAX_EXPORT_BYTES, 20 * 1024 * 1024);
  assert.strictEqual(core.MAX_EXPORT_BYTES, transfer.MAX_BYTES,
    'desktop/export-core.js 的 MAX_EXPORT_BYTES 必须与 src/profiles/transfer.js 的 MAX_BYTES 一致');
});

// ─────────────────────────────────────────── ⑤ Electron：preload 暴露面 / IPC / 安全策略

/** 从 preload.js 里把 exposeInMainWorld 的对象字面量解析出来（切不到就直接失败） */
function preloadExposure() {
  const m = /exposeInMainWorld\(\s*'([^']+)'\s*,\s*\{([\s\S]*?)\n\}\);/.exec(PRELOAD);
  assert.ok(m, 'preload.js 必须有一次 contextBridge.exposeInMainWorld 且对象字面量可解析');
  const world = m[1];
  const keys = [...m[2].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((x) => x[1]);
  return { world, keys, body: m[2] };
}

test('M2-e Electron：preload 只暴露 window.wwExport = { exportProfile } —— 逐项列出即全部', () => {
  assert.strictEqual((PRELOAD.match(/exposeInMainWorld\(/g) || []).length, 1, '只允许一次 exposeInMainWorld');
  const { world, keys, body } = preloadExposure();
  assert.strictEqual(world, 'wwExport');
  assert.deepStrictEqual(keys, ['exportProfile'], `暴露面必须恰好是 exportProfile（实际：${keys.join(',')}）`);
  assert.match(body, /exportProfile:\s*\(profileId\)\s*=>\s*ipcRenderer\.invoke\(EXPORT_CHANNEL,\s*profileId\)/,
    '唯一方法的形状：把 profileId 转交主进程，不接受第二参数');
});

test('M2-e Electron：preload 不暴露任何泛化通道 / 任意路径 / Node 能力', () => {
  assert.strictEqual((PRELOAD_CODE.match(/ipcRenderer\./g) || []).length, 1, 'ipcRenderer 只允许用一次');
  for (const forbidden of ['ipcRenderer.send(', 'ipcRenderer.sendSync(', 'ipcRenderer.on(', 'ipcRenderer.once(',
    'ipcRenderer.postMessage(', 'ipcMain', 'webFrame', 'shell.', 'process.',
    "require('fs')", "require('path')", "require('child_process')", 'nodeIntegration', 'openExternal', 'openPath',
    'fetch(', 'XMLHttpRequest']) {
    assert.ok(!PRELOAD_CODE.includes(forbidden), `preload 不得出现 ${forbidden}`);
  }
  assert.match(PRELOAD_CODE, /const \{ contextBridge, ipcRenderer \} = require\('electron'\);/,
    'preload 只从 electron 取 contextBridge 与 ipcRenderer');
  assert.strictEqual((PRELOAD_CODE.match(/require\(/g) || []).length, 1, 'preload 只允许一次 require（沙箱 preload 的相对 require 不可用）');
});

test('M2-e Electron：preload 的通道名与 main.js 的 ipcMain.handle 通道名逐字一致', () => {
  const inPreload = /const EXPORT_CHANNEL = '([^']+)';/.exec(PRELOAD);
  const inMain = /const EXPORT_CHANNEL = '([^']+)';/.exec(MAIN);
  assert.ok(inPreload && inMain, '两边都必须有 EXPORT_CHANNEL 字面量');
  assert.strictEqual(inPreload[1], inMain[1], 'preload 与 main 的通道名必须逐字相同');
  assert.strictEqual(inPreload[1], 'ww:export-profile');
  assert.ok(MAIN.includes('ipcMain.handle(EXPORT_CHANNEL'), 'main.js 必须用同一常量注册 handle');
  assert.strictEqual((MAIN.match(/ipcMain\.handle\(/g) || []).length, 1, '只允许注册一条 IPC 通道');
  assert.strictEqual((MAIN.match(/ipcMain\.handleOnce\(/g) || []).length, 0);
  assert.strictEqual((MAIN.match(/ipcMain\.on\(/g) || []).length, 0, '不允许再有 ipcMain.on 旁路');
  assert.match(MAIN, /ipcMain\.handle\(EXPORT_CHANNEL,\s*async\s*\(_event,\s*profileId\)\s*=>/, 'handler 只收 profileId 一个入参');
});

test('M2-e Electron：导出流程自己拼 URL、先过同源判据、再弹保存框、最后才写盘（顺序钉住）', () => {
  const flow = section(MAIN, 'async function runExport(', '/** 注册唯一一条导出通道', 'runExport');
  const iId = flow.indexOf('exportCore.buildExportUrl(port, profileId)');
  const iOrigin = flow.indexOf('isInternalUrl(url)');
  const iDialog = flow.indexOf('dialog.showSaveDialog');
  const iWrite = flow.indexOf('fs.promises.writeFile(picked.filePath, payload.body)');
  assert.ok(iId !== -1, '必须由主进程用 buildExportUrl(port, profileId) 自己拼 URL');
  assert.ok(iOrigin > iId, '同源判据必须排在拼 URL 之后');
  assert.ok(iDialog > iOrigin, '保存框必须排在同源判据之后（未过校验不许弹窗）');
  assert.ok(iWrite > iDialog, '写盘目标只能来自保存框返回值');
  assert.ok(!/shell\./.test(flow), '导出流程不得使用 shell（不许打开任意路径/外链）');
  assert.ok(!/profileId[^)]*writeFile|writeFile\([^)]*profileId/.test(flow), '写盘目标绝不能是调用方给的 profileId');
  assert.ok(!flow.includes('payload.body.path'), '不得把响应体里的字段当路径用');
});

test('M2-e Electron：preload 被接进窗口，且 webPreferences 的既有安全项一条都没放宽', () => {
  const wp = section(MAIN, 'webPreferences: {', '},', 'webPreferences');
  assert.match(wp, /contextIsolation:\s*true/);
  assert.match(wp, /nodeIntegration:\s*false/);
  assert.match(wp, /sandbox:\s*true/);
  assert.match(wp, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/, 'preload.js 必须真的挂上去');
});

test('M2-e Electron：拒绝任意新窗口 / 任意外部 URL 的既有守卫原样保留（本批没放宽）', () => {
  const guard = section(MAIN, 'win.webContents.session.setPermissionRequestHandler', 'await win.loadURL(\'data:text/html', 'guards');
  assert.match(guard, /setPermissionRequestHandler\(\(_wc, _permission, callback\) => callback\(false\)\)/, '权限请求仍一律拒绝');
  assert.match(guard, /setWindowOpenHandler\(\(\{ url \}\) => \{/, '窗口打开守卫仍在');
  assert.match(guard, /return \{ action: 'deny' \};/, '新窗口仍一律 deny');
  assert.match(guard, /on\('will-navigate', \(e, url\) => \{/, '内部导航守卫仍在');
  assert.match(guard, /e\.preventDefault\(\);/, '非站内导航仍被 preventDefault');
  // 同源判据必须只有一份实现，且是 export-core 的精确 origin 比较（不许退回 includes）
  assert.match(MAIN, /const isInternalUrl = \(url\) => exportCore\.isSameOrigin\(url, internalOrigin\);/);
  assert.strictEqual((MAIN.match(/const isInternalUrl =/g) || []).length, 1, '同源判据只能有一份实现');
  assert.ok(!/\.includes\(internalOrigin/.test(MAIN), '不得用字符串 includes 判同源（SEC-03 回归）');
  assert.ok(!/origin\s*===\s*internalOrigin/.test(MAIN), 'origin 比较只允许走 exportCore.isSameOrigin');
  assert.match(MAIN, /internalOrigin = `http:\/\/127\.0\.0\.1:\$\{port\}`;/, '同源 origin 仍由真实端口拼出');
});

test('M2-e Electron：desktop/package.json 的 build.files 含 preload.js 与 export-core.js（打包文件集唯一来源）', () => {
  // scripts/build-desktop.js:69-72 调 electron-builder 时**不传** files，打包文件集完全由这个数组决定；
  // 本批禁止打包，所以这条只能静态钉住 —— 漏了它打出来的 EXE 就会缺文件。
  const files = DESKTOP_PKG.build && DESKTOP_PKG.build.files;
  assert.ok(Array.isArray(files), 'build.files 必须是数组');
  for (const need of ['main.js', 'package.json', 'preload.js', 'export-core.js']) {
    assert.ok(files.includes(need), `build.files 必须包含 ${need}（实际：${files.join(', ')}）`);
  }
  assert.strictEqual(DESKTOP_PKG.main, 'main.js');
});

// ─────────────────────────────────────────── ⑥ Android：注入面 / SAF / 流式 / 只导出本机档案

test('M2-e Android：注入名固定 WWExport、方法固定 exportProfile(String) 且带 @JavascriptInterface', () => {
  assert.match(JAVA, /private static final String BRIDGE_NAME = "WWExport";/);
  assert.match(JAVA_CODE, /addJavascriptInterface\(new ExportBridge\(this\), BRIDGE_NAME\)/, '注入必须用同一常量做名字');
  assert.strictEqual((JAVA_CODE.match(/addJavascriptInterface\(/g) || []).length, 1, '只允许注入一次');
  assert.strictEqual((JAVA_CODE.match(/@JavascriptInterface/g) || []).length, 1, '注入面上只允许一个方法');
  assert.match(JAVA_CODE, /public String exportProfile\(String profileId\)\s*\{\s*return activity\.startExport\(profileId\);\s*\}/,
    '方法签名与转发形状固定');
  assert.match(JAVA_CODE, /public static final class ExportBridge/);
  assert.ok(!/getRuntime\(\)|ProcessBuilder|openFileOutput|Runtime\.exec/.test(JAVA_CODE), '注入面不得给 JS 任何文件/进程能力');
});

test('M2-e Android：保存走系统「创建文档」(ACTION_CREATE_DOCUMENT/SAF)，取消映射成 cancelled 而不是 failed', () => {
  assert.match(JAVA, /new Intent\(Intent\.ACTION_CREATE_DOCUMENT\)/);
  assert.match(JAVA, /intent\.addCategory\(Intent\.CATEGORY_OPENABLE\)/);
  assert.match(JAVA, /intent\.setType\("application\/json"\)/);
  assert.match(JAVA, /startActivityForResult\(intent, REQ_CREATE_DOCUMENT\)/);
  assert.match(JAVA, /protected void onActivityResult\(int requestCode, int resultCode, Intent data\)/);
  assert.match(JAVA, /resultCode == RESULT_OK/);
  assert.match(JAVA, /"\{\\"status\\":\\"cancelled\\",\\"pending\\":false\}"/, '用户取消必须是 cancelled 三态，不是 failed');
});

test('M2-e Android：20MiB 包体走原生流式拷贝，绝不整体进内存 / 整体进 JS bridge', () => {
  assert.match(JAVA, /private static final long MAX_EXPORT_BYTES = 20L \* 1024 \* 1024L;/, '上限与 transfer.js 的 20MiB 对齐');
  assert.match(JAVA, /byte\[\] buf = new byte\[STREAM_BUFFER\];/);
  assert.match(JAVA, /while \(\(n = in\.read\(buf\)\) > 0\) \{/);
  assert.match(JAVA, /out\.write\(buf, 0, n\);/);
  assert.ok(!/readAllBytes|readNBytes|BufferedReader|IOUtils|ByteArrayOutputStream/.test(JAVA_CODE),
    '不得存在"整体读进内存"的写法');
  // 桥上来回只能是那个小小的三态 JSON：exportProfile 的返回值里不得出现包体/正文变量
  const bridge = section(JAVA, 'public String exportProfile(String profileId)', 'private String startExport', 'ExportBridge');
  assert.ok(!/body|payload|content|bytes/.test(bridge), `桥方法只返回三态 JSON，不得夹带包体（实际：${bridge}）`);
  assert.match(JAVA, /long declared = conn\.getContentLength\(\);/, '长度先判一次');
  assert.strictEqual((JAVA.match(/导出包超过 20 MiB 上限/g) || []).length, 2, '长度判据 + 逐块累计判据（各一次）');
});

test('M2-e Android：只导出本机服务的档案路径（自己拼 URL + profileId 白名单 + 当前页必须是本机服务）', () => {
  assert.match(JAVA, /private static final String LOCAL_ORIGIN = "http:\/\/127\.0\.0\.1:3210";/);
  assert.match(JAVA, /new URL\(LOCAL_ORIGIN \+ "\/api\/profiles\/" \+ profileId \+ "\/export"\)/, 'URL 由原生自己拼');
  assert.match(JAVA, /private static final Pattern PROFILE_ID = Pattern\.compile\("\^\[A-Za-z0-9_-\]\{1,64\}\$"\);/);
  assert.match(JAVA, /!PROFILE_ID\.matcher\(profileId\)\.matches\(\)/, '白名单先行');
  assert.match(JAVA, /!current\.startsWith\(LOCAL_ORIGIN \+ "\/"\)/, '当前页面不是本机服务就拒绝');
  assert.ok(!/intent\.setData|setDataAndType|Uri\.parse\(profileId\)|EXTRA_INITIAL_URI/.test(JAVA),
    '不得把调用方给的字符串当 URI/路径用');
  assert.match(JAVA, /conn\.setInstanceFollowRedirects\(false\)/, '不跟随重定向（避免被带离本机服务）');
});

test('M2-e Android：三态 JSON 的三个取值都在（终态经 __wwExportResult 回调送达，与冻结接口的差异见报告）', () => {
  assert.match(JAVA, /"\{\\"status\\":\\"saved\\",\\"pending\\":false,\\"bytes\\":"/, 'saved 三态');
  assert.match(JAVA, /private static String failedJson\(String message\) \{\s*return "\{\\"status\\":\\"failed\\",\\"pending\\":false,\\"error\\":\\""/, 'failed 三态');
  assert.match(JAVA, /private static final String RESULT_CALLBACK = "__wwExportResult";/);
  assert.match(JAVA, /"window\." \+ RESULT_CALLBACK \+ " && window\." \+ RESULT_CALLBACK \+ "\(" \+ jsString\(json\) \+ "\)"/,
    '终态经唯一的回调名送达');
  assert.match(JAVA, /return "\{\\"pending\\":true\}";/, '受理成功只能回 pending（此刻既非 saved 也非 cancelled）');
});

// ─────────────────────────────────────────────────────────── ⑦ 边界声明（诚实边界钉成用例）

test('M2-e 边界：本批没有 web/** 的接线 —— Android 的 JS 调用方尚不存在（下一批）', () => {
  // 注入名/方法名/回调名都只有原生一侧的定义，web/ 里还没有调用者；这条把"已接线"的假象钉死，
  // 免得报告里把"原生桥可用"写成"端到端已验证"。
  const webFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.js') || e.name.endsWith('.html')) webFiles.push(fp);
    }
  };
  walk(path.join(ROOT, 'web'));
  const callers = webFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('WWExport'));
  assert.deepStrictEqual(callers, [], `本批不该有 web/** 调用方（实际：${callers.join(', ')}）`);
});
