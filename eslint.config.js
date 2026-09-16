/**
 * eslint.config.js — ESLint 只负责"通用语言级错误"。
 *
 * 分工（重要）：
 *  - `scripts/lint.js`（零依赖，随 npm test 一起跑）负责**本项目的架构不变量**：
 *    引擎随机性、1 Key = 1 并发、api 层禁止同步写、分层依赖、零运行时依赖……
 *    这些是 ESLint 的任何内置规则都覆盖不到的，也是这个仓库真正会踩的坑。
 *  - ESLint 只补上"人眼容易漏、又不需要懂项目"的那几类：未定义变量（no-undef）、
 *    重复声明、不可达代码、重复 case……第 8 轮那个 `attempt is not defined`
 *    （变量名少写一个 s）就是这类问题——Node 只会在跑到那行时才报错。
 *
 * 因此这里**刻意不开风格类规则**：风格交给 prettier --check 之外的约定，
 * 避免在既有代码上产生成百上千条噪音，把真正的错误淹掉。
 */
'use strict';

const shared = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  console: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly', structuredClone: 'readonly',
  ReadableStream: 'readonly', WritableStream: 'readonly', TransformStream: 'readonly',
  Blob: 'readonly', FormData: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  performance: 'readonly', globalThis: 'readonly', crypto: 'readonly',
  WebSocket: 'readonly', // Node ≥22 自带（scripts/ui-check.js 用它直连 DevTools Protocol）
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', alert: 'readonly', confirm: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', EventSource: 'readonly', CustomEvent: 'readonly',
  ResizeObserver: 'readonly', IntersectionObserver: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly',
  structuredClone: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly', AbortController: 'readonly',
  Blob: 'readonly', FileReader: 'readonly', Image: 'readonly', Audio: 'readonly', WebSocket: 'readonly',
  globalThis: 'readonly', location_origin: 'readonly', history: 'readonly', screen: 'readonly',
  // 本仓库 web/ 下由别的脚本挂到全局上的对象（不是浏览器内建；写在这里才算"有据可查"，
  // 否则每次用都得写成 window.xxx）：
  I18N: 'readonly',      // web/i18n.js      → root.I18N
  CardFrame: 'readonly', // web/card-frame.js → root.CardFrame
  Rulebook: 'readonly',  // web/rulebook.js   → root.Rulebook
  // web/*.js 是 UMD 风格（浏览器 <script> 与 Node require 双载）：Node 侧需要 module，
  // 浏览器里它不存在，所以代码里一律 typeof 守卫之后才用。
  module: 'readonly',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'app/**', 'android/**', 'saves/**', 'logs/**', 'dist/**'],
  },
  {
    files: ['src/**/*.js', 'server.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: shared,
  },
  {
    // 前端是浏览器代码，全局对象不同
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: shared,
  },
  {
    // service worker 跑在独有全局作用域里：没有 window/document，只有 self/caches/clients。
    // 不给它单独一组全局对象的话，no-undef 会把每一行都标红 —— 真正的问题（比如拼错变量名）就被淹了。
    files: ['web/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        self: 'readonly', caches: 'readonly', clients: 'readonly',
        fetch: 'readonly', Request: 'readonly', Response: 'readonly', URL: 'readonly',
        console: 'readonly', Promise: 'readonly',
      },
    },
    rules: shared,
  },
];
