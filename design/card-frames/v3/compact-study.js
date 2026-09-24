'use strict';
(function () {
  const kit = window.ReliquaryCards;
  document.querySelectorAll('[data-study-card]').forEach((host) => {
    const shell = kit.mount(host, {
      roleId: host.dataset.studyCard,
      revealed: true,
      compact: true,
      width: Number(host.dataset.width),
      assetBase: './assets/',
      artBase: '../../../web/assets/roles/',
    });
    if (host.dataset.version === 'old') {
      shell.querySelector('.r3-compact').src = './archive/compact-v1/compact-oracle.svg';
    }
  });
})();
