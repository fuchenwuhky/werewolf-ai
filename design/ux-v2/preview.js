'use strict';
(() => {
  const players = [
    [1, '墨泊', 'turtle', '✓ 已公开：平民'],
    [2, '赤绒', 'hawk', '? 待观察'],
    [3, '霜句', 'minimalist', '? 偏好'],
    [5, '温烛', 'softie', '已出局 · 未翻牌'],
    [7, '终章', 'closer', '? 偏狼 · 我的推测'],
    [9, '绢页', 'archivist', '? 待观察'],
  ];
  const seats = document.getElementById('desktop-seats');
  for (const [seat, name, avatar, label] of players) {
    const row = document.createElement('div');
    row.className = 'roster-row';
    const pick = document.createElement('button');
    pick.className = 'seat-main';
    pick.dataset.seat = seat;
    const image = document.createElement('img');
    image.src = '../../web/assets/avatars/' + avatar + '.png';
    image.alt = '';
    const info = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = seat + '号 · ' + name;
    const tag = document.createElement('small');
    tag.textContent = label;
    if (seat === 7) tag.id = 'seat-seven-tag';
    info.append(title, tag);
    pick.append(image, info);
    pick.addEventListener('click', () => {
      document.querySelectorAll('.seat-main').forEach((x) => x.classList.remove('picked'));
      pick.classList.add('picked');
      document.getElementById('target-label').textContent = seat + ' 号 · ' + name;
      document.getElementById('confirm-vote').disabled = false;
    });
    const note = document.createElement('button');
    note.className = 'seat-note';
    note.textContent = '✎';
    note.setAttribute('aria-label', '查看 ' + seat + ' 号笔记');
    note.addEventListener('click', () => {
      document.querySelector('.notebook').scrollIntoView({ block: 'center', behavior: 'smooth' });
      document.getElementById('note-status').textContent = seat === 7 ? '正在编辑 7 号示例笔记。' : '该样张仅演示 7 号的编辑流程，不会改动目标选择。';
    });
    pick.disabled = seat === 5; // Dead players remain readable and annotatable, never vote targets.
    row.append(pick, note);
    seats.append(row);
  }
  const capture = () => ({
    leaning: document.querySelector('#leaning .selected').dataset.value,
    roles: [...document.querySelectorAll('#role-choices .selected')].map((x) => x.textContent),
    text: document.getElementById('note').value,
  });
  let previous = capture();
  document.querySelectorAll('#leaning button').forEach((button) =>
    button.addEventListener('click', () => {
      document.querySelectorAll('#leaning button').forEach((x) => {
        x.classList.remove('selected');
        x.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('selected');
      button.setAttribute('aria-pressed', 'true');
    }),
  );
  document.querySelectorAll('#role-choices button').forEach((button) =>
    button.addEventListener('click', () => {
      if (!button.classList.contains('selected') && document.querySelectorAll('#role-choices .selected').length >= 3) {
        document.getElementById('note-status').textContent = '最多保留 3 个候选身份。';
        return;
      }
      button.classList.toggle('selected');
      button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
    }),
  );
  document.getElementById('save-note').addEventListener('click', () => {
    const next = capture();
    document.getElementById('seat-seven-tag').textContent = '? ' + next.leaning + ' · 我的推测';
    document.getElementById('note-status').textContent = '已保存到演示状态；未提交投票，也未发送给 AI。';
    previous = next;
  });
  document.getElementById('undo-note').addEventListener('click', () => {
    document.querySelectorAll('#leaning button').forEach((x) => {
      const hit = x.dataset.value === previous.leaning;
      x.classList.toggle('selected', hit);
      x.setAttribute('aria-pressed', String(hit));
    });
    document.querySelectorAll('#role-choices button').forEach((x) => {
      const hit = previous.roles.includes(x.textContent);
      x.classList.toggle('selected', hit);
      x.setAttribute('aria-pressed', String(hit));
    });
    document.getElementById('note').value = previous.text;
    document.getElementById('note-status').textContent = '已恢复为最近保存的演示内容。';
  });
  document.getElementById('clear-target').addEventListener('click', () => {
    document.querySelectorAll('.seat-main').forEach((x) => x.classList.remove('picked'));
    document.getElementById('target-label').textContent = '尚未选择';
    document.getElementById('confirm-vote').disabled = true;
  });
  document.getElementById('confirm-vote').addEventListener('click', () => {
    document.getElementById('note-status').textContent = '演示确认：' + document.getElementById('target-label').textContent + '。真实版本此处才发送投票请求。';
  });
  document.querySelectorAll('[data-profile]').forEach((button) =>
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-profile]').forEach((x) => {
        x.classList.toggle('active', x === button);
        x.querySelector('em').textContent = x === button ? '使用中' : '切换';
        x.querySelector('small').textContent = x === button ? '当前演示档案' : '独立资料 · 示例数据';
      });
      document.querySelector('.profile-trigger').textContent = button.dataset.profile + ' ▾';
      document.getElementById('profile-status').textContent = '当前演示档案：' + button.dataset.profile + '。未创建或修改真实档案。';
    }),
  );
  document
    .querySelector('[data-open-profiles]')
    .addEventListener('click', () => document.getElementById('profiles').scrollIntoView({ block: 'center', behavior: 'smooth' }));
  document.querySelector('.add-profile').addEventListener('click', () => {
    document.getElementById('profile-status').textContent = '正式版本：昵称 1–20 字、内置头像、可选简介，创建后得到稳定 profileId；这里不写入真实数据。';
  });
})();
