/* Run against an ISOLATED local data directory only:
   playwright-cli -s=refine run-code --filename=scripts/ui-refinement.playwright.js
   Uses the CLI's current localhost page. No provider requests or production data. */
/* global document, getComputedStyle, innerWidth, innerHeight, localStorage, sessionStorage */
async (page) => {
  const origin = new URL(page.url()).origin;
  if (!/^http:\/\/127\.0\.0\.1:3598$/.test(origin)) throw new Error('Use isolated QA server at 127.0.0.1:3598');
  const context = await page.context().browser().newContext();
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checks = [];
  const assert = (ok, label, detail) => { if (!ok) throw new Error(`${label}: ${JSON.stringify(detail)}`); checks.push(label); };
  const shot = async (name) => {
    if (await page.locator('#m-flash').count()) await page.locator('#m-flash').waitFor({state:'hidden'});
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(e=>e.getClientRects().length || e.closest('.r3-card')).map(e=>e.decode().catch(()=>{}))); });
    await page.screenshot({ path: `output/playwright/refinement/${name}.png`, animations: 'disabled' });
  };
  const geometry = async (label) => {
    const result = await page.evaluate(() => {
      const visible = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const broken = [...document.images].filter((e) => visible(e) && e.complete && !e.naturalWidth).map((e) => e.getAttribute('src'));
      const over = [...document.querySelectorAll('.m-screen:not(.hidden), .screen:not(.hidden), .m-scroll, .setup-scroll')].filter(visible).filter((e) => e.scrollWidth > e.clientWidth + 2).map((e) => e.id || e.className);
      const min = document.querySelector('#m-app') ? 48 : 40;
      const small = [...document.querySelectorAll('button:not(:disabled), input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), select')].filter(visible).filter(e=>!e.closest('[inert]')).filter(e=>{const r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && (r.height<min-1 || r.width<min-1);}).map(e=>({id:e.id,cls:e.className,h:e.getBoundingClientRect().height,w:e.getBoundingClientRect().width}));
      return { broken, over, small, body: document.documentElement.scrollWidth <= innerWidth + 2 };
    });
    assert(result.body && !result.over.length && !result.broken.length, `${label}: no overflow or broken images`, result);
    assert(!result.small.length, `${label}: controls meet minimum size`, result.small);
  };
  const desktopNav = async (id) => {
    if (page.viewportSize().width < 1200) await page.locator('#ng-menu-toggle').click();
    await page.locator(id).click();
  };
  const avatarRoundtrip = async (mobile) => {
    const edit = mobile ? '#m-pc-edit' : '#pc-edit-current';
    await page.locator(edit).click();
    const nickname = '月下旅人'.repeat(3) + '🌙';
    await page.locator('#profile-form-nick').fill(nickname);
    await page.locator('#av-file').setInputFiles('web/assets/roles/seer.png');
    await page.locator('#av-crop-confirm').waitFor();
    await geometry(`${mobile ? 'mobile' : 'desktop'} avatar crop`);
    await shot(`${mobile ? 'mobile-390' : 'desktop-1440'}-avatar-crop`);
    await page.locator('#av-crop-zoom-in').click();
    await page.locator('#av-crop-confirm').click();
    assert(await page.locator('#profile-form-nick').inputValue() === nickname, 'avatar crop preserves nickname draft');
    await page.getByRole('button', {name:'保存',exact:true}).click();
    await page.locator('#profile-form-nick').waitFor({state:'hidden'});
    await page.locator(edit).waitFor();
    if (mobile) {
      await page.keyboard.press('Escape');
      await page.locator('.m-sheet-mask').waitFor({state:'hidden'});
      await page.locator('#m-tab-me').click();
    }
    await page.locator(edit).click();
    await page.locator('#av-current-note').filter({hasText:'当前使用自定义头像'}).waitFor();
    assert(true, `${mobile ? 'mobile' : 'desktop'} avatar upload persists`);
    page.once('dialog', d=>d.accept());
    await page.locator('#av-delete-custom').click();
    await page.locator('#av-current-note').filter({hasText:'内置徽记'}).waitFor();
    assert(true, `${mobile ? 'mobile' : 'desktop'} avatar removal returns to builtin`);
    await page.getByRole('button', {name:'保存',exact:true}).click();
    await page.locator('#profile-form-nick').waitFor({state:'hidden'});
    if (mobile) { await page.keyboard.press('Escape'); await page.locator('.m-sheet-mask').waitFor({state:'hidden'}); await page.locator('#m-tab-me').click(); }
    await page.locator(edit).waitFor();
    const font = mobile ? '#m-pc-pref-font' : '#pc-pref-font';
    await page.locator(font).selectOption('lg');
    await page.waitForFunction(()=>document.documentElement.dataset.prefFont==='lg');
    await geometry(`${mobile ? 'mobile' : 'desktop'} player large font and long name`);
    await shot(`${mobile ? 'mobile-390' : 'desktop-1440'}-player-large`);
    await page.locator(font).selectOption('std');
  };
  await page.goto(origin);
  await page.evaluate(() => { localStorage.removeItem('ww_current'); sessionStorage.setItem('ww_return_home_once', '1'); });
  await page.reload();
  await page.locator('#btn-start').waitFor({state:'visible'});
  for (const [width, height] of [[1920,1080],[1440,900],[1280,720],[1024,768]]) {
    await page.setViewportSize({width,height});
    await desktopNav('#entry-lobby');
    await geometry(`desktop lobby ${width}`); await shot(`desktop-${width}-lobby`);
    await desktopNav('#entry-settings');
    assert(await page.locator('#card-api input:visible').count() === 3, 'model basic section contains only 3 fields');
    for (const group of ['appearance','device','about','model']) {
      await page.locator(`[data-settings-category=${group}]`).click();
      await geometry(`settings ${group} ${width}`);
    }
    await shot(`desktop-${width}-settings`);
    if (width < 1200) await page.locator('#ng-menu-toggle').click();
    await page.locator('#ng-side-nav button', {hasText:'玩家中心'}).click();
    await page.locator('#pc-edit-current').waitFor();
    assert(await page.locator('#modal-root .modal').count() === 0, 'player center is a page, not a modal');
    await geometry(`player center ${width}`); await shot(`desktop-${width}-player`);
    await desktopNav('#btn-codex');
    await page.locator('.cdx-card').first().waitFor();
    const detail = await page.locator('.cdx-detail').boundingBox();
    const catalog = await page.locator('.cdx-grid').boundingBox();
    assert(Math.abs(detail.y - catalog.y) < 2 && detail.x > catalog.x, `desktop codex has aligned columns at ${width}`);
    await geometry(`codex ${width}`); await shot(`desktop-${width}-codex`);
    await page.locator('#btn-codex-back').click();
  }
  await page.setViewportSize({width:1440,height:900});
  await desktopNav('#entry-settings');
  await page.locator('#ng-side-nav button', {hasText:'玩家中心'}).click();
  await page.locator('#pc-edit-current').waitFor();
  await page.goBack();
  assert(await page.locator('#screen-setup').getAttribute('data-view') === 'settings', 'desktop browser back restores previous page');
  await page.locator('#ng-side-nav button', {hasText:'玩家中心'}).click();
  await avatarRoundtrip(false);
  await desktopNav('#entry-lobby');
  let creates = 0;
  page.on('request', (req) => { if (req.method() === 'POST' && req.url() === `${origin}/api/games`) creates++; });
  await page.locator('#btn-start').click();
  await page.locator('#wizard-mode-mock').click();
  await page.locator('#setup-next').click();
  assert(!await page.locator('#board-editor').isVisible(), 'preset role editor collapsed');
  await page.locator('#board-template').selectOption('custom');
  assert(await page.locator('#board-editor').isVisible(), 'custom role editor available');
  await page.locator('#board-template').selectOption('adv12');
  await page.locator('#setup-next').click();
  await page.locator('#my-name').fill('长昵称与表情测试玩家🌙');
  await page.locator('#setup-prev').click();
  await page.locator('#setup-next').click();
  assert(await page.locator('#my-name').inputValue() === '长昵称与表情测试玩家🌙', 'wizard back preserves draft');
  await page.locator('#setup-next').click();
  assert(creates === 0, 'no game created before final confirmation');
  await shot('desktop-1440-confirm');
  await page.locator('#setup-confirm').dblclick();
  await page.locator('#flip-card').waitFor();
  assert(creates === 1, 'double confirmation creates exactly one game', creates);
  await page.locator('#flip-card').click();
  await page.locator('#btn-flip-done').click();
  await page.locator('.seat-row').first().waitFor();
  assert(!await page.locator('#notes-drawer').isVisible(), 'empty notes initially closed');
  const seats = await page.locator('#seats-list').evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return [...list.children].filter((row) => { const r = row.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= bounds.bottom + 1; }).length;
  });
  assert(seats >= 6, '1440x900 shows at least 6 complete seats', seats);
  await shot('desktop-1440-game');
  await page.locator('#btn-notes').click();
  assert(await page.locator('#notes-drawer.docked').isVisible(), 'wide notes dock opens');
  await shot('desktop-1440-notes');
  await page.locator('#btn-notes-close').click();
  const note = '这是保留两百字长笔记的排版与持久化回归检查。'.repeat(10).slice(0,200);
  await page.locator('.seat-row .tag-btn').first().click();
  await page.locator('#modal-root textarea').fill(note);
  await geometry('desktop note editor');
  await page.getByRole('button', {name:'保存笔记', exact:true}).click();
  await page.locator('#modal-root textarea').waitFor({state:'hidden'});
  assert(await page.locator('#btn-notes').getAttribute('data-count') === '1', 'saved note count is visible');
  await page.locator('.seat-row .tag-btn').first().click();
  assert(await page.locator('#modal-root textarea').inputValue() === note, '200 character note persists without truncation');
  await page.keyboard.press('Escape');
  for (const [width,height] of [[1920,1080],[1280,720],[1024,768],[900,700]]) {
    await page.setViewportSize({width,height});
    await geometry(`game ${width}`);
    await page.locator('#btn-notes').click();
    assert(await page.locator('#notes-drawer').isVisible(), `notes accessible ${width}`);
    if (width < 1440) assert(!await page.locator('#notes-drawer').evaluate(e=>e.classList.contains('docked')), `notes drawer at ${width}`);
    await shot(`desktop-${width}-game-notes`);
    await page.locator('#btn-notes-close').click();
  }
  // Mobile uses the same real server but its own handle namespace.
  await page.goto(`${origin}/m/`);
  for (const [width,height] of [[430,932],[390,844],[360,800],[320,568],[844,390]]) {
    await page.setViewportSize({width,height});
    await page.locator('#m-tab-start').click();
    assert(!await page.locator('#m-board-grid').isVisible(), 'mobile lobby contains no setup form');
    await geometry(`mobile lobby ${width}`); await shot(`mobile-${width}-lobby`);
    await page.locator('#m-tab-me').click();
    await page.locator('#m-pc-edit').waitFor();
    await geometry(`mobile player ${width}`); await shot(`mobile-${width}-player`);
    await page.locator('#m-tab-codex').click();
    await page.locator('.cdx-card').first().waitFor();
    const search = await page.locator('#cdx-search').boundingBox();
    assert(search.height >= 48, `mobile search touch area ${width}`, search);
    assert(await page.locator('#cdx-search').evaluate(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;}), `mobile search is not covered at ${width}`);
    await geometry(`mobile codex ${width}`); await shot(`mobile-${width}-codex`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#m-tab-me').click();
  await page.locator('#m-pc-edit').waitFor();
  await avatarRoundtrip(true);
  await page.locator('#m-tab-start').click();
  await page.locator('#m-settings-btn').click();
  await page.locator('[data-mobile-settings=model]').click();
  await page.locator('#ms-save').waitFor();
  await geometry('mobile model'); await shot('mobile-390-settings');
  await page.locator('#m-settings-back').click();
  assert(await page.locator('#m-settings-menu').isVisible(), 'settings category back returns to settings list');
  await page.locator('#m-settings-back').click();
  await page.locator('#m-play-new').click();
  await page.locator('#m-mock-btn').click();
  await page.locator('#m-mode-next').click();
  await geometry('mobile board'); await shot('mobile-390-board');
  await page.locator('#m-next').click();
  await page.locator('#m-my-name').fill('月下玩家🌙');
  await page.locator('#m-back').click();
  assert(await page.locator('#m-board-grid').isVisible(), 'mobile previous returns to board');
  await page.locator('#m-next').click();
  assert(await page.locator('#m-my-name').inputValue() === '月下玩家🌙', 'mobile back preserves player draft');
  const before = creates;
  await page.locator('#m-start').click();
  await page.locator('#m-confirm-create').waitFor();
  assert(creates === before, 'mobile confirmation sheet does not create a game');
  await shot('mobile-390-confirm');
  const confirmRect = await page.locator('#m-confirm-create').boundingBox();
  assert(confirmRect.y + confirmRect.height <= 844, 'mobile final action is in viewport', confirmRect);
  await page.locator('#m-confirm-create').dblclick();
  await page.locator('#m-flip-card').waitFor();
  assert(creates === before + 1, 'mobile double confirmation creates exactly one game');
  await page.locator('#m-flip-card').click();
  await page.locator('#m-flip-done').click();
  await page.locator('#m-flash').waitFor({state:'hidden'});
  await shot('mobile-390-game');
  await geometry('mobile game');
  await page.locator('#m-tabbtn-notes').click();
  assert(await page.locator('#m-notes-pane').isVisible(), 'mobile notes page visible');
  await shot('mobile-390-notes');
  for (const [width,height] of [[430,932],[360,800],[320,568],[844,390],[390,500]]) {
    await page.setViewportSize({width,height});
    await page.locator('#m-tabbtn-speech').click();
    await geometry(`mobile game ${width}x${height}`);
    await shot(`mobile-${width}x${height}-game`);
  }
  assert(errors.length === 0, 'no unhandled browser errors', errors);
  return {passed: checks.length, checks, screenshots:'output/playwright/refinement/'};
}
