# AI 代真人验收：四项目标的实跑汇总（2026-09-23）

- 汇总时刻：2026-09-23 21:50 本地（= 13:50Z）。本文所有读数都是**我读取磁盘文件那一刻**的读数。
- 前提（必须知道）：这三路测试由**多个并行代理在同一台机器上继续产出**，我在汇总期间 `logs/r01/`、`logs/exe-native/`、`logs/android-native/` 仍在增长。
  因此本文结论是**"读数快照"而不是"最终态"**；凡是我读取后又有新日志落地的，我单独标注。
- 纪律：没做到的写"未做到"，没读到的写"未取得"，转述的读数标明"转述、磁盘上无落盘"。
- 明确不写成结论的：① 的导入侧"到底弹不弹选择器"——**未定论**（见 §1.4）。

## 0. 结论速览

| # | 目标 | 结论 | 一句话实据 | 出处 |
|---|---|---|---|---|
| ① | Windows EXE 原生「保存导出文件→选回该文件→导入」真实往返 | **未成立（未做到）** | 新构建上：导出侧**没有**原生保存对话框；导入侧**没有**观测到原生打开对话框；脚本在诊断段 CDP 超时中断 ⇒ **无导入结果读数、无 PASS/FAIL 汇总行、无退出码行** | `logs/exe-native/roundtrip-2026-09-23T13-34-10-153Z.log` |
| ①附 | 导出＝下载回落（验收要求与既定实现不符） | **成立**（口径问题，不是"导出坏了"） | 应用自报「已发起下载 —— 浏览器无法确认文件是否已保存，请到浏览器的下载目录确认。」；并真的落盘 545B 的包 | 同上 `:46`、`:58`、`:60` |
| ② | Android 1.5.2 重打包→装机→device-check→设备上导出回导 | **半程成立**：导入半程 ✓，**导出半程 ✗（设备上是真缺陷）** | 导入：真 SAF 选择器 → 预览「尚未写入任何数据」→ OK → 「导入完成：N 局已归入新档案「X」（副本，原档案未改动）」；导出：真实 UI 点击 3 次**不产生任何文件**（`m.js:1315`/`:1821` 都硬连浏览器下载臂，WebView 未注册 `setDownloadListener`） | 见 §2 |
| ②附 | device-check（模拟器在线） | **成立** | `结果：10/10 条判据成立`（emulator-5554，PGBM10/Android 12，前台 `com.werewolfai.app/.MainActivity`） | `artifacts/acceptance/1.5.2-4092351/logs/device-check.log` |
| ③ | R01：人类行动 `pendingId` 来自"当时面板武装的任务" | **成立**（四类行动双端全绿 + 边界全绿，但**分在两轮**） | 全量轮 32 通过/0 失败/1 未验证；边界轮 23 通过/0 失败/0 未验证（含 B5 刷新） | `logs/r01/r01-pendingid-2026-09-23T13-39-50-342Z.log`、`...13-43-14-285Z.log` |
| ④ | 当前 HEAD 的提交级制品一致性证据 | **已生成；退出码 1（5/6）**，唯一失败项是"工作区干净"这条 | `artifacts/acceptance/1.5.2-4092351/`；全量测试 1147/1147 fail 0、app:verify ✓、空白帧 200/200、device-check 10/10、9 个制品哈希 ✓ | §4 |

## 1. ① Windows EXE 原生往返

可复跑脚本：`scripts/exe-native-roundtrip.js`（`node scripts/exe-native-roundtrip.js`）。
该脚本在本次汇总期间**仍在被修改**（21:43:55 又改过一版），所以"哪一轮对哪个脚本版本"我也如实标注。

### 1.1 哪一轮对哪个制品（EXE 路径 + sha256 + mtime）

被测验的制品是 `desktop/dist/win-unpacked/werewolf-ai-desktop.exe`。**09-22 那版是陈旧构建，21:30:43 之后才是新构建**：

| 轮次日志 | EXE mtime | EXE 身份 | 该轮结果 |
|---|---|---|---|
| `...13-14-06-552Z-v1.log` | 2026-09-22T15:35:14.013Z（陈旧） | 未记 sha256 | 导出/导入均 FAIL；**无汇总行、无退出码行**（末行是应用进程退出 SIGTERM） |
| `...13-20-31-499Z.log` | 2026-09-22T15:35:14.013Z（陈旧） | 未记 sha256 | `PASS 9 / FAIL 7 / WARN 0（共 16 条判据）`，**退出码 1** |
| `...13-23-34-086Z.log` | 2026-09-22T15:35:14.013Z（陈旧） | 未记 sha256 | `PASS 10 / FAIL 6 / WARN 0（共 16 条判据）`，**退出码 1** |
| `...13-27-31-866Z.log` | 2026-09-22T15:35:14.013Z（陈旧） | 未记 sha256 | 无汇总（`CDP 超时 Runtime.evaluate`） |
| `...13-32-46-998Z.log` | **2026-09-23T13:30:43.521Z（新）** | 未记 sha256 | 无汇总（脚本自身崩溃：`ReferenceError: Cannot access 'exportByDownload' before initialization`） |
| `...13-34-10-153Z.log` | **2026-09-23T13:30:43.521Z（新）** | `size=246212608`，`sha256=d17d2c52fac0eef7578aace31b36d85fb8a9fe5ea858f14c188d3923c86fd511` | **走得最远的一轮**；导出/导入判据 FAIL，诊断段后 CDP 超时中断；**无汇总行、无退出码行** |
| `...13-38-18-743Z.log` | 同上（新） | — | 只写了 4 行参数就停（被抢占/中断） |
| `...13-44-08-524Z.log` | 同上（新） | — | 我读取时**仍在写**；已出现 `fronted=False attempts=7`（前台被另一个 Chrome 窗口 `fgProcId=32736` 占住）⇒ 结论未定，本文不引用 |

补充（不是"已确认"）：`release/` 下的交付 EXE 是**另一份文件**——`release/werewolf-ai-1.5.2-win-x64-portable.exe`（124875554B，mtime 21:38:22，sha256 `8ab5060efb747915370dc21cf37accd7aac2a4354c73fbae3a4c455540952e02`）。
往返测试跑的是 `win-unpacked` 里那份，我**没有**核对二者内容一致（`app:verify` 只证明 release 包与源码一致）。

### 1.2 导出侧：成立的部分

新构建 13:34 轮的真实读数（`...13-34-10-153Z.log`）：

- 真实鼠标点击（CDP `Input.dispatchMouseEvent`）命中自检通过：`elementFromPoint(382,561) → "BUTTON#pc-export.btn" text="导出当前档案" 命中该按钮或其子节点=true`（`:42-:43`）。
- 下载类 CDP 事件 14 条：`Browser.downloadWillBegin / Page.downloadWillBegin / …downloadProgress`（`:46`）。
- 应用内状态行（导出侧口径）：`"已发起下载 —— 浏览器无法确认文件是否已保存，请到浏览器的下载目录确认。"`（`:46`）。
- 应用**没有路径选择**（无原生保存对话框），但文件真落盘并通过校验：
  `D:\ww-probe\exe-rt\downloads\ww-profile-RT基线T13-3-2026-09-23.json`，`545 字节`，`sha256=73d5aabf39f9080b6b05511c709bd2138e511adad7cf5189e2be473e6f62ebf0`（`:60`），包内 `profile.bio` 与基线**逐字相同**（`:62`）。
- 破坏现场（改昵称/简介）也真的生效（`:68`），说明"导出→破坏→导入恢复"这条链的中间步骤是活的。

**结论（精确表述）**：本实现的导出 = **Electron 下载回落**（无路径选择）；验收要求的"原生保存对话框"与其**既定设计不符**，**≠"导出坏了"**。该判断是脚本自己写下的（`:47`），我复核了它的读数依据。

### 1.3 导出侧：未成立的部分

- `FAIL 点击导出后出现原生保存对话框` —— 未出现任何新的顶层窗口（新窗口=`[]`，`:51`）。
- 方法学注意：13:44 轮已明确打印 `fronted=False`（应用窗口抢不到前台，被另一个 Chrome 窗口占住），13:34 轮则是"自报置前成功、但按键实际送进了别的 Chrome 窗口"（`:101-:104`）。
  所以"窗口枚举没看到对话框"这一结论**受环境干扰**，我不把它升级为"实现一定不弹原生框"。

### 1.4 导入侧：最终到底弹不弹选择器 —— **未定论**

同一轮（新构建 13:34）的读数：

- 点击前 `input[type=file]` 数量 `0`；点击后**页面确实创建并点击了一个** `accept=".json,application/json"` 的 file input（`:75`、`:80`）⇒ 点击路径是活的。
- 点击命中自检通过：`elementFromPoint(514,561) → "BUTTON.btn" text="导入档案包" 命中=true`（`:77`）。
- **未开启任何 CDP 拦截**的那一段（即验收判据段）：新顶层窗口 `[]`，`FAIL 点击导入后出现原生打开对话框`；改用 `JS element.click()` **同样**没有对话框（`:85-:91`）。
- 诊断段（脚本自己声明**不作为**验收判据，`:94`：`CDP 文件选择器拦截已开启 = true`）：`Page.fileChooserOpened = [{"frameId":"4A3F…","mode":"selectSingle","backendNodeId":27}]`（`:99`），随后 `DOM.setFileInputFiles` 把导出的真文件喂了进去（`:100`）；再之后脚本在回车确认段 `CDP 超时 Runtime.evaluate` 中断（`:105-:108`）。

**所以**：能证实的只有"页面请求了文件选择器"（诊断段的 `Page.fileChooserOpened`）。**"EXE 上到底弹不弹原生打开对话框"我判为未定论**——不写成产品缺陷，也不写成通过。
**明确未做到**：EXE 上"选回刚保存的文件→导入完成"的闭环（没有导入结果读数、没有汇总行、没有退出码）。

### 1.5 ① 的未成立/未验证清单

- 未做到：EXE 原生保存对话框（与既定设计不符，属口径问题）。
- 未做到：EXE 上导入闭环（选回文件 → 导入 → 档案真的改变）。
- 未定论：导入侧弹不弹选择器（页面侧有 `Page.fileChooserOpened`；窗口枚举侧无）。
- 未取得：可用的退出码（该轮无 `退出码 = N` 行）。
- 未取得：方法学洁净的前台条件（`fronted=False`，前台被无关 Chrome 窗口占用）。

## 2. ② Android 1.5.2 重打包 → 装机 → device-check → 设备上导出回导

### 2.1 制品与装机（成立）

| 读数 | 值 | 出处 |
|---|---|---|
| 打包 | `release/werewolf-ai-1.5.2-debug.apk` = **185535461 B**，sha256 **`edbadbaa90fcd1f5deaec046e9512e80e86d61dc92f983b86e418cdc79496fde`** | 我自己 21:43 用 `Get-FileHash` 复核；同值见 `artifacts/acceptance/1.5.2-4092351/MANIFEST.md` |
| 设备上拉回的那份 | `logs/android-native/device-base.apk` 同为 185535461 B / `edbadbaa…` | 我复核 ⇒ **设备上装的就是 release 那份** |
| 安装 | `Performing Streamed Install / Success` | `logs/android-native/adb-install.log` |
| 装机结果 | `versionCode=9` `versionName=1.5.2` `lastUpdateTime=2026-09-23 21:13:11` | `logs/android-native/pkg-dumpsys.txt` |
| 包内容校验 | `✓ 144 个文件全部内容比对`；`176.9 MB` | `logs/android-native/build-apk.log` |
| device-check | **10/10 条判据成立**；`emulator-5554`，`model=PGBM10 android=12`，`1080x1920`，前台 `com.werewolfai.app/.MainActivity`，截图 1920x1080 / 526810B / 最高频像素 3.80% | `artifacts/acceptance/1.5.2-4092351/logs/device-check.log`（另有一份并行的 `logs/android-native/device-check.log`，同样 10/10） |

### 2.2 导入半程：**成立**（设备上真 SAF 选择器 + 真归档）

- 设备上出现**系统文档选择器**（Android DocumentsUI），并浏览到「下载」目录看到导出的包：截图 `logs/android-native/12-picker-downloads.png`（我直接看过：标题「下载」，条目 `ww-profile-rou…` `36.28 kB` `下午9:21`）。
- 预览框原文（`uiautomator dump`）：`logs/android-native/ui-dialog.xml`、`ui-p3.xml`：
  「导入预览（尚未写入任何数据）：档案：默认玩家 已结束对局：1 局（ID 会重新生成，不覆盖现有对局）笔记：0 份 包大小：35.4 KB 进行中的对局不会包含在包内。确认导入？」
- 点 OK 后的完成提示（截图 `logs/android-native/15-after-import-ok.png`，我直接看过）：
  「**导入完成：1 局已归入新档案「默认玩家」（副本，原档案未改动）**」；
  第二轮（0 局包）的提示见 `logs/android-native/ui-alert2.xml` / `29-reimport-done.png`：「导入完成：0 局已归入新档案「RT-TEST」（副本，原档案未改动）」。
- 导入前后对照（JSON）：
  `logs/android-native/roundtrip/state-before-import.json` 只有 1 个档案 `c30a62d6-…`（`updatedAt=2026-09-19T15:48:43.945Z`）；
  `state-after-import.json` 变成 2 个——原档案**逐字节未变**，新增副本 `2fbce36b-c9df-400f-a8c3-ffa3e12f059c`（`createdAt=2026-09-23T13:24:11.022Z`）⇒ "副本，原档案未改动"这句话有物证。

### 2.3 导出半程：**未成立 —— Android 上是真缺陷**（按 Android 路的结论，代码级成因我自己复核过）

- 现象（Android 路报告）：设备上真实 UI 点击「导出当前档案」**3 次稳定不产生任何文件**（`/sdcard/Download`、`Documents`、应用 cache 都没有）。
- 代码级成因（**我用仓库/包内容独立复核**）：
  - `web/m/m.js:1315` 与 `web/m/m.js:1821` **两处都硬连** `browserExportProfile(...)`（浏览器下载臂）；`browserExportProfile` 定义在 `:2208`。
    复核方式：`release/werewolf-ai-1.5.2-debug.apk` 内 `assets/public/nodejs/web/m/m.js` 与仓库 `web/m/m.js` **同为 236706 B / sha256 `d14bcf75c235d84a4dca03d72ecc204f1c5f79c1dd52e93e684c212860d43808`** ⇒ 包里就是这份代码。
  - 原生桥**存在**：`app/android/app/src/main/java/com/werewolfai/app/MainActivity.java` 里 `BRIDGE_NAME = "WWExport"`、方法 `exportProfile`（ACTION_CREATE_DOCUMENT + SAF，:`36`/`:57`/`:73`）。
  - 但 WebView **没有注册 `setDownloadListener`**：我在全仓 grep `setDownloadListener` ⇒ **0 命中**；`WWExport` 在 `web/**` 里也 **0 命中**（只在 Java 与测试里出现）⇒ 下载臂被静默丢弃，而页面仍显示「已发起下载…」的**误导文案**。
- 端点本身是好的：`adb shell curl http://127.0.0.1:3210/api/profiles/<id>/export` ⇒ **HTTP 200 / 36277 B**。
- **重要口径更正**：我早前在 §2.2 引用的那个 **36277 B 包来自端点**（或测试侧取回），**不是 UI 导出按钮的产物**；`logs/android-native/roundtrip/exported-ww-profile.json`（36277B，`counts.games=1`，`profile=默认玩家`，`createdAt=2026-09-23T13:21:22.921Z`）应按"端点导出"理解。

### 2.4 ② 的 m.css 读数（**必须分清两件事**）

1. **APK 内嵌资源**（**我独立复核，成立**）：从 `logs/android-native/device-base.apk`（= release 那份）与 `release/werewolf-ai-1.5.2-debug.apk` 内解出
   `assets/public/nodejs/web/m/m.css` = **56496 B / sha256 `364106cf12f828da89675c01807ecac64c810e541b833bbd8a7d70cdf41a9433`**，与仓库 `web/m/m.css` **完全一致**（`m.js` 亦然）。
2. **设备运行时活着的那份**：Android 路报告称已取得——页面内 `fetch('/m/m.css',{cache:'no-store'})` ⇒ **56496 B / sha256 `364106cf…`**，5 个特征串命中，构建指纹 `?v=364106cf12f8`（**转述**）。
   但**这个读数在磁盘上没有任何落盘文件**（我 grep 整个 `logs/` 找 `364106cf` ⇒ 只命中脚本源码，没有读数文件）。
   ⇒ 从**我的证据面**看，这一条仍是"**未取得磁盘读数**"；能自己复核的只有第 1 条。

### 2.5 三条会毁掉真机取证脚本的坑（Android 路报告，单列）

1. 这台 MuMu 的页面 CSS viewport = `1098×594`、`dpr=1.75`，而 `adb input tap` 吃**设备像素** ⇒ 直接用 `getBoundingClientRect()` 的坐标会**静默偏移约 43%**（这就是"点了没反应"的原因），必须换算或改用 `uiautomator dump` 的真实 bounds。
2. `adb exec-out screencap -p > 文件` 在 PowerShell 下**会把 PNG 写坏**（`read_image` 报 malformed）；必须 `screencap -p /sdcard/x.png` + `adb pull`。
3. WebView 的 `alert/confirm` 是**原生对话框**（`uiautomator dump` 可见，会**阻塞页面 JS、让 CDP evaluate 挂死**），要按 dump 的真实 bounds 去点。

### 2.6 测试在设备上留下的状态（如实记录，未清理）

`profiles/` 现有 **3 个**档案：原始 `c30a62d6`（未动、5 局）+ 导入副本 `2fbce36b`、`e3b49151`（各 1 局）；回收站另有 2 条一次性 `RT-TEST` 记录。
app 只有"归档→删除"、没有永久清除，副本含未结束对局故归档被正当拦下 ⇒ Android 路决定**保持现状**（它本身就是导入测试的证据）。
（我本人没有写 `saves/`、`profiles/`、`config.json`。）

## 3. ③ R01：人类行动 `pendingId` 来自"当时面板武装的任务"

可复跑脚本：`scripts/r01-pendingid.js`（`node scripts/r01-pendingid.js`；本次各轮用 `WW_UI_PORT=3851 WW_CDP_PORT=9961 WW_DATA_DIR=D:\ww-probe\r01-data`）。
日志目录：`logs/r01/`（同名 `.json` 是证据体）。

### 3.1 我引用的两轮（互补）

| 轮次 | 覆盖 | 读数 | 退出码 | 出处 |
|---|---|---|---|---|
| 13:39:50 | 四类行动 × 桌面/手机 + 边界 B1–B4 | **32 通过 / 0 失败 / 1 未验证** | **3** | `logs/r01/r01-pendingid-2026-09-23T13-39-50-342Z.log` |
| 13:43:14 | 仅边界 B1–B5 | **23 通过 / 0 失败 / 0 未验证**（含 B5 刷新） | **0** | `logs/r01/r01-pendingid-2026-09-23T13-43-14-285Z.log` |

成立的核心读数（都来自"真页面点击 + 捕获真实请求体"，不是测试侧补 ID）：

- 桌面/手机四类行动（发言、投票、守卫/狼刀、女巫）都 `match: true` + `status=200`，且 `面板武装 == 服务端当时` 的 `pendingId`（`:12`、`:16`、`:27`、`:31` 等）。
- 请求体确实是**页面自己**发的（`initiator=script`，CDP 只记浏览器流量，测试布景请求不在其中）（`:14`）。
- 服务端**真的消费**了该任务：`armedId=… → 现在=…`（`:18`、`:33`）。
- 边界 B1 旧面板：屏幕上旧面板武装的旧 ID 被原样发出，服务端 **409 `PENDING_ID_STALE`**「该操作已过期或已被处理（pendingId 已失效），请刷新页面后重试」，且**零副作用**（事件 21 → 21）（`:41-:43`）。
- 边界 B5 刷新（13:43 轮）：刷新后面板重新武装**当前**任务 ID（`26f45301-…`）并被接受 200；刷新前那份旧 ID 回放被 409 拒绝，且不消耗对局状态（`:50-:55`）。

### 3.2 未验证项与其处置

- 13:39:50 全量轮的**唯一未验证**是 `B5 刷新：刷新前需要有新的待办任务 — 服务端当前没有 pending（对局过早结束）`（`:70`）⇒ 属"环境/布景没造出来"，不是失败。
  该缺口已由 13:43:14 的边界轮**补上并全绿**（退出码 0）。
- **但没有任何单轮同时覆盖"四类行动双端 + B1–B5 全绿"**：全量轮缺 B5，边界轮不含四类行动。要说"R01 全绿"，必须同时引用这两轮。

### 3.3 日志仍在增长的如实标注

我读取期间 R01 还在被反复重跑，同目录还有：13:41:34（15 通过/3 失败/0 未验证，退出码 1）、13:43:14（23/0/0，退出码 0）等更早轮次（13:17:37、13:19:04、13:20:59、13:25:18、13:28:35、13:30:08、13:31:56、13:34:16、13:38:05）。
**我的结论只对 13:39:50 + 13:43:14 这两轮负责**；其后若再落盘新轮次，以新日志为准。

## 4. ④ 提交级验收快照（我自己跑的这一次）

- 命令：`node scripts/acceptance-snapshot.js`（**未加任何 `--skip`**）
- 快照目录：`artifacts/acceptance/1.5.2-4092351/`（`MANIFEST.md` + `manifest.json` + `logs/`）
- **退出码：1**（`SNAPSHOT_EXIT=1`），结论：**存在未通过项（5/6）**
- 运行时刻：2026-09-23T13:46:41Z 起，`MANIFEST.md` 生成于 `2026-09-23T13:49:03.601Z`

| 检查项 | 结果 | 读数 | 日志 |
|---|---|---|---|
| 提交与工作区：工作区干净 | ❌ | 未提交改动 2 项：`M scripts/r01-pendingid.js`；`?? artifacts/acceptance/1.5.2-ac240c0/` | — |
| 全量测试 `node --test` | ✅ | `tests 1147 / pass 1147 / fail 0`（`duration_ms 37203`） | `logs/test.log` |
| 制品一致性 `npm run app:verify` | ✅ | APK/WIN/DESKTOP 三者"与当前源码一致"（144/144、145/145 文件逐一比对）；DESKTOP `8ab5060efb747915…` | `logs/app-verify.log` |
| 证据目录空白帧闸门 `png-stats docs/evidence/*` | ✅ | 合计 200 张：有画面内容 200，空白或读取失败 0 | `logs/png-stats.log` |
| Android 真机验证 `device-check` | ✅ | `结果：10/10 条判据成立` | `logs/device-check.log` |
| 制品清单与 sha256（9 个） | ✅ | 见下 | — |

制品哈希（本次快照实测）：`release/werewolf-ai-1.5.2-debug.apk` 185535461B `edbadbaa…`（= 设备上装的那份）、
`release/werewolf-ai-1.5.2-win-x64-portable.exe` 124875554B `8ab5060efb747915370dc21cf37accd7aac2a4354c73fbae3a4c455540952e02`、
`release/werewolf-ai-1.5.2-win-x64.zip` 148458487B `4675278b0850a885921d9f5c44c46fdc3aa0f77fa246e94918427cfdf87182e7`。

### 4.1 唯一失败项的原因（如实记录，没有改判据）

失败的是"工作区干净"这一条，原因是**并行代理的时序差**，不是制品问题：

1. `M scripts/r01-pendingid.js`：R01 那路当时正在改这个脚本（我 21:46 之后还看到它在 21:46:13 被再次修改）。
2. `?? artifacts/acceptance/1.5.2-ac240c0/`：另一个代理 21:42:36 跑的快照目录，当时尚未提交（它随后在 `f380286` 被提交）。

### 4.2 这次快照自身的一处不一致（我发现并如实记下）

`MANIFEST.md` 第一行写 `# 验收快照 · 1.5.2 @ 4092351`、目录名也是 `1.5.2-4092351`，但同一文件里的 `- 提交：` 字段写的是 **`312e0aeab4149d6af707974784acd3c063d589f4`**，`logs/git-status.log` 也记 `commit=312e0ae…`。
原因（可推证）：脚本在 `HEAD`（`:35`）与 `--short HEAD`（`:36`）之间，恰好有一个提交 `4092351` 落盘 ⇒ 目录名用了新短号、字段与 git-status 用的是旧完整号；随后 `:68` 的 `git status` 跑在 `4092351` 的树上（所以 `M scripts/exe-native-roundtrip.js` 没出现在脏列表里，它被那次提交收走了）。
**这是快照脚本的读取竞态，不是制品不一致**；引用这份快照时应写"对应 commit `4092351`（内容与 `312e0ae` 仅差 `scripts/exe-native-roundtrip.js` 一个文件）"。
另：`logs/git-status.log` 里还列了 `?? design/card-frames/`，它在脚本白名单内，不计入失败项。

## 5. 可复跑脚本与证据文件索引

| 目标 | 可复跑脚本 | 证据 |
|---|---|---|
| ① EXE 原生往返 | `scripts/exe-native-roundtrip.js` | `logs/exe-native/roundtrip-2026-09-23T13-34-10-153Z.log`（最完整一轮）、`export-meta-*.json`、`baseline-*.json`、`post-import-*.json` |
| ② Android 设备往返 | `scripts/build-apk.js`（打包/装机）、`scripts/device-check.js`；设备侧取证脚本散在 `logs/android-native/*.js`（`probe-css-hash.js`、`probe-export-wiring.js`、`probe-pc-export.js`、`probe-assets.js`、`click-*.js`） | `logs/android-native/roundtrip/`、`ui-*.xml`、`0N-*.png`、`build-apk.log`、`adb-install.log`、`pkg-dumpsys.txt`、`device-check.log` |
| ③ R01 | `scripts/r01-pendingid.js` | `logs/r01/r01-pendingid-2026-09-23T13-39-50-342Z.log` / `...13-43-14-285Z.log`（及同名 `.json`、`boundary-*.png`） |
| ④ 提交级快照 | `scripts/acceptance-snapshot.js` | `artifacts/acceptance/1.5.2-4092351/`（`MANIFEST.md`、`manifest.json`、`logs/*`）；另有并行的 `artifacts/acceptance/1.5.2-ac240c0/` |

## 6. 未完成 / 未取得 / 未定论（一次列全）

1. **① 未做到**：EXE 上"原生保存对话框"这条验收要求（与实现既定设计不符）。
2. **① 未做到**：EXE 上"选回刚保存的文件→导入完成"闭环；该轮**无导入结果读数、无 PASS/FAIL 汇总、无退出码**。
3. **① 未定论**：导入侧到底弹不弹原生打开对话框（页面侧有 `Page.fileChooserOpened mode=selectSingle`，窗口枚举侧无）。
4. **① 未取得**：方法学洁净的前台条件（`fronted=False`，前台被无关 Chrome 窗口占用）。
5. **② 未成立**：Android 上 UI 导出按钮不产文件（真缺陷；成因见 §2.3）。
6. **② 未取得（我的证据面）**：设备运行时那份 `web/m/m.css` 的字节/sha256 **在磁盘上没有落盘读数**；Android 路转述为 56496B/`364106cf…`（与仓库同值），我**无法从磁盘复核**。我能复核的只有"APK 内嵌资源 = 仓库 = 56496B/`364106cf…`"。
7. **③ 未验证（在 13:39:50 全量轮里）**：B5 刷新（已由 13:43:14 边界轮补上）；并且**没有单轮**同时覆盖四类行动双端 + B1–B5。
8. **③ 时效**：R01 日志在我汇总期间仍在增长，本文只对 13:39:50 与 13:43:14 两轮负责。
9. **④**：快照退出码 1、5/6，失败项是"工作区干净"（并行时序差）；另发现 `MANIFEST` 提交字段与目录名差一个提交（快照脚本读取竞态）。
10. **未清理**：设备上 `profiles/` 3 个档案（原档 + 2 个导入副本）与回收站 2 条 `RT-TEST` 记录，按 Android 路的决定保持现状。

## 7. 我没有做的事

- 没有改任何判据、没有跳过任何一步来"变绿"；快照失败项照原样记入（含原因）。
- 没有修改 `web/**`、`src/**`、`scripts/ui-check.js`、`scripts/device-check.js`、`scripts/ui-capture.js`，也没有改其它代理的脚本（`scripts/exe-native-roundtrip.js`、`scripts/r01-pendingid.js`、`scripts/android-native-*.js`）。
- 没有写 `saves/`、`profiles/`、`config.json`；没有 git 提交/推送别的文件。
- 没有把 Android 路的转述读数写成"我复核过"；也没有把"窗口枚举没看到对话框"写成"实现一定不弹"。
