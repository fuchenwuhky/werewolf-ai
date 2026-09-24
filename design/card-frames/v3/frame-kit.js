/* Moon Eclipse Reliquary v3. Isolated design-kit API, NOT a replacement CardFrame. */
'use strict';
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const ROLES = Object.freeze({
    wolf: ['狼人', 'wolf'], wolfking: ['狼王', 'wolf'], whitewolfking: ['白狼王', 'wolf'],
    wolfbeauty: ['狼美人', 'wolf'], hiddenwolf: ['隐狼', 'wolf'],
    seer: ['预言家', 'oracle'], witch: ['女巫', 'oracle'], hunter: ['猎人', 'oracle'],
    guard: ['守卫', 'oracle'], idiot: ['白痴', 'oracle'], knight: ['骑士', 'oracle'],
    dreamer: ['摄梦人', 'oracle'], crow: ['乌鸦', 'oracle'],
    villager: ['村民', 'village'], admirer: ['暗恋者', 'fate'],
  });
  const WINDOW = 'M104 372 Q122 278 218 222 C318 156 402 172 512 242 C622 172 706 156 806 222 Q902 278 920 372 V1209 Q908 1282 843 1316 H181 Q116 1282 104 1209Z';
  let instance = 0;
  function svgNode(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, String(value));
    return node;
  }
  function decoration(src, cls) {
    const img = document.createElement('img');
    img.className = cls;
    img.src = src;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;
    img.decoding = 'async';
    return img;
  }
  function basePath(value, fallback) {
    const base = typeof value === 'string' && value ? value : fallback;
    return base.endsWith('/') ? base : `${base}/`;
  }
  function mount(host, options) {
    const opts = options || {};
    // Hidden wins over roleId. Do not put a secret role into data-*, URLs or a11y text.
    const roleId = opts.revealed === true && Object.hasOwn(ROLES, opts.roleId) ? opts.roleId : null;
    const info = roleId ? ROLES[roleId] : ['未揭示', 'neutral'];
    const [name, theme] = info;
    const assetBase = basePath(opts.assetBase, './assets/');
    const artBase = basePath(opts.artBase, '../../../web/assets/roles/');
    const shell = document.createElement('div');
    shell.className = 'r3-shell';
    shell.dataset.theme = theme;
    shell.dataset.render = opts.render === 'vector' ? 'vector' : 'hybrid';
    if (Number.isFinite(opts.width) && opts.width > 0) {
      shell.style.width = `${opts.width}px`;
      if (opts.width <= 112) shell.dataset.detail = 'compact';
    }
    if (opts.compact === true) shell.dataset.detail = 'compact';
    const card = document.createElement('div');
    card.className = 'r3-card';
    card.setAttribute('role', 'img');
    card.setAttribute('aria-label', roleId ? `${name}角色牌` : '统一牌背，身份未揭示');
    if (roleId) card.dataset.role = roleId;
    const art = svgNode('svg', { viewBox: '0 0 1024 1536', class: 'r3-art', 'aria-hidden': 'true', focusable: 'false' });
    const defs = svgNode('defs');
    const clipId = `r3-window-${++instance}`;
    const clip = svgNode('clipPath', { id: clipId });
    clip.append(svgNode('path', { d: WINDOW, class: 'r3-cut-full' }));
    clip.append(svgNode('rect', { x: 66, y: 103, width: 892, height: 1313, rx: 8, class: 'r3-cut-compact' }));
    defs.append(clip);
    const picture = svgNode('image', {
      x: 76, y: 108, width: 872, height: 1308,
      href: roleId ? `${artBase}${roleId}.png` : `${assetBase}card-back-field.svg`,
      preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#${clipId})`,
    });
    picture.addEventListener('error', () => { card.dataset.artError = 'true'; });
    art.append(defs, picture);
    const metal = decoration(`${assetBase}reliquary-metal.png`, 'r3-material');
    metal.addEventListener('error', () => { card.dataset.materialError = 'true'; });
    const vector = decoration(`${assetBase}frame-${theme}.svg`, 'r3-vector');
    const compact = decoration(`${assetBase}compact-${theme}.svg`, 'r3-compact');
    const accent = decoration(`${assetBase}accent-${theme}.svg`, 'r3-accent');
    for (const [image, key] of [[vector, 'vectorError'], [compact, 'compactError'], [accent, 'accentError']]) {
      image.addEventListener('error', () => {
        card.dataset[key] = 'true';
        image.hidden = true;
      });
    }
    const title = document.createElement('span');
    title.className = 'r3-title';
    title.textContent = name;
    title.setAttribute('aria-hidden', 'true');
    card.append(art, vector, metal, compact, accent, title);
    shell.append(card);
    host.replaceChildren(shell);
    return shell;
  }
  root.ReliquaryCards = Object.freeze({ mount, roles: ROLES, viewBox: [1024, 1536] });
})(typeof window !== 'undefined' ? window : globalThis);
