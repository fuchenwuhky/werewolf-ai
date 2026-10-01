'use strict';

function deadlineError() {
  const error = new Error('本次 AI 决策等待超时，已停止请求');
  error.code = 'LLM_DEADLINE'; error.timedOut = true; error.retryable = false;
  return error;
}
function abortReason(signal) {
  if (signal?.reason instanceof Error && signal.reason.name !== 'AbortError') return signal.reason;
  // 原生 AbortController 的默认 reason 是英文 DOMException；统一取消语义，不改写原始对象。
  const error = new Error('请求已中止'); error.name = 'AbortError'; error.aborted = true;
  return error;
}
/** 不只比对时钟：排队、响应体、退避均能立即取消；结束后释放监听器。 */
function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortReason(signal)); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortReason(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
function requestScope({ signal, deadlineAt } = {}) {
  const controller = new AbortController();
  let timer = null;
  const abort = () => controller.abort(abortReason(signal));
  if (signal?.aborted) abort();
  else if (signal) signal.addEventListener('abort', abort, { once: true });
  if (!controller.signal.aborted && Number.isFinite(deadlineAt)) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) controller.abort(deadlineError());
    else timer = setTimeout(() => controller.abort(deadlineError()), remaining);
  }
  const check = () => {
    // 定时器可能因同步工作延迟触发，接受结果之前也必须核对真实截止时间。
    if (!controller.signal.aborted && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) controller.abort(deadlineError());
    if (controller.signal.aborted) throw abortReason(controller.signal);
  };
  return { signal:controller.signal,
    run(promise) {
      try { check(); }
      catch (error) {
        if (typeof promise !== 'function') Promise.resolve(promise).catch(() => {});
        return Promise.reject(error);
      }
      const work = typeof promise === 'function' ? promise() : promise;
      return withSignal(work, controller.signal).then(value => { check(); return value; });
    },
    check,
    close() { if (timer !== null) clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortReason(signal)); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
module.exports = { requestScope, withSignal, abortReason, deadlineError, wait };
