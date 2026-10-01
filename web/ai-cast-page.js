'use strict';
(function () {
  if (new URLSearchParams(location.search).get('from') === 'mobile') document.getElementById('cast-back').href = '/m/';
  const grid = document.getElementById('cast-grid');
  const status = document.getElementById('cast-status');
  const search = document.getElementById('cast-search');
  const empty = document.getElementById('cast-empty');
  const detailRoot = document.getElementById('cast-detail');
  const cards = [];
  function copyName(name) {
    navigator.clipboard.writeText(name)
      .then(() => { status.textContent = '已复制「' + name + '」，可粘贴到 AI 昵称栏。'; })
      .catch(() => { status.textContent = '可手动选中并复制昵称：' + name; });
  }
  function openDetail(profile) {
    const previousFocus = document.activeElement;
    const background = [...document.querySelector('.cast-book').children].filter(e => e !== detailRoot).map(e => [e, e.inert]);
    background.forEach(([e]) => { e.inert = true; });
    const backdrop = document.createElement('div');
    backdrop.className = 'cast-detail-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'cast-detail';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', profile.name + '的人物资料');
    const image = document.createElement('img');
    image.src = profile.src; image.alt = profile.name + '的肖像';
    image.width = 384; image.height = 384;
    const copy = document.createElement('div');
    copy.className = 'cast-detail-copy';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'ng-inscription'; eyebrow.textContent = 'THE GUEST REGISTER';
    const title = document.createElement('h2'); title.textContent = profile.name;
    const caption = document.createElement('p'); caption.textContent = profile.caption;
    const disclaimer = document.createElement('p');
    disclaimer.className = 'cast-detail-note';
    disclaimer.textContent = '这是人物的发言气质，不代表游戏身份、阵营或强度。';
    const aliasesLabel = document.createElement('h3'); aliasesLabel.textContent = '也可以这样称呼';
    const aliases = document.createElement('div'); aliases.className = 'cast-detail-aliases';
    for (const name of [profile.name, ...profile.aliases]) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'btn ghost'; button.textContent = name;
      button.title = '复制昵称：' + name;
      button.addEventListener('click', () => copyName(name));
      aliases.appendChild(button);
    }
    const closeButton = document.createElement('button');
    closeButton.type = 'button'; closeButton.className = 'btn ghost cast-detail-close';
    closeButton.textContent = '关闭';
    const close = () => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      background.forEach(([e, inert]) => { e.inert = inert; });
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusables = [closeButton, ...aliases.querySelectorAll('button')];
        if (event.shiftKey && document.activeElement === focusables[0]) { event.preventDefault(); focusables.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === focusables.at(-1)) { event.preventDefault(); focusables[0].focus(); }
      }
    };
    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
    copy.append(eyebrow, title, caption, disclaimer, aliasesLabel, aliases);
    dialog.append(closeButton, image, copy); backdrop.appendChild(dialog); detailRoot.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    closeButton.focus({ preventScroll: true });
  }
  for (const profile of window.AICast.PORTRAITS) {
    const card = document.createElement('article'); card.className = 'cast-card';
    const image = document.createElement('img');
    image.src = profile.src; image.alt = profile.name + '的玩家肖像'; image.className = 'cast-photo';
    image.width = 384; image.height = 384; image.loading = 'lazy'; image.decoding = 'async';
    const copy = document.createElement('div'); copy.className = 'cast-copy';
    const title = document.createElement('h2'); title.textContent = profile.name;
    const caption = document.createElement('p'); caption.textContent = profile.caption; caption.className = 'cast-caption';
    const detailButton = document.createElement('button');
    detailButton.className = 'cast-view'; detailButton.type = 'button'; detailButton.textContent = '查看人物 →';
    detailButton.addEventListener('click', () => openDetail(profile));
    copy.append(title, caption, detailButton); card.append(image, copy); grid.appendChild(card);
    cards.push({ card, haystack: [profile.name, ...profile.aliases, profile.caption].join(' ').toLocaleLowerCase() });
  }
  search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const entry of cards) {
      entry.card.hidden = !entry.haystack.includes(query);
      if (!entry.card.hidden) visible++;
    }
    empty.hidden = visible !== 0;
  });
})();
