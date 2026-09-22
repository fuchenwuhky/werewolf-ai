/**
 * preload.js — Electron 渲染进程 ↔ 主进程之间**唯一**的桥（M2-e §3.2）
 *
 * 暴露面**有且只有**一个键：`window.wwExport.exportProfile(profileId)`。
 *   · 不暴露 `ipcRenderer`、不暴露通道名表、不暴露任何 `send/on/sendSync`；
 *   · 不暴露任意 URL、任意路径、任意文件读写、`shell`、`fs`、`path`；
 *   · 渲染进程只能"提交一个档案 id"，URL 由**主进程**自己拼（desktop/export-core.js
 *     的 buildExportUrl），保存位置由**用户在系统保存框里**决定。
 *
 * ⚠ 本文件必须**自包含**：窗口是 `sandbox: true`（desktop/main.js:144），
 *   Electron 沙箱 preload 的 `require` 是受限 polyfill，**不支持相对路径 require**
 *   （官方原文："you will not be able to use CommonJS modules to separate your preload
 *   script into multiple files"，https://www.electronjs.org/docs/latest/tutorial/sandbox）。
 *   所以通道名字面量在这里独立写死，由 `test/m2e-export-native.test.js` 断言它与
 *   `desktop/main.js` 的 `EXPORT_CHANNEL` **逐字相同** —— 共享常量会让 preload 直接抛错。
 *
 * 通道名：`ww:export-profile`（主进程 `ipcMain.handle` 注册同一个串）。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EXPORT_CHANNEL = 'ww:export-profile';

contextBridge.exposeInMainWorld('wwExport', {
  /** @param profileId 档案 id（主进程会做白名单校验）@returns Promise<{status,path?,error?}> 三态 */
  exportProfile: (profileId) => ipcRenderer.invoke(EXPORT_CHANNEL, profileId),
});
