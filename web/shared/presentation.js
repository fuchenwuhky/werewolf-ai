/* Shared composition helpers. No API calls and no persistent state. */
'use strict';
(function (root) {
  // Short, interruptible transitions: no timers or delayed navigation/teardown.
  const motions = new Map();
  const motionPreference = root.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => !!motionPreference?.matches || document.documentElement.dataset.prefMotion === '0';
  function stopMotion() { for (const animation of motions.values()) animation.cancel(); motions.clear(); }
  motionPreference?.addEventListener('change', () => { if (reducedMotion()) stopMotion(); });
  if (root.MutationObserver) new root.MutationObserver(() => { if (reducedMotion()) stopMotion(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-pref-motion'] });
  function enter(element, slide = false) {
    if (!element) return;
    motions.get(element)?.cancel(); motions.delete(element);
    if (reducedMotion() || !element.animate || !element.getClientRects().length) return;
    const frames = slide ? [{ opacity: .45, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }] : [{ opacity: .55 }, { opacity: 1 }];
    const animation = element.animate(frames, { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    motions.set(element, animation);
    const clean = () => { if (motions.get(element) === animation) motions.delete(element); };
    animation.onfinish = clean; animation.oncancel = clean;
  }

  /** 暂存资料层而不销毁 DOM；检视结束后恢复焦点、滚动位置及原有模态状态。 */
  function beginInspection(stage) {
    const source = document.activeElement;
    const wasLocked = document.body.classList.contains('ww-layer-open');
    const close = node('button', 'btn ghost inspect-close', source?.closest('.modal') ? '返回资料' : '关闭检视');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭检视并返回');
    stage.appendChild(close);
    stage.setAttribute('role', 'dialog');
    stage.setAttribute('aria-modal', 'true');
    close.focus({ preventScroll: true });
    const backgrounds = [...document.querySelectorAll('#app, #m-app, #modal-root, #m-modal, #m-sheet, #role-overlay, #m-flip')].map((element) => ({
      element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'),
      suspended: element.classList.contains('ww-inspect-suspended'),
    }));
    for (const { element } of backgrounds) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
      if (element.id !== 'app' && element.id !== 'm-app') element.classList.add('ww-inspect-suspended');
    }
    document.body.classList.add('ww-layer-open');
    stage.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') { event.preventDefault(); close.focus({ preventScroll: true }); }
    });
    enter(stage);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      for (const { element, inert, ariaHidden, suspended } of backgrounds) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
        element.classList.toggle('ww-inspect-suspended', suspended);
      }
      document.body.classList.toggle('ww-layer-open', wasLocked);
      if (source?.isConnected) source.focus({ preventScroll: true });
    };
  }
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // 双端共用的身份揭示闸门：点击前连正面/说明 DOM 都不生成，不能仅靠透明度遮住。
  const roleReveals = new WeakMap();
  function roleReveal({ overlay, card, front, caption, hint, tools, done, inspect, renderFront, renderCaption, onReveal, onDone, onInspect, initiallyRevealed = false }) {
    roleReveals.get(overlay)?.cancel();
    let cancelled = false, turning = false, ready = false, timer = null;
    front.replaceChildren(); caption.replaceChildren();
    front.hidden = true; caption.hidden = true; tools.hidden = true; hint.hidden = false;
    front.setAttribute('aria-hidden', 'true'); caption.setAttribute('aria-hidden', 'true');
    done.disabled = true; inspect.disabled = true;
    overlay.classList.remove('revealed'); card.classList.remove('flipped');
    card.tabIndex = 0; card.setAttribute('aria-pressed', 'false');
    const finish = () => {
      if (cancelled || ready) return;
      ready = true; turning = false;
      renderCaption(caption);
      overlay.classList.add('revealed');
      front.removeAttribute('aria-hidden'); caption.removeAttribute('aria-hidden');
      caption.hidden = false; tools.hidden = false; hint.hidden = true;
      done.disabled = false; inspect.disabled = false;
      card.tabIndex = -1; card.setAttribute('aria-pressed', 'true');
      onReveal?.(); done.focus({ preventScroll: true });
    };
    const reveal = (immediate = false) => {
      if (cancelled || turning || ready) return;
      turning = true;
      renderFront(front); front.hidden = false;
      // 先提交牌背布局，再翻转；避免浏览器合并首绘导致动画跳过。
      card.getBoundingClientRect(); card.classList.add('flipped');
      if (immediate || reducedMotion()) finish();
      else {
        const inner = card.querySelector('.flip-inner');
        const style = root.getComputedStyle(inner);
        const seconds = value => value.endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value) || 0;
        const durations = style.transitionDuration.split(',').map(seconds);
        const delays = style.transitionDelay.split(',').map(seconds);
        const duration = Math.max(...durations.map((n, i) => n + delays[i % delays.length]));
        timer = root.setTimeout(finish, duration * 1000 + 20);
      }
    };
    card.onclick = () => reveal();
    card.onkeydown = event => {
      if (!event.isComposing && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); reveal(); }
    };
    done.onclick = () => { if (ready && !cancelled) onDone(); };
    inspect.onclick = () => { if (ready && !cancelled) onInspect(); };
    // 只有这一张牌及揭示后的两个操作参与焦点循环，不能 Tab 到后台的角色卡。
    overlay.onkeydown = event => {
      if (event.key !== 'Tab') return;
      const targets = ready ? [done, inspect] : [card];
      const index = targets.indexOf(document.activeElement);
      event.preventDefault(); targets[(index + (event.shiftKey ? targets.length - 1 : 1)) % targets.length].focus({ preventScroll: true });
    };
    const controller = { cancel() { cancelled = true; if (timer !== null) root.clearTimeout(timer); } };
    roleReveals.set(overlay, controller);
    overlay.classList.remove('hidden');
    if (initiallyRevealed) reveal(true);
    else card.focus({ preventScroll: true });
    return controller;
  }

  function stats(aggregate) {
    const s = aggregate || {};
    const wins = Number(s.wins || 0), losses = Number(s.losses || 0);
    const box = node('div', 'ng-stat-summary');
    const grid = node('dl', 'ng-stats');
    for (const [label, value] of [
      ['真实对局', Number(s.real || 0)],
      ['胜率', root.WWStatsBucket.rateText(wins / (wins + losses), wins + losses)],
      ['胜场', wins],
    ]) {
      const item = node('div');
      item.append(node('dt', null, label), node('dd', null, value));
      grid.appendChild(item);
    }
    const details = node('details', 'ng-stat-details');
    details.append(node('summary', null, '查看战绩明细与统计口径'), node('p', 'hint', root.WWStatsBucket.formatAggregate(s)));
    box.append(grid, details);
    return box;
  }

  function autosize(scope) {
    const resize = (e) => {
      if (e.target.tagName !== 'TEXTAREA' || !e.target.matches('#action-controls textarea, .m-dock textarea')) return;
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(160, Math.max(48, e.target.scrollHeight)) + 'px';
    };
    scope.addEventListener('input', resize);
  }

  function mobileViewport() {
    const viewport = root.visualViewport;
    const app = document.querySelector('#m-app');
    if (!viewport || !app) return;
    const sync = () => {
      const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      const keyboard = editing && viewport.scale === 1 && viewport.height < root.innerHeight - 100;
      app.classList.toggle('ng-keyboard-open', !!keyboard);
      app.style.setProperty('--ng-viewport-height', `${viewport.height}px`);
    };
    viewport.addEventListener('resize', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', () => requestAnimationFrame(sync));
  }

  const settingsGroups = [
    ['model', '模型与连接', '#card-api', '.setup-model-head'],
    ['appearance', '外观与操作', '#card-appearance', '.setup-appearance-head'],
    ['device', '设备与数据', '#card-device', '.setup-device-head'],
    ['about', '关于', '#card-about', '.setup-about-head'],
  ];
  function selectSettings(category) {
    const section = document.querySelector('#setup-section');
    if (!section) return;
    const changed = section.dataset.category !== category;
    section.dataset.category = category;
    section.querySelectorAll('[data-settings-category]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.settingsCategory === category)));
    if (changed) enter(section.querySelector(`[data-settings-panel="${category}"].card`), true);
  }
  function closeNavigation() {
    const dialog = document.querySelector('#ng-nav-dialog');
    if (dialog && dialog.open) dialog.close();
  }
  function modelForm(container, prefix) {
    const basic = ['baseurl', 'model', 'key'].map((id) => container.querySelector(`#${prefix}-${id}`)?.closest('label'));
    const actions = container.querySelector(prefix === 'cfg' ? '#btn-save-config' : '#ms-save')?.closest('.btnrow');
    const advanced = node('details', 'ng-advanced');
    advanced.appendChild(node('summary', null, '高级配置'));
    const body = node('div', 'ng-advanced-body');
    advanced.appendChild(body);
    for (const child of [...container.children]) {
      if (basic.includes(child) || child === actions || child.tagName === 'H2') continue;
      body.appendChild(child);
    }
    container.append(...basic.filter(Boolean), advanced);
    if (actions) { actions.classList.add('ng-form-actions'); container.appendChild(actions); }
    for (const [i, label] of basic.entries()) {
      if (!label) continue;
      const caption = label.querySelector('span');
      if (caption) { caption.removeAttribute('data-i18n'); caption.textContent = ['接口地址', '主模型', 'API 密钥'][i]; }
      else if (label.firstChild?.nodeType === 3) label.firstChild.textContent = ['接口地址', '主模型', 'API 密钥'][i];
    }
    const heading = container.querySelector('h2');
    if (heading) heading.removeAttribute('data-no');
  }
  function desktop({ onPlayerBack, onProfiles }) {
    const q = (s) => document.querySelector(s);
    const side = q('#ng-side-nav');
    const anchor = document.createComment('navigation anchor');
    side.before(anchor);
    const dialog = q('#ng-nav-dialog');
    const toggle = q('#ng-menu-toggle');
    const media = matchMedia('(min-width: 1200px)');
    const place = () => { closeNavigation(); if (media.matches) anchor.after(side); else dialog.appendChild(side); };
    media.addEventListener('change', place); place();
    toggle.addEventListener('click', () => { dialog.showModal(); toggle.setAttribute('aria-expanded', 'true'); });
    q('#ng-nav-close').addEventListener('click', closeNavigation);
    dialog.addEventListener('click', (e) => { if (e.target === dialog || e.target.closest('.home-entry, .ng-side-active')) closeNavigation(); });
    dialog.addEventListener('close', () => { toggle.setAttribute('aria-expanded', 'false'); });
    q('#player-page-back').addEventListener('click', onPlayerBack);
    const player = node('button', 'btn ghost home-entry', '玩家中心');
    player.type = 'button'; player.dataset.wwIcon = 'players'; player.addEventListener('click', onProfiles);
    q('#entry-history').before(player);
    const section = q('#setup-section');
    const nav = node('nav', 'ng-settings-nav'); nav.setAttribute('aria-label', '设置分类');
    for (const [id, label, card, head] of settingsGroups) {
      const button = node('button', 'btn ghost', label); button.type = 'button'; button.dataset.settingsCategory = id;
      button.addEventListener('click', () => selectSettings(id)); nav.appendChild(button);
      q(card).dataset.settingsPanel = id; q(head).dataset.settingsPanel = id;
    }
    q('.setup-page-head').after(nav);
    selectSettings('model');
    modelForm(q('#card-api'), 'cfg');
    q('#btn-save-config').classList.add('primary');
    q('#cfg-test-result').textContent = '连接尚未验证';
    section.querySelectorAll('h2[data-no]').forEach((heading) => heading.removeAttribute('data-no'));
    section.appendChild(q('#setup-nav'));
    q('#wizard-preflight').before(q('#setup-steps'));
    const facts = q('#hero-facts');
    q('#btn-start').before(facts);
    q('#home-nick').setAttribute('title', q('#home-nick').textContent);
    autosize(document);
    root.WWIcons?.mount(document);
  }
  root.WWPresentation = { stats, autosize, mobileViewport, desktop, modelForm, selectSettings, closeNavigation, enter, reducedMotion, beginInspection, roleReveal };
})(typeof window !== 'undefined' ? window : globalThis);
