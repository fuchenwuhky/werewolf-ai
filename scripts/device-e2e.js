#!/usr/bin/env node
/**
 * device-e2e.js — Android 设备/模拟器 UI 驱动（零依赖，CDP over adb forward）
 *
 * 前置：
 *   1. 调试版 APK（WebView 可远程调试）
 *   2. adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * 用法：
 *   node scripts/device-e2e.js flow [截图输出目录]   # 完整验收流（开局/页签/标注撤销/键盘）
 *   node scripts/device-e2e.js eval "<js>"           # 在页面里执行表达式
 *   node scripts/device-e2e.js shot out.png          # 截图
 */
'use strict';
const fs = require('fs');
const http = require('http');

const CDP_HTTP = 'http://127.0.0.1:9222';

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_HTTP}/json/list`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WS error')), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page' && !/devtools|blank/.test(t.url)) || targets[0];
  if (!page) throw new Error('未找到页面 target（应用需在前台且 WebView 已启动）');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + String((d.exception && d.exception.description) || d.text).slice(0, 300));
    }
    return r.result && r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (cmd === 'eval') {
    console.log(JSON.stringify(await evalJs(rest.join(' '))));
    process.exit(0);
  }
  if (cmd === 'shot') {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(rest[0], Buffer.from(r.data, 'base64'));
    console.log('saved', rest[0]);
    process.exit(0);
  }
  if (cmd === 'flow') {
    const outDir = rest[0] || 'artifacts/acceptance/device';
    fs.mkdirSync(outDir, { recursive: true });
    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.data, 'base64'));
      console.log(`  📸 ${name}`);
    };
    const step = async (name, expr, ms = 900) => {
      const v = await evalJs(expr);
      await sleep(ms);
      console.log(`  ▸ ${name}: ${JSON.stringify(v).slice(0, 140)}`);
      return v;
    };
    // AC-12：通过/失败/未执行三分，失败与必测未执行都必须非零退出
    const results = [];
    const ok = (cond, name) => { results.push({ name, pass: !!cond }); console.log(`${cond ? '  ✓' : '  ✖'} ${name}`); return cond; };
    const skip = (name, why) => { results.push({ name, pass: false, skipped: true, why }); console.log(`  ⏭ ${name}（未执行：${why}）`); };

    console.log('== 1. 试玩开关 + 开局 ==');
    await step('确保试玩模式', `(() => { if (!state.mock) { const b2 = document.querySelector('#m-mock-btn'); if (b2) b2.click(); } return { mock: state.mock }; })()`);
    await step('开始新局', `(() => { document.querySelector('#m-play-new').click(); return true; })()`, 600);
    await step('下一步', `(() => { const n = document.querySelector('#m-next'); if (n && !n.disabled) n.click(); return !!n; })()`, 800);
    await step('开始游戏', `(() => { const b = [...document.querySelectorAll('button')].find((x) => /开始游戏/.test(x.textContent)); if (b) b.click(); return !!b; })()`, 12000);
    ok(await evalJs(`!!(state.game && state.game.gameId)`), '对局已创建');
    await step('翻牌/确认', `(() => {
      const f = document.querySelector('#m-flip');
      if (f && !f.classList.contains('hidden')) {
        (f.querySelector('.m-flip-inner') || f.querySelector('.m-flip-card') || f).click();
        return 'flipping';
      }
      return 'no-flip';
    })()`, 1200);
    await step('确认进入', `(() => {
      const f = document.querySelector('#m-flip');
      if (f && f.classList.contains('hidden')) return true;
      const b = [...document.querySelectorAll('#m-flip button')].find((x) => /开始游戏|记住了/.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    })()`, 2500);
    ok(await evalJs(`document.querySelector('#m-flip').classList.contains('hidden')`), '翻牌层关闭');
    ok(await evalJs(`!!document.querySelector('#m-game:not(.hidden)')`), '在对局页');
    await shot('device-game-speech');

    console.log('== 2. 页签 ==');
    await step('玩家页签', `(() => { document.querySelector('#m-tabbtn-players').click(); return document.querySelector('#m-game').className; })()`, 800);
    ok(await evalJs(`(() => { const g = document.querySelector('#m-game'); const n = document.querySelector('#m-board'); if (!g || !n) return false; const r = n.getBoundingClientRect(); return g.classList.contains('tab-players') && r.width > 0 && r.height > 0; })()`), '玩家页生效（面板可见非零尺寸）');
    await shot('device-game-players');
    await step('笔记页签', `(() => { document.querySelector('#m-tabbtn-notes').click(); return true; })()`, 800);
    // AC-02 回归：笔记页签必须让面板真实可见（类不变、面板 display:none 的旧缺陷）
    ok(await evalJs(`(() => {
      const g = document.querySelector('#m-game');
      const p = document.querySelector('#m-notes-pane');
      if (!g || !p) return false;
      const r = p.getBoundingClientRect();
      return g.classList.contains('tab-notes') && !p.classList.contains('hidden') && r.width > 0 && r.height > 0;
    })()`), '笔记页生效（面板可见且非零尺寸）');
    await shot('device-game-notes');
    await step('回到发言页', `(() => { document.querySelector('#m-tabbtn-speech').click(); return true; })()`, 600);

    console.log('== 3. 标注保存 + 撤销 ==');
    const seat = await evalJs(`(() => {
      const me = (state.view.me || {}).seat;
      const p = (state.view.players || []).find((x) => x.alive && !x.revealed && x.seat !== me);
      return p ? p.seat : 0;
    })()`);
    await step(`标注 ${seat} 号`, `(async () => {
      const AM = () => window.WWAnnotationsModel;
      const entry = AM().normalizeSeatAnnotation({ leaning: 'lean_wolf', candidateRoleIds: [], note: '设备e2e标注' });
      await saveAnnotations(${seat}, entry);
      return state.anno.seats[${seat}] ? 'saved' : 'missing';
    })()`, 1800);
    ok(await evalJs(`!!(state.anno.seats[${seat}] && state.anno.seats[${seat}].note === '设备e2e标注')`), '标注已保存');
    ok(await evalJs(`!!(state.annoUndo && state.annoUndo.seat === ${seat})`), '撤销快照已记录');
    await step('执行撤销', `(async () => {
      document.querySelector('#m-tabbtn-notes').click();
      await new Promise((r) => setTimeout(r, 400));
      const b = [...document.querySelectorAll('#m-notes-list button')].find((x) => x.textContent.includes('撤销'));
      if (!b) return 'no-undo-button';
      const r = b.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return 'undo-button-invisible'; // 隐藏按钮不得点击（AC-12）
      b.click();
      await new Promise((r) => setTimeout(r, 1200));
      return 'undone';
    })()`, 2400);
    ok(await evalJs(`!state.anno.seats[${seat}] || !state.anno.seats[${seat}].note`), '撤销后标注已回退');
    await shot('device-notes-after-undo');

    console.log('== 4. 软键盘 ==');
    const kb = await evalJs(`(() => {
      const ta = document.querySelector('#m-flow textarea, #m-keys input[type=text]');
      if (ta) { ta.focus(); return 'focused'; }
      return 'no-input-yet';
    })()`);
    console.log('  输入框:', kb, '（软键盘弹出为系统行为，由截图/真机确认）');
    await sleep(1200);
    await shot('device-keyboard-state');
    if (kb === 'focused') ok(true, '输入框聚焦（软键盘由截图确认）');
    else skip('软键盘遮挡验证', '当前阶段没有可见输入框');

    console.log('== 5. 完成 ==');
    const fails = results.filter((r) => !r.pass && !r.skipped);
    const skips = results.filter((r) => r.skipped);
    console.log(`结果：${results.filter((r) => r.pass).length} 通过 / ${fails.length} 失败 / ${skips.length} 未执行`);
    console.log(`截图目录: ${outDir}/`);
    process.exit(fails.length ? 1 : (skips.length ? 2 : 0)); // AC-12：失败=1；必测未执行=2
  }
  console.log('用法: node scripts/device-e2e.js flow|eval|shot');
  process.exit(0);
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
