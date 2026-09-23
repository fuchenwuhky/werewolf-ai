#!/usr/bin/env node
/**
 * android-native-cdp.js —— 通过 WebView 的 DevTools 协议读**真机页面里的真实状态**。
 *
 * 为什么需要它：`adb input tap` 只能"点"，点没点中、页面里发生了什么，屏上不一定看得见
 * （flash 提示 1.45s 就淡出、静默失败更是什么都不显示）。CDP 直接读页面内的对象与已绑定的监听，
 * 让"导出按钮到底有没有触发 JS"变成可读事实，而不是靠截图猜。
 *
 * 用法：
 *   node scripts/android-native-cdp.js eval "<js 表达式>"      # 求值并打印（awaitPromise）
 *   node scripts/android-native-cdp.js listen <秒数>           # 订阅 console/异常若干秒
 * 依赖：`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` 已建立。
 * 零 npm 依赖（Node 22+ 自带全局 WebSocket）。
 */
'use strict';

const PORT = process.env.CDP_PORT || '9333';

async function listPages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

/** 极简 CDP 客户端：发命令、按 id 收结果，另把事件回调交给 onEvent。 */
function connect(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (_) {} },
      });
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
        return;
      }
      if (m.method && onEvent) onEvent(m);
    });
  });
}

async function main(argv) {
  const [op, ...rest] = argv;
  const pages = await listPages();
  if (!pages.length) { console.error('没有可 attach 的页面'); return 1; }
  const page = pages.find((p) => p.type === 'page') || pages[0];
  const events = [];
  const c = await connect(page.webSocketDebuggerUrl, (m) => events.push(m));
  await c.send('Runtime.enable');
  await c.send('Console.enable').catch(() => {});
  await c.send('Log.enable').catch(() => {});

  if (op === 'eval') {
    const expr = rest.join(' ');
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      console.log('EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    } else {
      console.log(JSON.stringify(r.result && r.result.value, null, 2));
    }
    c.close();
    return 0;
  }
  if (op === 'listen') {
    const secs = Number(rest[0] || 6);
    await new Promise((res) => setTimeout(res, secs * 1000));
    for (const m of events) console.log(m.method + ' ' + JSON.stringify(m.params).slice(0, 1200));
    console.log(`--- 事件 ${events.length} 条 / ${secs}s ---`);
    c.close();
    return 0;
  }
  console.error('用法：eval <expr> | listen <秒>');
  c.close();
  return 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
