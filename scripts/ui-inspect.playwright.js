/* Read-only browser regression: no game creation or model requests. */
/* global document, window */
async (page) => {
  const origin = new URL(page.url()).origin;
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const checks = [], errors = [];
  const ok = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  page.on('pageerror', error => errors.push(error.message));
  const inspect = async (source, button, label) => {
    await button.scrollIntoViewIfNeeded();
    await source.evaluate((element,label) => {
      window.__inspectSource = { element, label, text: element.textContent, scroll: element.querySelector('.mbody')?.scrollTop || 0 };
    },label);
    await button.click();
    await page.locator('.inspect-stage').waitFor({state:'visible'});
    ok(await source.isHidden(), `${label}: source layer is suspended immediately`);
    ok(await source.count() === 1, `${label}: source DOM is kept`);
    ok(await page.locator('.inspect-stage').evaluate(stage => {
      const rect = stage.querySelector('.inspect-card').getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.inspect-stage') === stage;
    }), `${label}: large card is on top and receives input`);
    await page.keyboard.press('Tab');
    ok(await page.locator('.inspect-close').evaluate(button => button === document.activeElement), `${label}: keyboard focus stays in inspection`);
    const close = await page.locator('.inspect-close').boundingBox();
    const card = await page.locator('.inspect-card').boundingBox();
    const {width,height} = page.viewportSize();
    ok(close.x >= 0 && close.y >= 0 && close.x + close.width <= width && close.y + close.height <= height && close.height >= 48, `${label}: close control is visible and touch sized`);
    ok(card.x >= 0 && card.y >= close.y + close.height - 1 && card.x + card.width <= width && card.y + card.height <= height, `${label}: card fits without covering close control`);
  };
  const restored = async (source, button, label) => {
    await page.locator('.inspect-stage').waitFor({state:'detached'});
    ok(await source.isVisible(), `${label}: closing inspection returns to source`);
    ok(await source.evaluate(element => element === window.__inspectSource.element && element.textContent === window.__inspectSource.text
      && Math.abs((element.querySelector('.mbody')?.scrollTop || 0) - window.__inspectSource.scroll) <= 1), `${label}: original role, DOM and scroll are preserved`);
    ok(await button.evaluate(element => element === document.activeElement), `${label}: focus returns to inspect action`);
    ok(await page.evaluate(() => document.body.classList.contains('ww-layer-open')), `${label}: source modal keeps its scroll lock`);
  };
  for (const [width,height] of [[390,844],[320,568],[844,390]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${origin}/m/`);
    await page.waitForFunction(() => window.__wwReady);
    await page.locator('#m-tab-codex').click();
    await page.locator('.cdx-card[data-role=wolf]').click();
    const source = page.locator('#m-modal .modal');
    const button = source.locator('.cdx-act-inspect');
    for (const method of width === 390 ? ['button','esc','native-back','browser-back'] : ['button']) {
      const label = `mobile ${width}x${height} ${method}`;
      await inspect(source,button,label);
      if (method === 'button') await page.locator('.inspect-close').click();
      else if (method === 'esc') await page.keyboard.press('Escape');
      else if (method === 'native-back') ok(await page.evaluate(() => window.__mwwBack()), 'mobile native bridge consumes only inspection');
      else await page.goBack();
      await restored(source,button,label);
    }
    if (width === 390) {
      await button.click();
      await page.screenshot({path:'output/playwright/inspect-mobile-open.png',animations:'disabled'});
      await page.locator('.inspect-close').click();
      await page.screenshot({path:'output/playwright/inspect-mobile-return.png',animations:'disabled'});
    }
    await source.getByRole('button',{name:'关闭',exact:true}).click();
    ok(await page.evaluate(() => !document.body.classList.contains('ww-layer-open') && !document.querySelector('#m-app').inert), `mobile ${width}: final close releases page`);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin);
  await page.waitForFunction(() => window.__wwReady);
  await page.locator('#btn-codex').click();
  await page.locator('.cdx-card[data-role=wolf]').click();
  const panelAction = page.locator('#cdx-detail .cdx-act-inspect');
  await panelAction.click();
  await page.locator('.inspect-stage').waitFor({state:'visible'});
  ok(await page.locator('#app').evaluate(element => element.inert), 'desktop inline detail: background cannot be interacted with');
  await page.keyboard.press('Escape');
  ok(await panelAction.evaluate(element => element === document.activeElement), 'desktop inline detail: Esc returns focus to same role');
  ok(await page.evaluate(() => !document.querySelector('#app').inert && !document.body.classList.contains('ww-layer-open')), 'desktop inline detail: closing inspection unlocks page');
  await page.locator('#btn-codex-rulebook').click();
  const source = page.locator('#modal-root .modal');
  await source.locator('.tabs').getByRole('button',{name:'角色图鉴',exact:true}).click();
  const button = source.locator('.r-card .btn').first();
  await inspect(source,button,'desktop modal');
  await page.screenshot({path:'output/playwright/inspect-desktop-open.png',animations:'disabled'});
  await page.keyboard.press('Escape');
  await restored(source,button,'desktop modal');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => !document.querySelector('#app').inert && !document.body.classList.contains('ww-layer-open')), 'desktop second Esc closes only source modal and unlocks page');
  ok(errors.length === 0, `no browser errors: ${errors.join(';')}`);
  await context.close();
  return {passed:checks.length,checks};
}
