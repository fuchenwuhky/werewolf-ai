'use strict';
(function () {
  const kit = window.ReliquaryCards;
  document.querySelectorAll('[data-card]').forEach((host) => {
    kit.mount(host, { roleId: host.dataset.card, revealed: true });
  });
  document.querySelectorAll('[data-size]').forEach((host) => {
    kit.mount(host, { roleId: 'seer', revealed: true, width: Number(host.dataset.size) });
  });
  const backHost = document.getElementById('hidden-demo');
  const backButton = document.getElementById('reveal-demo');
  let revealed = false;
  let render = 'hybrid';
  function updateBack() {
    // Supplying a roleId with revealed:false must still produce a uniform card back.
    kit.mount(backHost, { roleId: 'witch', revealed, render });
    backButton.setAttribute('aria-pressed', String(revealed));
    backButton.textContent = revealed ? '收起示例牌' : '揭示示例牌';
  }
  updateBack();
  backButton.addEventListener('click', () => { revealed = !revealed; updateBack(); });
  document.querySelectorAll('button[data-render]').forEach((button) => {
    button.addEventListener('click', () => {
      render = button.dataset.render;
      document.querySelectorAll('button[data-render]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      document.querySelectorAll('.r3-shell').forEach((shell) => { shell.dataset.render = render; });
    });
  });
})();
