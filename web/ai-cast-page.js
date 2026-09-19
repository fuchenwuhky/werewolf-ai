'use strict';
(function () {
  if (new URLSearchParams(location.search).get('from') === 'mobile') document.getElementById('cast-back').href = '/m/';
  const grid = document.getElementById('cast-grid');
  const status = document.getElementById('cast-status');
  for (const profile of window.AICast.PORTRAITS) {
    const card = document.createElement('article'); card.className = 'cast-card';
    const image = document.createElement('img');
    image.src = profile.src; image.alt = profile.name + '的玩家肖像'; image.className = 'cast-photo';
    image.width = 384; image.height = 384; image.loading = 'lazy'; image.decoding = 'async';
    const copy = document.createElement('div'); copy.className = 'cast-copy';
    const title = document.createElement('h2'); title.textContent = profile.name;
    const caption = document.createElement('p'); caption.textContent = profile.caption; caption.className = 'cast-caption';
    const aliases = document.createElement('div'); aliases.className = 'cast-aliases';
    for (const name of [profile.name, ...profile.aliases]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
      button.title = '复制昵称：' + name;
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(name); status.textContent = '已复制「' + name + '」，可粘贴到 AI 昵称栏。'; }
        catch (_) { status.textContent = '可手动选中并复制昵称：' + name; }
      });
      aliases.appendChild(button);
    }
    copy.append(title, caption, aliases); card.append(image, copy); grid.appendChild(card);
  }
})();
