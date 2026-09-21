/**
 * helpers-sw-module.js — 在 Node 里「跑」web/sw.js 的最小 Service Worker 运行时（非测试文件，同
 * test/helpers-tmpdir.js 的定位：只提供基建，不含用例）。
 *
 * 为什么需要它：`test/pwa.test.js` / `test/sw-shell.test.js` 断言的多是**源码形状**（清单覆盖、
 * 正则命中、指纹联动的台账）。形状对不等于行为对 —— 升级时旧缓存到底有没有被清、断网再联网后
 * 还会不会一直吃旧脚本、导航能不能恢复，这些只有**真的把 sw.js 执行一遍**才知道。
 * 浏览器里跑一遍代价太高，而 sw.js 只用到了很少的宿主能力（caches / fetch / Request / Response /
 * self / console），完全可以用最小桩跑通 —— 于是这里的策略是：**给 sw.js 一个可观察的宿主，
 * 断言只看行为**（缓存里有什么、响应体是什么、claim/skipWaiting 有没有被调用、哪些请求根本没被代理）。
 *
 * 桩的语义对着 CacheStorage / Cache 规范写，不是随手糊的：
 *   · `cache.add(req)` 自己发请求，响应非 2xx 就 reject —— sw.js 的「逐个 add + try/catch」
 *     正是依赖这条（addAll 会因为一个 404 整体失败）；
 *   · `cache.match(req)` 按**完整 URL** 匹配，`{ ignoreSearch: true }` 时忽略查询串 ——
 *     sw.js 的离线兜底（预缓存是无查询串 URL，而 HTML 里的 js/css 带 ?v=<哈希>）依赖这条；
 *   · `caches.keys()/delete()` 就是缓存名集合的增删；
 *   · `Response.error()` 返回 `{ ok:false, status:0, type:'error' }`。
 *
 * 夹具（fixture）能力：`withVersion()` / `withExtraShellUrl()` 只替换 sw.js 里的**一个配置常量**
 * 或往清单里**加一条 URL**，用来构造「上一代 Worker」「旧清单里多一个条目」「某个预缓存 URL 404」
 * 这些真实升级场景的另一半。逻辑一行不改 —— 被执行的仍然是 web/sw.js 自己的代码。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', 'web', 'sw.js');
const ORIGIN = 'http://localhost:3210';

/** sw.js 源码（每次读盘：别的用例可能在本文件加载后才改它，读盘最保险） */
function readSwSource() {
  return fs.readFileSync(SW_PATH, 'utf8');
}

/** 把 VERSION 常量换成指定代次（只动这一个常量，用来演「上一个版本」的 Worker） */
function withVersion(src, version) {
  const out = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
  if (out === src) throw new Error('夹具失效：web/sw.js 里找不到 `const VERSION = \'...\';`');
  return out;
}

/** 往 SHELL 清单最前面插一条 URL（用来演「旧代清单里的独有条目」「某个预缓存 URL 404」） */
function withExtraShellUrl(src, url) {
  const out = src.replace('const SHELL = [', `const SHELL = [\n  '${url}',`);
  if (out === src) throw new Error('夹具失效：web/sw.js 里找不到 SHELL 清单');
  return out;
}

/** fetch 事件里的 request（Node 的 Request 不接受相对 URL，浏览器里接受 —— 这里补上 base） */
class SwRequest {
  constructor(url, init = {}) {
    this.url = new URL(String(url), ORIGIN).href;
    this.method = init.method || 'GET';
    this.cache = init.cache || 'default';
    this.mode = init.mode || 'no-cors';
  }
}

/** 最小 Response：只保留 sw.js 实际读到的字段 */
class SwResponse {
  constructor(body = '', init = {}) {
    this.body = String(body);
    this.status = init.status === undefined ? 200 : init.status;
    this.type = init.type || 'basic';
    this.ok = this.status >= 200 && this.status < 300;
  }
  clone() {
    return new SwResponse(this.body, { status: this.status, type: this.type });
  }
  text() {
    return Promise.resolve(this.body);
  }
  static error() {
    return new SwResponse('', { status: 0, type: 'error' });
  }
}

/**
 * 内存版 CacheStorage。
 * @param {(req:SwRequest)=>Promise<SwResponse>} fetchImpl `cache.add()` 用的底层网络（应与 SW 自己的 fetch 同一个桩）
 */
function makeCacheStorage(fetchImpl) {
  const stores = new Map(); // cacheName -> Map<normalizedHref, SwResponse>
  let net = fetchImpl;
  const href = (req) => {
    const u = new URL(typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
    return u.href;
  };
  /** 规范的 ignoreSearch 语义：**忽略查询串**按 pathname 匹配任意一条已存副本（不是把键截掉再精确查） */
  const matchIn = (store, req, opts) => {
    const want = new URL(href(req));
    if (!(opts && opts.ignoreSearch)) return store.get(want.href);
    for (const [k, v] of store) {
      const cur = new URL(k);
      if (cur.origin === want.origin && cur.pathname === want.pathname) return v;
    }
    return undefined;
  };
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    async open(name) {
      const store = storeOf(name);
      return {
        async add(req) {
          const res = await net(req);
          // 规范行为：非 2xx（以及 opaque）一律 reject —— sw.js 的 try/catch 靠这条留住其余条目
          if (!res || !res.ok) throw new TypeError(`cache.add 失败（响应不 ok）：${req.url}`);
          store.set(href(req), res);
        },
        async put(req, res) {
          store.set(href(req), res);
        },
        async match(req, opts) {
          return matchIn(store, req, opts);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    _setFetch(fn) {
      net = fn;
    },
    _names() {
      return [...stores.keys()].sort();
    },
    _urls(name) {
      return [...storeOf(name).keys()].sort();
    },
    _has(name, url) {
      return storeOf(name).has(href(url));
    },
    _size(name) {
      return storeOf(name).size;
    },
  };
}

/**
 * 把 sw.js 装进 vm 跑起来，返回可观察的句柄。
 * @param {{source?:string, caches:object, fetch:Function, console?:object}} opts
 */
function loadSw({ source = readSwSource(), caches, fetch: fetchImpl, console: con = null } = {}) {
  const listeners = new Map();
  const warnings = [];
  const stats = { claims: 0, skipWaiting: 0 };
  const consoleStub = con || { warn: (...a) => warnings.push(a.map(String).join(' ')), error() {}, log() {} };
  const self = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    location: { origin: ORIGIN },
    clients: { claim: async () => { stats.claims++; } },
    skipWaiting: () => { stats.skipWaiting++; },
  };
  const sandbox = { self, caches, fetch: fetchImpl, Request: SwRequest, Response: SwResponse, URL, console: consoleStub, Promise };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: SW_PATH });

  /** 事件对象：把 waitUntil 的 promise 收起来，调用方可以等它落定（等价于浏览器等 SW 干完活） */
  const eventWith = (event) => {
    const waits = [];
    event.waitUntil = (p) => { waits.push(Promise.resolve(p)); };
    return waits;
  };
  const listener = (type) => {
    const fn = listeners.get(type);
    if (!fn) throw new Error(`web/sw.js 没有注册 ${type} 监听器`);
    return fn;
  };

  return {
    origin: ORIGIN,
    version: vm.runInContext('VERSION', sandbox),
    shellCache: vm.runInContext('SHELL_CACHE', sandbox),
    assetCache: vm.runInContext('ASSET_CACHE', sandbox),
    shell: [...vm.runInContext('SHELL', sandbox)],
    caches,
    stats,
    warnings,
    hasListener: (type) => listeners.has(type),

    /** 派发 install / activate / message（等待 waitUntil 里的活干完） */
    async dispatch(type, data) {
      const event = { data };
      const waits = eventWith(event);
      listener(type)(event);
      await Promise.all(waits);
      return event;
    },

    /**
     * 派发一个 fetch 事件。
     * @returns {Promise<{proxied:boolean, response:SwResponse|null}>} proxied=false 表示 SW 放行（浏览器直连）
     */
    async fetch(request) {
      let responded = false;
      let pending = null;
      const event = {
        request,
        respondWith: (p) => { responded = true; pending = Promise.resolve(p); },
      };
      const waits = eventWith(event);
      listener('fetch')(event);
      if (!responded) return { proxied: false, response: null };
      const response = await pending;
      await Promise.all(waits); // 落盘挂在 waitUntil 上：等它落定，断言才稳定
      return { proxied: true, response };
    },
  };
}

/** 造一个同源请求（mode:'navigate' 即"打开页面"） */
function makeRequest(url, init) {
  return new SwRequest(url, init);
}

module.exports = {
  ORIGIN,
  SW_PATH,
  SwRequest,
  SwResponse,
  readSwSource,
  withVersion,
  withExtraShellUrl,
  makeCacheStorage,
  loadSw,
  makeRequest,
};
