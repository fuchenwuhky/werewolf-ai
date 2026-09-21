/** Both clients use server ownership and the same resume transaction. No UI or storage side effects. */
'use strict';
(function (root) {
  function canResume(row) {
    return !!row && !row.finished && row.started && (row.inMemory || row.resumable);
  }
  function findOwned(rows, profileId) {
    return profileId ? (rows || []).find((r) => r.ownerProfileId === profileId && canResume(r)) || null : null;
  }
  function withView(handle, view) {
    return { ...handle, ownerProfileId: view.ownerProfileId || null, ownerNickname: view.ownerNickname || null,
      mock: view.mock === undefined ? !!handle.mock : !!view.mock,
      mySeat: view.me ? view.me.seat : handle.mySeat };
  }
  async function prepare(api, handle, profileId, confirmOwner) {
    let next = { ...handle };
    if (!next.playerToken && !next.godToken) {
      const t = await api('GET', `/api/games/${next.gameId}/tokens`);
      next = { ...next, playerToken: t.player, godToken: t.god };
    }
    const v = await api('GET', `/api/games/${next.gameId}/session?token=${next.playerToken || next.godToken}`);
    if (v.finished || !v.started) throw new Error('该对局已结束或尚未开始');
    next = withView(next, v); // Legacy/stale handles never override authoritative ownership.
    if (next.ownerProfileId && next.ownerProfileId !== profileId && !await confirmOwner(next)) return null;
    if (v.tokenValid === false) {
      // 另一窗口已从磁盘恢复并轮换令牌；只允许有管理会话的客户端找回。
      const t = await api('GET', `/api/games/${next.gameId}/tokens`);
      next = { ...next, playerToken: t.player, godToken: t.god };
    }
    if (!v.inMemory) {
      const r = await api('POST', `/api/games/${next.gameId}/resume`, { token: next.playerToken || next.godToken });
      next = { ...next, gameId: r.gameId, playerToken: r.playerToken, godToken: r.godToken };
    }
    return next;
  }
  const model = { canResume, findOwned, withView, prepare };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.SessionModel = model;
})(typeof window === 'undefined' ? globalThis : window);
