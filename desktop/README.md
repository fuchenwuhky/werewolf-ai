# 电脑版（Electron 桌面应用）

真正的桌面程序：双击一个免安装 `.exe` 就出窗口，**没有控制台窗口、不依赖浏览器、不依赖系统装的 Node**。

## 与其它端的关系

服务端不重写、不复用第二份：主进程直接 `require` 项目自带的 `server.js`
（它被 require 时即开始监听），所以引擎、角色、图鉴、存档逻辑与安卓版 / 网页版**完全同一套代码**。
打包时把 `server.js`、`src/`、`web/` 作为 `extraResources` 放进 `resources/server/`。

## 构建

```bash
npm run app:desktop        # 产物：release/werewolf-ai-<版本>-win-x64-portable.exe
npm --prefix desktop start # 开发态直接跑（electron .）
```

## 数据目录

`%APPDATA%\werewolf-ai-desktop\`（`config.json`、`saves/`、`logs/`）。
刻意不写在安装目录里 —— 那里可能只读，且便携 exe 每次运行都会解压到临时目录。
菜单「工具 → 打开数据目录」可直接跳过去。

## 四个刻意为之的设计

1. **端口不写死**：启动时向系统要一个空闲端口（`net.listen(0)`）。写死 3210 的话，
   只要那个端口被别的程序占着，应用就直接启动失败 —— 这是上一版（文件夹 + `.cmd`）最可能的失败原因之一。
2. **服务端在进程内**：不 fork 子进程，退出即全部结束，不会留下孤儿 `node.exe`。
3. **单实例**：重复双击是把已有窗口拉到前台，而不是再起一个服务、再开一个端口。
4. **启动失败不静默**：30 秒内探不到 `/api/meta` 就弹错误框，附带数据目录与 `logs/server.log` 尾部。

## 构建期踩过的两个坑（换机器时可能还会遇到）

- **electron / electron-builder 的预编译二进制默认从 GitHub 下载**，本机到 `github.com:443`
  超时（`ETIMEDOUT 20.205.243.166:443`，只有 SSH 443 通）。
  已由 `scripts/build-desktop.js` 统一改走 `npmmirror.com` 镜像，可用同名环境变量覆盖。
- **`winCodeSign` 解压失败**：它含 macOS 的符号链接，而无符号链接特权（未开开发者模式 / 非管理员）
  时 7-Zip 报「客户端没有所需的权限」。本项目不签名，所以 `win.signAndEditExecutable: false`
  直接跳过它。代价：**exe 文件自身的图标是 Electron 默认图标**（窗口与任务栏图标由
  `BrowserWindow.icon` 指向 `web/assets/icon-512.png`，是正确的）。
  想要 exe 图标：用 `rcedit` 处理 `dist/win-unpacked/*.exe` 后以 `--prepackaged` 再打包，或开开发者模式。

## 未签名提示

exe 没有代码签名，首次运行 Windows SmartScreen 可能拦一下 ——
点「更多信息 → 仍要运行」即可。要消除需要买代码签名证书。
