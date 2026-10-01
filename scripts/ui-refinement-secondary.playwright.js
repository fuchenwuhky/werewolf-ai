/* Run with playwright-cli on the isolated http://127.0.0.1:3598 server. */
/* global document, window, sessionStorage, localStorage, getComputedStyle, innerWidth, innerHeight */
async (page) => {
  const origin = new URL(page.url()).origin;
  if (origin !== 'http://127.0.0.1:3598') throw new Error('Isolated QA server required');
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const checks = [];
  const assert = (ok, label, value) => { if (!ok) throw new Error(`${label}: ${JSON.stringify(value)}`); checks.push(label); };
  const shot = async (name) => {
    await page.evaluate(async()=>{ await document.fonts.ready; await Promise.all([...document.images].filter(e=>e.getBoundingClientRect().top < innerHeight).map(e=>e.decode().catch(()=>{}))); });
    await page.screenshot({path:`output/playwright/refinement/${name}.png`,animations:'disabled'});
  };
  for (const [width,height] of [[1440,900],[390,844],[320,568]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${origin}/ai-cast.html${width < 768 ? '?from=mobile' : ''}`);
    assert(await page.locator('.cast-card').count() === 24, `AI roster has 24 cards at ${width}`);
    const boxes = await page.locator('.cast-card').evaluateAll(es=>es.slice(0,3).map(e=>({x:e.offsetLeft,y:e.offsetTop})));
    if (width < 768) assert(boxes[0].y === boxes[1].y && boxes[2].y > boxes[0].y, `mobile AI roster remains two columns at ${width}`, boxes);
    await shot(`${width < 768 ? 'mobile' : 'desktop'}-${width}-ai-cast`);
    await page.locator('.cast-view').first().click();
    assert(await page.locator('.cast-detail').isVisible(), 'AI detail dialog opens');
    await shot(`${width < 768 ? 'mobile' : 'desktop'}-${width}-ai-detail`);
    await page.keyboard.press('Escape');
    assert(await page.locator('.cast-view').first().evaluate(e=>document.activeElement===e), 'AI detail restores focus');
    await page.locator('#cast-search').fill('不存在的来客-000');
    assert(await page.locator('#cast-empty').isVisible() && await page.locator('.cast-card:visible').count() === 0, 'AI search has a visible empty state');
    assert(await page.locator('#cast-back').getAttribute('href') === (width < 768 ? '/m/' : '/'), 'AI return link matches platform');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2), `AI roster no horizontal overflow at ${width}`);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin);
  await page.evaluate(()=>{ localStorage.removeItem('ww_current'); sessionStorage.setItem('ww_return_home_once','1'); });
  await page.reload();
  await page.waitForFunction(()=>window.__wwReady === true);
  await page.locator('#entry-history').click();
  await page.locator('#history-page').waitFor({state:'visible'});
  await shot('desktop-1440-history');
  await page.locator('#entry-rulebook').click();
  await page.locator('#rulebook-page').waitFor({state:'visible'});
  await shot('desktop-1440-rulebook');
  await page.setViewportSize({width:1024,height:768});
  await page.locator('#ng-menu-toggle').click();
  assert(await page.locator('#ng-nav-dialog').evaluate(e=>e.open), 'narrow desktop uses native modal navigation');
  await shot('desktop-1024-menu');
  await page.keyboard.press('Escape');
  assert(await page.locator('#ng-menu-toggle').evaluate(e=>document.activeElement===e), 'navigation restores focus');
  // A blocked stats request must remain an actionable error, never a blank player page.
  await page.route('**/api/profiles/*/stats', route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试：战绩暂不可用'})}));
  await page.locator('#ng-menu-toggle').click();
  await page.locator('#ng-side-nav button',{hasText:'玩家中心'}).click();
  await page.locator('#pc-edit-current').waitFor();
  assert((await page.locator('#player-page-body').innerText()).includes('失败'), 'stats failure is shown without blocking profile editing');
  await shot('desktop-1024-player-error');
  // Token contrast: image/gradient surfaces are intentionally excluded from this numerical check.
  const contrast = await page.evaluate(()=>{
    const s=getComputedStyle(document.documentElement);
    const rgb=n=>{const hex=s.getPropertyValue(n).trim().slice(1);return [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255);};
    const lum=v=>v.map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[0.2126,0.7152,0.0722][i],0);
    return ['--ng-ink','--ng-surface','--ng-raised'].flatMap(bg=>['--ng-ivory','--ng-muted','--ng-gold'].map(fg=>({bg,fg,ratio:(lum(rgb(fg))+.05)/(lum(rgb(bg))+.05)})));
  });
  for (const pair of contrast) assert(pair.ratio>=4.5, `text token contrast ${pair.fg} / ${pair.bg}`, pair);
  await context.close();
  return {passed:checks.length,checks,contrast};
}
