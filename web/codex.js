/**
 * codex.js — 角色图鉴（桌面 / 手机共用一份渲染）
 *
 * 为什么抽成共享模块：图鉴最怕"两边各自维护、各自说谎"（桌面版曾经把暗恋者归进
 * 平民阵营，而卡框明明是第三方紫框）。这里只有一份分区/徽记/文案逻辑，
 * 两个入口只是挂载点不同：桌面挂 `#screen-codex`（左翻牌 + 右侧固定细节栏），
 * 手机挂 `#m-codex`（两列牌 + 点牌弹层看细节）。
 *
 * 数据全部来自服务端 /api/meta（roles / roleArt / roleStrategies），页面只负责传进来：
 * 新增身份只要在 src/engine/roles.js 注册，两端的图鉴都会自动多一张牌。
 *
 * 分区按**卡框阵营**（CardFrame.roleAttrs().faction）而不是引擎 category：
 * 暗恋者的有效阵营随暗恋对象终身变动（src/engine/game.js 的 categoryOf），
 * card-frame.js 把它列在 THIRD_PARTY 里 —— 按 category 分区会让紫框牌挂到"平民阵营"下。
 */
'use strict';

window.Codex = (function () {
  const SECTIONS = [
    { key: 'wolf', titleKey: 'codex.secWolf', catKey: 'codex.catWolf' },
    { key: 'god', titleKey: 'codex.secGod', catKey: 'codex.catGod' },
    { key: 'villager', titleKey: 'codex.secVillager', catKey: 'codex.catVillager' },
    { key: 'third', titleKey: 'codex.secThird', catKey: 'codex.catThird' },
  ];
  const st = { filter: 'all', q: '', pick: null, page: 0, cap: 4 };
  // artBase 必须由调用方给：桌面在 `/`（assets/roles/），手机在 `/m/`（../assets/roles/）。
  // 写死相对路径的话手机端会 404 成一排碎图（踩过一次）。
  // mode：'panel' = 桌面（一张长列表 + 右侧固定细节栏）；
  //       'pages' = 手机（按阵营分页，一页放满翻下一页，点牌弹层看细节）。
  let ctx = { meta: null, mode: 'panel', artBase: 'assets/roles/', onInspect: null, onRulebook: null, onPick: null, counts: () => ({}) };

  const T = (k, vars) => ((typeof I18N !== 'undefined' && I18N.t && I18N.t(k, vars)) || k);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel) => document.querySelector(sel);
  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }
  const roles = () => (ctx.meta && ctx.meta.roles) || {};
  const roleOf = (rid) => roles()[rid] || {};
  const artOf = (rid) => ctx.meta && ctx.meta.roleArt && ctx.meta.roleArt[rid];
  const counts = () => (typeof ctx.counts === 'function' ? ctx.counts() || {} : ctx.counts || {});

  /** 卡框阵营：与牌面颜色同源，保证分区与牌面永远不会互相矛盾 */
  function factionOf(rid) {
    const attrs = window.CardFrame.roleAttrs(rid);
    return attrs.faction || roleOf(rid).category || 'villager';
  }
  const sectionOf = (rid) => SECTIONS.find((s) => s.key === factionOf(rid));

  function mount(opts) {
    Object.assign(ctx, opts || {});
    const search = $('#cdx-search');
    if (search) {
      search.value = st.q;
      search.addEventListener('input', () => { st.q = search.value; st.page = 0; renderGrid(); });
    }
    const rb = $('#cdx-rulebook');
    if (rb && !rb.dataset.wired) {
      rb.dataset.wired = '1';
      rb.addEventListener('click', () => ctx.onRulebook && ctx.onRulebook());
    }
    const grid = $('#cdx-grid');
    if (grid && !grid.dataset.wired) {
      grid.dataset.wired = '1';
      // 事件委托：牌是每次重渲染出来的，逐张挂监听会随渲染次数线性泄漏
      grid.addEventListener('click', (e) => {
        const card = e.target.closest && e.target.closest('.cdx-card');
        if (!card || !card.dataset.role) return;
        pick(card.dataset.role);
      });
      grid.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const card = e.target.closest && e.target.closest('.cdx-card');
        if (!card) return;
        e.preventDefault();
        pick(card.dataset.role);
      });
      if (ctx.mode === 'pages') wirePager(grid);
    }
    const detail = $('#cdx-detail');
    if (detail && !detail.dataset.wired) {
      detail.dataset.wired = '1';
      detail.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.cdx-act-inspect')) ctx.onInspect && ctx.onInspect(st.pick);
        if (e.target.closest && e.target.closest('.cdx-act-rule')) ctx.onRulebook && ctx.onRulebook();
      });
    }
    render();
  }

  /* ---------- 分页模式（手机）：按阵营分页，一页放满就翻下一页 ----------
     为什么不是"一条长列表"：15 张牌在小屏上要滑很久才能看到神职，而玩家九成时候只想
     查某一个身份。分页后每一页都是"一个阵营 + 页码"，翻页比滑动更快找到东西。
     每页容量按**实测**算（屏幕高度 ÷ 一张牌的高度 × 列数），所以横竖屏、大小屏都合适。 */
  function pagerEl() { return $('#cdx-pager'); }

  function ensurePager() {
    const grid = $('#cdx-grid');
    if (!grid || pagerEl()) return;
    const bar = el('div', 'cdx-pager');
    bar.id = 'cdx-pager';
    bar.innerHTML = '<button class="cdx-prev" type="button" aria-label="上一页">‹</button>'
      + '<div class="cdx-pagehead"><b id="cdx-ptitle"></b><span id="cdx-pmeta"></span></div>'
      + '<button class="cdx-next" type="button" aria-label="下一页">›</button>';
    grid.parentNode.insertBefore(bar, grid);
    const root = grid.closest('.m-screen') || grid.parentNode;
    if (root && root.classList) root.classList.add('cdx-paged');
  }

  /** 一页能放几张：按牌实际占位算，取偶数列（2 列 × N 行）。
   *  可用高度直接量**网格自己**——分页模式下 .cdx-paged 把整屏设成 flex 列、网格 flex:1 1 auto，
   *  所以它的 clientHeight 就是"这一页还剩多少地方"，不用拿 innerHeight 去减一堆东西
   *  （减错过一次：把页码条的高度减了两遍，容量只剩 2 张/页，15 张牌摊成 9 页）。 */
  function computeCap() {
    const grid = $('#cdx-grid');
    if (!grid) return 4;
    const cols = 2;
    const gap = 12;
    const w = grid.clientWidth || (grid.getBoundingClientRect().width) || 340;
    const avail = grid.clientHeight || Math.max(240, (window.innerHeight || 700) - grid.getBoundingClientRect().top - 16);
    const cardW = Math.max(80, (w - gap * (cols - 1)) / cols);
    const cardH = cardW * 1.5; // 卡框是 2:3
    const rows = Math.max(1, Math.floor((avail + gap) / (cardH + gap)));
    // 下限 4 张/页：实测在 390×760 的手机上，2:3 卡框高度会让"按高度算"的容量掉到 1 行 = 2 张/页，
    // 于是翻页变成"一次翻两张"，用户明确要求"一页放 4 个角色"。这里给下限，
    // 放不下时由 m.css 允许这一页少量纵向滚动（宁可轻微滚动，也不要一次只翻两张）。
    return Math.max(4, rows * cols);
  }

  /** 分组 → 切页：每个阵营从新的一页开始，装满就续到下一页；返回 [{sec, ids}] */
  function buildPages(cs) {
    const pages = [];
    for (const sec of SECTIONS) {
      const ids = Object.keys(roles()).filter((id) => sec.key === factionOf(id) && matches(id, cs));
      for (let i = 0; i < ids.length; i += st.cap) pages.push({ sec, ids: ids.slice(i, i + st.cap), first: i === 0 });
    }
    return pages;
  }

  function wirePager(grid) {
    ensurePager();
    const bar = pagerEl();
    if (!bar || bar.dataset.wired) return;
    bar.dataset.wired = '1';
    bar.querySelector('.cdx-prev').addEventListener('click', () => turn(-1));
    bar.querySelector('.cdx-next').addEventListener('click', () => turn(1));
    // 横滑翻页：手机上这是最顺手的操作，按钮是给"不知道能滑"的人留的
    let x0 = null;
    let y0 = null;
    grid.addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    grid.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) turn(dx < 0 ? 1 : -1);
    }, { passive: true });
    // 转屏 / 改窗口大小会改变每页容量，重算并保持当前页（页码越界会被夹住）
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const cap = computeCap();
        if (cap !== st.cap) { st.cap = cap; renderGrid(); }
      }, 180);
    });
  }

  function pageCount() { return buildPages(counts()).length; }

  function turn(delta) {
    const total = pageCount();
    if (total <= 1) return;
    st.page = Math.min(total - 1, Math.max(0, st.page + delta));
    renderGrid();
  }

  function goPage(n) { st.page = Math.max(0, n | 0); renderGrid(); }

  function pick(rid) {
    st.pick = rid;
    if (ctx.mode === 'panel') renderGrid();
    else { ctx.onPick && ctx.onPick(rid); } // pages/sheet：细节交给调用方（手机走弹层）
  }

  function render() { renderSub(); renderFilters(); renderGrid(); }

  function renderSub() {
    const box = $('#cdx-sub');
    if (!box) return;
    const ids = Object.keys(roles());
    const n = (f) => ids.filter((id) => factionOf(id) === f).length;
    box.textContent = T('codex.sub', { n: ids.length, w: n('wolf'), g: n('god'), v: n('villager') });
  }

  function renderFilters() {
    const box = $('#cdx-filters');
    if (!box) return;
    const cs = counts();
    const inGame = Object.keys(cs).some((k) => cs[k] > 0);
    const defs = [['all', T('codex.filterAll')], ['wolf', T('codex.filterWolf')], ['god', T('codex.filterGod')], ['villager', T('codex.filterVillager')]];
    if (inGame) defs.push(['ingame', T('codex.filterInGame')]);
    box.innerHTML = '';
    for (const [key, label] of defs) {
      const b = el('button', st.filter === key ? 'on' : '', esc(label));
      b.type = 'button';
      b.dataset.filter = key;
      b.addEventListener('click', () => { st.filter = key; st.page = 0; renderFilters(); renderGrid(); });
      box.appendChild(b);
    }
  }

  function matches(rid, cs) {
    const sec = sectionOf(rid);
    if (st.filter === 'ingame') { if (!(cs[rid] > 0)) return false; }
    else if (st.filter !== 'all' && (!sec || sec.key !== st.filter)) return false;
    const q = st.q.trim().toLowerCase();
    if (!q) return true;
    const r = roleOf(rid);
    return [r.name, r.emoji, r.short, r.description, rid].some((s) => String(s == null ? '' : s).toLowerCase().includes(q));
  }

  function renderGrid() {
    const grid = $('#cdx-grid');
    if (!grid) return;
    const cs = counts();
    grid.innerHTML = '';
    const visible = ctx.mode === 'pages' ? renderPaged(grid, cs) : renderAll(grid, cs);
    if (!visible.length) grid.appendChild(el('div', 'cdx-empty', esc(T('codex.empty'))));
    if (!st.pick || visible.indexOf(st.pick) < 0) st.pick = visible[0] || null;
    if (ctx.mode === 'panel') renderDetail();
  }

  /** 桌面：一条长列表，按阵营分区（不翻页，滚动就好） */
  function renderAll(grid, cs) {
    const visible = [];
    for (const sec of SECTIONS) {
      const ids = Object.keys(roles()).filter((id) => sec.key === factionOf(id) && matches(id, cs));
      if (!ids.length) continue;
      const node = el('section', 'cdx-sec');
      node.appendChild(el('h2', null, `${esc(T(sec.titleKey))} <em>${ids.length}</em>`));
      const cards = el('div', 'cdx-cards');
      for (const id of ids) cards.appendChild(cardNode(id, cs[id] || 0));
      node.appendChild(cards);
      grid.appendChild(node);
      visible.push(...ids);
    }
    return visible;
  }

  /** 手机：按阵营分页 —— 每个阵营从新的一页开始，一页装满就续到下一页 */
  function renderPaged(grid, cs) {
    ensurePager();
    st.cap = computeCap();
    const pages = buildPages(cs);
    if (st.page > pages.length - 1) st.page = Math.max(0, pages.length - 1);
    const cur = pages[st.page];
    const visible = cur ? cur.ids.slice() : [];
    if (cur) {
      const cards = el('div', 'cdx-cards');
      for (const id of cur.ids) cards.appendChild(cardNode(id, cs[id] || 0));
      grid.appendChild(cards);
      const sameSec = pages.filter((p) => p.sec.key === cur.sec.key);
      const idxInSec = sameSec.indexOf(cur) + 1;
      const title = $('#cdx-ptitle');
      const meta = $('#cdx-pmeta');
      // 一个阵营占多页时把"该阵营第几页"和"全局第几页"都写出来，不然翻着翻着不知道在哪
      if (title) title.textContent = T(cur.sec.titleKey);
      if (meta) {
        meta.textContent = sameSec.length > 1
          ? T('codex.pageOfFaction', { i: idxInSec, n: sameSec.length, p: st.page + 1, t: pages.length })
          : T('codex.pageOf', { p: st.page + 1, t: pages.length });
      }
    }
    const bar = pagerEl();
    if (bar) {
      bar.querySelector('.cdx-prev').disabled = st.page <= 0;
      bar.querySelector('.cdx-next').disabled = st.page >= pages.length - 1;
    }
    return visible;
  }

  function cardNode(id, inGame) {
    const r = roleOf(id);
    const card = el('div', 'cdx-card', cardHtml(id, inGame));
    // data-role/data-faction 走 CardFrame 原语：手写 dataset.role 会漏掉阵营，徽记永远是狼爪
    Object.assign(card.dataset, window.CardFrame.roleAttrs(id));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${r.name}：${r.short}`);
    card.title = `${r.name} · ${r.short}`;
    if (st.pick === id) card.classList.add('on');
    return card;
  }

  /** 牌面：复用身份牌那套 .card-frame + 同一张立绘；铭牌挂在卡框**内部**（--band* 变量才继承得到） */
  function cardHtml(rid, inGame) {
    const r = roleOf(rid);
    const sec = sectionOf(rid);
    const badge = inGame ? `<span class="cdx-ingame">${esc(T('codex.inGame', { n: inGame }))}</span>` : '';
    return `<div class="card-frame"${attrStr(window.CardFrame.roleAttrs(rid))}>`
      + window.CardFrame.html()
      + artOnly(rid)
      + `<div class="cdx-plate"><div class="cdx-name gilt-name">${esc(r.name)}</div>`
      + `<div class="cdx-cat">${esc(r.emoji + ' ' + (sec ? T(sec.catKey) : ''))}</div></div></div>${badge}`;
  }

  function attrStr(obj) {
    return Object.entries(obj || {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  }

  function artOnly(rid) {
    const ext = artOf(rid);
    const r = roleOf(rid);
    if (ext) return `<img class="role-art" src="${esc(ctx.artBase)}${esc(rid)}${esc(ext)}" alt="${esc(r.name)}">`;
    return `<div class="role-art-fallback"><div class="fa-emoji">${esc(r.emoji)}</div><div class="fa-name">${esc(r.name)}</div></div>`;
  }

  /** 细节内容（桌面塞进右侧栏，手机塞进弹层 —— 同一份 HTML） */
  function detailHtml(rid) {
    const r = roleOf(rid);
    const cs = counts();
    const sec = sectionOf(rid);
    const out = [];
    out.push(`<div class="cdx-big card-frame"${attrStr(window.CardFrame.roleAttrs(rid))}>${window.CardFrame.html()}${artOnly(rid)}</div>`);
    out.push(`<div class="cdx-dname gilt-name">${esc(r.emoji)} ${esc(r.name)}</div>`);
    const chips = [];
    if (sec) chips.push([T(sec.titleKey), false]);
    if (r.categoryDynamic) chips.push([T('codex.chipDynamic'), true]);
    if (r.nightStep) chips.push([T('codex.chipNight'), true]);
    if (r.deathTrigger) chips.push([T('codex.chipDeath'), true]);
    if (r.selfExplode) chips.push([T('codex.chipExplode'), false]);
    if (r.explodeShot) chips.push([T('codex.chipExplodeShot'), false]);
    if (r.voteImmunity) chips.push([T('codex.chipVoteImmune'), false]);
    if (cs[rid] > 0) chips.push([T('codex.inGame', { n: cs[rid] }), true]);
    out.push(`<div class="cdx-chips">${chips.map(([l, hot]) => `<span${hot ? ' class="hot"' : ''}>${esc(l)}</span>`).join('')}</div>`);
    out.push(`<p class="cdx-short">${esc(r.short)}</p>`);
    out.push(`<p class="cdx-desc">${esc(r.description)}</p>`);
    if (r.categoryDynamic) out.push(`<p class="cdx-note">${esc(T('codex.dynamicNote'))}</p>`);
    const strats = (ctx.meta && ctx.meta.roleStrategies && ctx.meta.roleStrategies[rid]) || [];
    if (strats.length) {
      out.push(`<h4>${esc(T('codex.aiTitle'))}</h4>`);
      out.push(`<div class="cdx-strat">${strats.map((s) => `<div><b>${esc(s.name)}</b>：${esc(s.text)}</div>`).join('')}</div>`);
      out.push(`<p class="hint">${esc(T('codex.aiHint'))}</p>`);
    }
    out.push(`<div class="cdx-actions"><button class="btn small cdx-act-inspect" type="button">${esc(T('codex.inspect'))}</button>`
      + `<button class="btn ghost small cdx-act-rule" type="button">${esc(T('codex.rulebook'))}</button></div>`);
    return out.join('');
  }

  function renderDetail() {
    const box = $('#cdx-detail');
    if (!box) return;
    box.innerHTML = st.pick ? detailHtml(st.pick) : `<div class="cdx-empty">${esc(T('codex.pickHint'))}</div>`;
  }

  return {
    mount,
    render,
    detailHtml,
    renderDetail,
    counts,
    /** 分页信息（给测试与调试用）：当前页、总页数、每页容量、当前页的阵营与牌 */
    pageInfo() {
      const cs = counts();
      const pages = buildPages(cs);
      const cur = pages[st.page];
      const grid = $('#cdx-grid');
      return {
        page: st.page,
        total: pages.length,
        cap: st.cap,
        // 量容量的两个输入值也带出来：容量不对时不用猜（曾经把页码条高度减了两遍）
        avail: grid ? Math.round(grid.clientHeight) : 0,
        width: grid ? Math.round(grid.clientWidth) : 0,
        faction: cur ? cur.sec.key : null,
        cards: cur ? cur.ids.slice() : [],
        sizes: pages.map((p) => p.ids.length),
        factions: pages.map((p) => p.sec.key),
      };
    },
    turn,
    goPage,
    get pick() { return st.pick; },
    get filter() { return st.filter; },
    factionOf,
  };
})();
