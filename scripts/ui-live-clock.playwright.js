/* Browser regression with synthetic view frames only. Never create/resume a real game. */
/* global document, window, state, stopPolling, showScreen, renderLive, updateLive, renderEventNode */
async (page) => {
  const checks = [];
  const errors = [];
  let mutations = 0;
  const check = (ok, label, detail) => {
    if (!ok) throw new Error(`${label}: ${JSON.stringify(detail)}`);
    checks.push(label);
  };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/games**', async route => {
    if (route.request().method() !== 'GET') mutations++;
    await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({rows:[]})});
  });
  for (const mobile of [false, true]) {
    const name = mobile ? 'mobile' : 'desktop';
    await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:900});
    await page.goto(`http://127.0.0.1:3210/${mobile ? 'm/' : ''}`);
    await page.waitForFunction(() => window.__wwReady);
    const nodeId = mobile ? 'm-live' : 'live-typing';
    const clockSelector = mobile ? '[data-live-clock]' : '.typing-count';
    const bodySelector = mobile ? '.live-body' : '.typing-body';
    await page.evaluate(isMobile => {
      stopPolling();
      state.game = {gameId:'ui-live-clock-fixture'};
      state.godMode = false;
      state.seatNames = {1:'再问一个为何'};
      state.voteProgress = null;
      state.view = {day:1,phase:'sheriff',finished:false,paused:false,
        players:[{seat:1,name:'再问一个为何'}],
        live:{seat:1,task:'sheriff_speech',startedAt:Date.now()-8000,public:true,text:''}};
      state.playerView = state.view;
      showScreen(isMobile ? 'm-game' : 'screen-game');
      const flow = document.getElementById(isMobile ? 'm-flow' : 'stream');
      const filler = document.createElement('div');
      filler.style.height = '1600px';
      flow.prepend(filler);
      flow.scrollTop = 0;
      window.__clockFixture = {
        node:document.getElementById(isMobile ? 'm-live' : 'live-typing'),
        body:document.querySelector(isMobile ? '#m-live .live-body' : '#live-typing .typing-body'),
        flow, scroll:flow.scrollTop,
      };
    }, mobile);
    const bubble = page.locator(`#${nodeId}`);
    const counter = bubble.locator(clockSelector);
    const elapsed = text => Number(text.match(/(?:已\s*|·\s*)(\d+)s/)[1]);
    const first = elapsed(await counter.textContent());
    check(first >= 8, `${name}: server start survives first render`, first);
    check((await bubble.textContent()).includes('正在思考'), `${name}: initial thinking state`);
    // No SSE/view frames are supplied during this interval.
    await page.waitForTimeout(2250);
    check(elapsed(await counter.textContent()) >= first+2, `${name}: clock advances without new frames`);
    const stable = await page.evaluate(() => ({
      node:window.__clockFixture.node === document.getElementById(window.__clockFixture.node.id),
      body:window.__clockFixture.body.isConnected,
      scroll:window.__clockFixture.flow.scrollTop === window.__clockFixture.scroll,
    }));
    check(stable.node && stable.body && stable.scroll, `${name}: tick preserves body and reader scroll`, stable);
    await bubble.screenshot({path:`output/playwright/live-clock-${name}-thinking.png`});

    const render = async values => page.evaluate(({isMobile,values}) => {
      Object.assign(state.view, values.view || {});
      if (values.live) Object.assign(state.view.live, values.live);
      if ('voteProgress' in values) state.voteProgress = values.voteProgress;
      if (isMobile) updateLive(state.view); else renderLive(state.view);
    }, {isMobile:mobile,values});
    await render({live:{startedAt:Date.now(),text:''}});
    check(elapsed(await counter.textContent()) <= 1, `${name}: same seat/task new request resets elapsed`);
    await render({live:{status:'queued'}});
    check((await bubble.textContent()).includes('等待模型通道'), `${name}: queue wait is distinguished from thinking`);
    await render({live:{status:'retrying',attempt:2,text:'',reasoning:''}});
    check((await bubble.textContent()).includes('正在重试（第 2 次）'), `${name}: retry state is visible, not an endless thinking label`);
    await bubble.screenshot({path:`output/playwright/live-clock-${name}-retrying.png`});
    await render({live:{status:'thinking'}});
    await render({live:{text:'首夜没有公开发言，我先听后置位的说明。'}});
    check((await bubble.textContent()).includes('正在发言'), `${name}: first text switches thinking to speaking`);
    check((await bubble.locator(bodySelector).textContent()).includes('首夜没有公开发言'), `${name}: public text displayed`);
    await render({live:{public:false,text:'PRIVATE_ACTION_MARKER',reasoning:'PRIVATE_REASON_MARKER'}});
    check(!(await bubble.textContent()).includes('PRIVATE_'), `${name}: no private text or reasoning leak`);
    await render({live:{status:'retrying',attempt:3,text:'',reasoning:'PRIVATE_REASON_MARKER'}});
    check((await bubble.textContent()).includes('第 3 次')&&!(await bubble.textContent()).includes('PRIVATE_'), `${name}: private retries never expose reasoning/target`);
    const notice = await page.evaluate(() => {
      const event={type:'ai_status',actor:1,data:{status:'degraded',message:'模型响应异常，本次已使用规则兜底行动。'},visibleTo:'all'};
      const node=renderEventNode(event);
      return node.textContent;
    });
    check(notice.includes('规则兜底'), `${name}: fallback is explicitly shown in the event flow`);
    await render({view:{paused:true}});
    check(await bubble.count() === 0 && await page.evaluate(() => !state.liveClockTimer), `${name}: pause removes timer and bubble`);
    await render({view:{paused:false},live:{public:true,text:'',reasoning:'',status:'thinking'}});
    await page.evaluate(isMobile => showScreen(isMobile ? 'm-boards' : 'screen-setup'), mobile);
    check(await page.evaluate(() => !state.liveClockTimer), `${name}: leaving game stops timer`);
    await page.evaluate(isMobile => showScreen(isMobile ? 'm-game' : 'screen-game'), mobile);
    check(await page.evaluate(() => Boolean(state.liveClockTimer)), `${name}: return resumes one timer`);

    await render({view:{live:null},voteProgress:{done:2,total:9,at:Date.now()-5000}});
    const voteFirst = elapsed(await counter.textContent());
    // Allow two ticks: the interval may be out of phase with the vote start's second boundary.
    await page.waitForTimeout(2250);
    check(elapsed(await counter.textContent()) >= voteFirst+1 && (await bubble.textContent()).includes('2/9'), `${name}: vote progress also ticks without frames`);
    await render({view:{live:{seat:1,task:'speech',public:true,text:'',startedAt:Date.now()}}});
    check((await bubble.locator(bodySelector).textContent()).includes('正在思考'), `${name}: live speech replaces previous voting body`);
    await render({view:{finished:true}});
    check(await bubble.count() === 0 && await page.evaluate(() => !state.liveClockTimer), `${name}: finish clears timer and bubble`);
    await page.evaluate(() => { stopPolling(); state.game=null; state.view=null; state.playerView=null; });
  }
  check(mutations === 0, 'no game creation/resume/action requests', mutations);
  check(errors.length === 0, 'no browser exceptions', errors);
  return {checks:checks.length, passed:checks, errors, mutations};
}
