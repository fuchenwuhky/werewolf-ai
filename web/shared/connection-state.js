/**
 * connection-state.js — SSE 推送 / 轮询降级的浏览器端共享实现（M1 共享状态）
 *
 * 桌面 app.js 与手机 m.js 原本各写一遍：起连接（停旧→建推送→退回轮询）、轮询兜底的启动与
 * 幂等、停连接（清重试/轮询定时器 + 停流复位）、视图与推送地址的拼接、SSE 四个监听器的接线、
 * 帧解析、降级后"要不要再试一次推送"的判据、看门狗那一跳的判空。这里收敛成一份。
 *
 * **留在两端适配层的差异（有意不统一）**：
 *   · 时长阈值：桌面看门狗 36s / 4s，手机 40s / 8s；
 *   · 桌面两条流（玩家 + 上帝，`godMode` 时才有上帝流）且降级走单例状态条 + 30s 自动恢复推送；
 *   手机一条流、降级提示写事件流、没有恢复推送定时器（靠回到前台时 startPolling 重来）。
 *   所以本模块收"状态与顺序"，阈值与文案由调用方以参数/回调注入 —— 不改变任何一端的节奏与可见文案。
 *
 * 状态就地读写调用方的 state（stream / godStream / streamWatchdog / streamRetry / pollTimer），
 * 字段名与两端原实现一致：别处（可见性变化时 `if (!state.stream)`）也在读它们，模块不自建影子状态。
 */
'use strict';
(function (global) {
  /** 轮询间隔：推送不可用时的兜底节奏（两端原本都是 1200ms） */
  const POLL_MS = 1200;
  /** 降级后恢复推送的重试间隔（桌面端每 30s 试一次；手机端没有这条定时器，不传即不启用） */
  const PUSH_RETRY_MS = 30000;

  /** 玩家/上帝视图地址：after 由调用方决定传什么（两端原本一个带 `|| 0` 一个不带，这里不做默认） */
  function viewUrl(gameId, token, after) {
    return `/api/games/${gameId}/view?token=${token}&after=${after}`;
  }

  /** 推送地址（SSE）：与 view 共用同一套 after 游标语义 */
  function streamUrl(gameId, token, after) {
    return `/api/games/${gameId}/stream?token=${token}&after=${after}`;
  }

  /** SSE 帧解析：坏帧丢一帧、不中断整条流（两端原本各自 try/catch 一遍） */
  function parseFrame(data) {
    try { return JSON.parse(data); } catch (_) { return null; }
  }

  /** 建推送的前置条件（两端原本逐字相同的三行）：浏览器支持 SSE，且确实有一局在跑 */
  function canStream(state) {
    if (typeof window === 'undefined' || !window.EventSource) return false;
    return !!(state.game && state.game.gameId);
  }

  /**
   * 建一条推送流并接好四个事件（两端原本逐字相同的接线，含服务端心跳 ping）：
   *   view  → 先记活动时间，再解析帧；坏帧直接丢（不回调）
   *   ping  → 只记活动时间（服务端心跳，用来把"空闲"和"断线"分开）
   *   end   → 交给调用方（对局结束/被清理：拉一次终局状态后停更）
   *   error → **仅当 readyState === 2（连接已关闭）**才交给调用方；其他错误交给浏览器自动重连
   * 返回 `{ kind, es }`（与桌面端原返回值同形；手机端原来只存 `{ es }`，多一个 kind 是内部字段，不影响任何读写）。
   *
   * @param cfg.url        推送地址（由 streamUrl 生成）
   * @param cfg.onActivity 记活动时间（() => void）
   * @param cfg.onFrame    (kind, 帧) => void，帧已确认可解析
   * @param cfg.onEnd      () => void
   * @param cfg.onError    (kind) => void
   * @param cfg.kind       流标识（'player' | 'god'），透传给 onFrame/onError
   * @param cfg.EventSource 可选注入（Node 单测用假实现；浏览器走全局的 EventSource）
   */
  function openStream(cfg) {
    const ES = cfg.EventSource || (typeof EventSource !== 'undefined' ? EventSource : null);
    if (!ES) throw new Error('EventSource 不可用');
    const es = new ES(cfg.url);
    es.addEventListener('view', (ev) => {
      cfg.onActivity();
      const frame = parseFrame(ev.data);
      if (!frame) return;
      cfg.onFrame(cfg.kind, frame);
    });
    es.addEventListener('ping', () => { cfg.onActivity(); });
    es.addEventListener('end', () => { cfg.onEnd(); });
    es.addEventListener('error', () => { if (es.readyState === 2) cfg.onError(cfg.kind); });
    return { kind: cfg.kind, es };
  }

  /**
   * 停掉全部推送流并复位：关闭每一路 EventSource、字段置 null、清看门狗。
   * 置 null 与清定时器都是必须的 —— 少了任何一步，下一轮 startStream 会以为"还在推送"而不再建流。
   * @param keys 本端的流字段名，桌面 ['stream','godStream']、手机 ['stream']
   */
  function stopStreams(state, keys) {
    for (const key of keys) {
      const st = state[key];
      if (st && st.es) { try { st.es.close(); } catch (_) { /* 已关闭/被回收：忽略 */ } }
      state[key] = null;
    }
    if (state.streamWatchdog) { clearInterval(state.streamWatchdog); state.streamWatchdog = null; }
  }

  /**
   * 起连接（两端原本逐字相同的四行）：先停掉上一轮（推送 + 轮询都清干净），再优先建推送，失败退回轮询。
   * 顺序不能变 —— 先停后建，否则会同时留两条通道，同一帧被渲染两遍。
   * @param cfg.stopPolling / cfg.startStream / cfg.startFallback 由调用方注入
   * @returns true = 走推送通道；false = 已退回轮询
   */
  function startConnection(cfg) {
    cfg.stopPolling();
    if (cfg.startStream()) return true;
    cfg.startFallback();
    return false;
  }

  /**
   * 起轮询兜底：已经有轮询在跑就返回 false（重复调用不叠定时器，与两端原来的 `if (state.pollTimer) return;` 同义）。
   * 起完定时器**立即拉一次**由调用方做 —— 桌面在中间还要更新状态点、安排恢复推送的定时器（顺序有讲究）。
   */
  function beginFallback(state, poll) {
    if (state.pollTimer) return false;
    state.pollTimer = setInterval(poll, POLL_MS);
    return true;
  }

  /**
   * 停连接：清掉"恢复推送"重试与轮询定时器，再停流复位（两端原本各自的清理合并到一处）。
   * 桌面端把重试定时器的那半段留在自己的 stopPolling 里（收尾顺序在源码守卫里钉死），这里再判一次是幂等的。
   */
  function stopConnection(state, streamKeys) {
    if (state.streamRetry) { clearInterval(state.streamRetry); state.streamRetry = null; }
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    stopStreams(state, streamKeys);
  }

  /**
   * 降级到轮询后"是否还该试一次推送"：已经在推送、没有对局、对局已结束都不试。
   * 对局结束后再建流只会被服务端立刻 end 掉，白白刷一条横幅（桌面端每 30s 用的就是这条判据）。
   */
  function canRetryPush(state) {
    if (state.stream || !state.game) return false;
    if (state.view && state.view.finished) return false;
    return true;
  }

  /**
   * 看门狗一跳：没有活动中的流就直接返回（没建流时不该判死），
   * 判据由调用方给（两端阈值不同：桌面 36s / 手机 40s，都必须大于服务端心跳周期的 2 倍）。
   * @param dead    () => boolean，由调用方用**自己的**阈值常量实现
   * @param onDead  () => void，真的判死时才执行（停流 + 降级 + 提示，顺序由调用方决定）
   */
  function watchdogTick(state, dead, onDead) {
    if (!state.stream) return false;
    if (!dead()) return false;
    onDead();
    return true;
  }

  const api = {
    POLL_MS, PUSH_RETRY_MS, viewUrl, streamUrl, parseFrame, canStream, openStream, stopStreams,
    startConnection, beginFallback, stopConnection, canRetryPush, watchdogTick,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWConnectionState = api;
})(typeof window !== 'undefined' ? window : globalThis);
