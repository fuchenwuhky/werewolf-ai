/* Read-only browser regression: never confirm game creation or edit real profiles. */
/* global document, window, getComputedStyle, matchMedia, innerWidth */
async (page) => {
  const checks = [];
  const errors = [];
  let creates = 0;
  const check = (ok, label, detail) => {
    if (!ok) throw new Error(`${label}: ${JSON.stringify(detail)}`);
    checks.push(label);
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/games', async route => {
    if (route.request().method() === 'POST') {
      creates++;
      await route.abort(); // Never create a game or call a live model during layout checks.
    } else await route.continue();
  });
  await page.goto('http://127.0.0.1:3210/m/');
  await page.waitForFunction(() => window.__wwReady);
  await page.locator('#m-play-new').click();
  await page.locator('#m-mock-btn').click();
  await page.locator('#m-mode-next').click();
  await page.locator('#m-next').click();
  await page.locator('#m-my-seat').selectOption('3');
  await page.locator('#m-my-name').fill('月下玩家🌙');
  const owner = await page.locator('#m-profile-select').inputValue();
  check(Boolean(owner), 'selected profile loaded');

  for (const font of ['std', 'lg']) {
    await page.evaluate(value => { document.documentElement.dataset.prefFont = value; }, font);
    for (const [width, height] of [[1366,768], [1024,768], [844,390], [430,932], [390,844], [360,800], [320,568]]) {
      await page.setViewportSize({width, height});
      await page.locator('#m-rules > .m-scroll').evaluate(node => { node.scrollTop = 0; });
      await page.locator('#m-my-seat').selectOption('random');
      await page.locator('#m-rules-title').click(); // Capture the neutral state, not an accidental focus ring.
      const layout = await page.evaluate(() => {
        const rect = e => {
          const r = e.getBoundingClientRect();
          return {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom};
        };
        const controls = [...document.querySelectorAll('#m-rules input, #m-rules select, #m-profile-manage, .m-participation-ai > a')];
        const seat = document.querySelector('#m-my-seat');
        const selectStyle = getComputedStyle(seat);
        const canvas = document.createElement('canvas').getContext('2d');
        canvas.font = selectStyle.font;
        const scroll = document.querySelector('#m-rules > .m-scroll');
        return {
          compact: matchMedia('(min-width: 768px) and (pointer: fine)').matches,
          controls: controls.map(e => ({id:e.id || 'ai-cast', ...rect(e)})),
          seat:rect(seat), card:rect(document.querySelector('.m-participation-card')),
          next:rect(document.querySelector('#m-start')),
          overflow:scroll.scrollWidth - scroll.clientWidth,
          appearance:selectStyle.appearance, arrow:selectStyle.backgroundImage,
          seatTextFits:canvas.measureText(seat.selectedOptions[0].textContent).width <= seat.clientWidth - parseFloat(selectStyle.paddingLeft) - parseFloat(selectStyle.paddingRight),
          legacyNodes:document.querySelector('#m-rules-list').closest('#m-board-options-body') !== null,
        };
      });
      const label = `${width}x${height}/${font}`;
      check(layout.card.width <= 681, `bounded form ${label}`, layout.card);
      check(layout.seat.width <= 200, `compact seat select ${label}`, layout.seat);
      check(layout.appearance === 'none' && layout.arrow.includes('data:image/svg'), `themed select ${label}`, layout);
      check(layout.seatTextFits, `random option not truncated ${label}`, layout.seat);
      check(layout.overflow <= 1, `no horizontal form overflow ${label}`, layout);
      check(layout.controls.every(r => r.height === (layout.compact ? 40 : 48) && r.x >= 0 && r.right <= width), `controls aligned and contained ${label}`, layout.controls);
      check(layout.next.height >= 52 && layout.next.right <= width && layout.next.bottom <= height, `reachable confirmation ${label}`, layout.next);
      check(layout.next.width <= 681, `bounded confirmation action ${label}`, layout.next);
      check(layout.legacyNodes, `board rules remain in previous step ${label}`);
      await page.screenshot({path:`output/playwright/participation-${width}-${font}-after.png`});
    }
  }

  await page.setViewportSize({width:390, height:844});
  await page.evaluate(() => { document.documentElement.dataset.prefFont = 'std'; });
  await page.locator('#m-my-seat').selectOption('3');
  await page.locator('#m-my-name').fill('月'.repeat(39) + '🌙');
  const beforeName = await page.locator('#m-my-name').inputValue();
  await page.locator('#m-back').click();
  check(await page.locator('#m-board-grid').isVisible(), 'back returns to board selection');
  await page.locator('#m-next').click();
  check(await page.locator('#m-my-name').inputValue() === beforeName, 'long nickname draft survives back');
  check(await page.locator('#m-my-seat').inputValue() === '3', 'seat draft survives back');
  check(await page.locator('#m-profile-select').inputValue() === owner, 'profile ownership unchanged');

  await page.locator('#m-profile-manage').click();
  check(await page.locator('#m-sheet .pm-list').isVisible(), 'profile manager opens');
  await page.locator('#m-sheet .m-sheet-head button').click();
  check(await page.locator('#m-rules').isVisible(), 'profile manager returns to participation');

  // A long selected profile is a DOM-only fixture: do not edit the user's real profile.
  await page.locator('#m-profile-select').evaluate(select => {
    select.selectedOptions[0].textContent = '长昵称玩家'.repeat(8);
  });
  await page.setViewportSize({width:320, height:568});
  await page.locator('#m-profile-select').scrollIntoViewIfNeeded();
  check(await page.locator('#m-profile-select').evaluate(e => e.getBoundingClientRect().right <= innerWidth), 'long profile remains within screen');
  await page.screenshot({path:'output/playwright/participation-320-long-profile.png'});
  await page.locator('#m-start').click();
  await page.locator('#m-confirm-create').waitFor({state:'visible'});
  check(await page.locator('#m-confirm-create').isVisible(), 'next opens confirmation without creating a game');
  const action = await page.locator('#m-confirm-create').boundingBox();
  check(action && action.y + action.height <= 568, 'final confirmation stays visible', action);
  await page.locator('#m-sheet .m-sheet-head button').click();
  check(await page.locator('#m-my-name').inputValue() === beforeName, 'closing confirmation keeps draft');

  // Focus styles must not erase the shared SVG arrow (a previous CSS regression).
  await page.locator('#m-my-seat').focus();
  check(await page.locator('#m-my-seat').evaluate(e => getComputedStyle(e).backgroundImage.includes('data:image/svg')), 'focus preserves select arrow');
  check(creates === 0, 'no games created during inspection', creates);
  check(errors.length === 0, 'no unhandled browser errors', errors);

  const touch = await page.context().browser().newContext({viewport:{width:844,height:390}, isMobile:true, hasTouch:true});
  try {
    const touchPage = await touch.newPage();
    await touchPage.goto('http://127.0.0.1:3210/m/');
    await touchPage.waitForFunction(() => window.__wwReady);
    await touchPage.locator('#m-play-new').click();
    await touchPage.locator('#m-mock-btn').click();
    await touchPage.locator('#m-mode-next').click();
    await touchPage.locator('#m-next').click();
    const touchSizes = await touchPage.locator('#m-rules input, #m-rules select, #m-profile-manage').evaluateAll(nodes => nodes.map(e => e.getBoundingClientRect().height));
    check(touchSizes.every(size => size === 48), 'landscape touch controls remain 48px', touchSizes);
    await touchPage.screenshot({path:'output/playwright/participation-844-touch-after.png'});
  } finally { await touch.close(); }
  return {passed:checks.length, checks, screenshots:'output/playwright/participation-*.png'};
}
