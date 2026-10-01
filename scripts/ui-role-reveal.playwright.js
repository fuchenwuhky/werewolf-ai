/* Synthetic role views only; every game API request is intercepted. No real game/model mutation. */
/* global window, document, state, stopPolling, showScreen, maybeShowRole, showMyCard */
async (page) => {
  const checks = [], errors = []; let writes = 0;
  const check = (ok,label,detail) => { if (!ok) throw new Error(`${label}: ${JSON.stringify(detail)}`); checks.push(label); };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/games**', route => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({rows:[]})});
  });
  const setup = async (mobile,role='wolf') => {
    await page.evaluate(({mobile,role}) => {
      stopPolling(); state.roleShown=false; state.roleRevealed=false;
      state.view={day:1,phase:'night',finished:false,events:[],players:[],me:{seat:1,role,alive:true,teammates:role==='wolf'?[1,4,8]:[]}};
      showScreen(mobile?'m-game':'screen-game'); maybeShowRole(state.view);
    },{mobile,role});
  };
  for (const mobile of [false,true]) {
    const label = mobile?'mobile':'desktop', overlay=mobile?'#m-flip':'#role-overlay', card=mobile?'#m-flip-card':'#flip-card';
    const front=mobile?'#m-flip-front':'#flip-front', caption=mobile?'#m-flip-caption':'#flip-caption';
    const done=mobile?'#m-flip-done':'#btn-flip-done', inspect=mobile?'#m-inspect-btn':'#btn-inspect';
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:900});
    await page.goto(`http://127.0.0.1:3210/${mobile?'m/':''}`);
    await page.waitForFunction(() => window.__wwReady);
    let neutral;
    for (const role of ['wolf','seer','villager']) {
      await setup(mobile,role);
      const info = await page.evaluate(({overlay,front,caption,mobile}) => ({
        text:document.querySelector(overlay).innerText,
        front:document.querySelector(front).innerHTML, caption:document.querySelector(caption).innerHTML,
        back:document.querySelector(`${overlay} .flip-back`).innerHTML.replace(/r3-clip-[\w-]+/g,'CLIP'),
        inert:document.getElementById(mobile?'m-app':'app').inert,
        hintOutside:!document.querySelector(`${overlay} .flip-hint`).closest('.flip-card'),
      }),{overlay,front,caption,mobile});
      check(info.front===''&&info.caption===''&&!/狼队|夜袭|每晚袭击|检视|开始游戏/.test(info.text),`${label}: ${role} has no pre-reveal role content`,info);
      check(info.inert&&info.hintOutside,`${label}: background is inert, hint outside seal`,info);
      if (neutral) check(info.text===neutral.text&&info.back===neutral.back,`${label}: different secrets share identical unopened card`);
      neutral=info;
    }
    await setup(mobile);
    await page.screenshot({path:`output/playwright/reveal-${label}-unopened.png`});
    await page.locator(card).focus(); await page.keyboard.press('Tab');
    check(await page.locator(card).evaluate(el=>document.activeElement===el),`${label}: unopened card traps keyboard focus`);
    if (mobile) { await page.keyboard.press('Escape'); check(await page.locator(overlay).isVisible(),`${label}: Escape cannot bypass initial reveal`); }
    await page.keyboard.press('Enter');
    check(await page.locator(done).isHidden(),`${label}: controls stay hidden during turn`);
    await page.waitForFunction(sel=>document.querySelector(sel).classList.contains('revealed'),overlay);
    check((await page.locator(caption).innerText()).includes('狼队：1、4、8 号'),`${label}: teammates visible only after reveal`);
    check(await page.locator(done).isEnabled(),`${label}: confirmation unlocked`);
    await page.locator(inspect).click(); await page.locator('.inspect-stage').waitFor();
    await page.locator('.inspect-close').click();
    check(await page.locator(overlay).isVisible()&&await page.locator(caption).isVisible(),`${label}: inspection returns to revealed card`);
    await page.screenshot({path:`output/playwright/reveal-${label}-revealed.png`});
    await page.locator(done).click(); check(await page.locator(overlay).isHidden(),`${label}: confirm closes overlay`);
    check(await page.locator(mobile?'#m-app':'#app').evaluate(el=>!el.inert),`${label}: closing restores background interaction`);
    if (mobile) {
      await page.evaluate(()=>showMyCard());
      check(await page.locator(caption).isVisible(),`${label}: reopening remembers actual reveal`);
      await page.locator(done).click();
    }
    for (const size of mobile?[{width:320,height:568},{width:360,height:800},{width:568,height:320}]:[{width:1024,height:768},{width:1280,height:720}]) {
      await page.setViewportSize(size); await page.emulateMedia({reducedMotion:'reduce'}); await setup(mobile);
      await page.locator(card).click();
      await page.locator(done).scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(({overlay,done,inspect}) => {
        const layer=document.querySelector(overlay), rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};};
        return {overflow:layer.scrollWidth>layer.clientWidth,buttons:[rect(document.querySelector(done)),rect(document.querySelector(inspect))],height:window.innerHeight,width:window.innerWidth,
          broken:[...layer.querySelectorAll('img')].filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src)};
      },{overlay,done,inspect});
      check(!geometry.overflow&&geometry.buttons.every(b=>b.h>=48&&b.x>=0&&b.x+b.w<=geometry.width&&b.y>=0&&b.y+b.h<=geometry.height)&&!geometry.broken.length,`${label}: ${size.width}x${size.height} actions fit`,geometry);
      await page.screenshot({path:`output/playwright/reveal-${label}-${size.width}x${size.height}.png`});
      await page.locator(done).click();
    }
  }
  check(writes===0,'zero game/model mutations',writes); check(errors.length===0,'no runtime errors',errors);
  console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
}
