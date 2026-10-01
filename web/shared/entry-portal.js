/** Local-player entry screen. This is a chooser, not an online authentication promise. */
'use strict';
(function (root) {
  function open({ profiles, currentId, renderAvatar, onSelect, onManage }) {
    const usable = (profiles || []).filter((profile) => !profile.archivedAt);
    const previousFocus = document.activeElement;
    const app = document.getElementById('app') || document.getElementById('m-app');
    const layer = document.createElement('div');
    layer.className = 'ng-entry';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'ng-entry-title');
    const left = document.createElement('div');
    left.className = 'ng-entry-brand';
    const mark = document.createElement('img');
    mark.src = (location.pathname.startsWith('/m/') ? '../' : '') + 'assets/brand/wolf-emblem.svg';
    mark.alt = '';
    mark.width = 108;
    mark.height = 108;
    left.appendChild(mark);
    const appName = document.createElement('h1');
    appName.textContent = 'AI 狼人杀';
    left.appendChild(appName);
    const eyebrow = document.createElement('p');
    eyebrow.className = 'ng-inscription';
    eyebrow.textContent = 'NOCTURNE · 月夜议会';
    left.appendChild(eyebrow);
    const line = document.createElement('span');
    line.className = 'ng-entry-divider';
    left.appendChild(line);
    const verse = document.createElement('h2');
    verse.textContent = '月亮升起。\n故事，从你的名字开始。';
    left.appendChild(verse);
    const description = document.createElement('p');
    description.className = 'ng-entry-description';
    description.textContent = '与性格各异的 AI 来客同桌。你只需要相信证据，而不是声音。';
    left.appendChild(description);
    const panel = document.createElement('section');
    panel.className = 'ng-entry-panel';
    const title = document.createElement('h2');
    title.id = 'ng-entry-title';
    title.textContent = '今夜，你是谁？';
    panel.appendChild(title);
    const subtitle = document.createElement('p');
    subtitle.textContent = '选择本机玩家档案，无需密码。';
    panel.appendChild(subtitle);
    const list = document.createElement('div');
    list.className = 'ng-entry-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', '本机玩家档案');
    let selected = usable.some((profile) => profile.id === currentId) ? currentId : (usable[0] && usable[0].id);
    const selectVisual = () => {
      for (const row of list.querySelectorAll('.ng-entry-row')) {
        const active = row.dataset.profileId === selected;
        row.setAttribute('aria-checked', String(active));
        row.classList.toggle('selected', active);
      }
      enter.textContent = selected ? `以「${usable.find((profile) => profile.id === selected)?.nickname || '玩家'}」进入` : '选择档案进入';
      enter.disabled = !selected;
    };
    for (const profile of usable) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ng-entry-row';
      row.dataset.profileId = profile.id;
      row.setAttribute('role', 'radio');
      const avatar = document.createElement('span');
      avatar.className = 'ng-entry-avatar';
      renderAvatar(avatar, profile);
      row.appendChild(avatar);
      const detail = document.createElement('span');
      const nick = document.createElement('b');
      nick.textContent = profile.nickname;
      detail.appendChild(nick);
      const label = document.createElement('small');
      label.textContent = profile.id === currentId ? '本机档案 · 当前玩家' : '本机档案';
      detail.appendChild(label);
      row.appendChild(detail);
      row.addEventListener('click', () => { selected = profile.id; selectVisual(); });
      row.addEventListener('dblclick', () => { selected = profile.id; enter.click(); });
      list.appendChild(row);
    }
    panel.appendChild(list);
    const enter = document.createElement('button');
    enter.type = 'button';
    enter.className = 'btn primary ng-entry-enter';
    enter.addEventListener('click', () => { if (selected) { onSelect(selected); close(); } });
    panel.appendChild(enter);
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn ghost ng-entry-create';
    create.textContent = '创建或管理档案';
    create.addEventListener('click', () => { close(); onManage(); });
    panel.appendChild(create);
    const note = document.createElement('p');
    note.className = 'ng-entry-note';
    note.textContent = '战绩、笔记与偏好保存在这台设备。切换档案不是同设备用户间的安全隔离。';
    panel.appendChild(note);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ng-entry-close';
    dismiss.textContent = '关闭';
    dismiss.setAttribute('aria-label', '关闭档案选择');
    panel.appendChild(dismiss);
    layer.append(left, panel);
    document.body.appendChild(layer);
    app.inert = true;
    const close = () => {
      app.inert = false;
      layer.remove();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    };
    dismiss.addEventListener('click', close);
    layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const controls = [...layer.querySelectorAll('button:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    selectVisual();
    (list.querySelector('.selected') || create).focus();
  }
  root.WWEntryPortal = { open };
})(typeof window !== 'undefined' ? window : globalThis);
