# 独立代码验收报告（2026-09-21）

- **验收对象**：`D:\werewolf-ai`，HEAD = `d6d44d6`（含本次验收中我方提交的 `30989e9`、`d6d44d6`）
- **范围**：`e06d086`（上一轮我方最后提交，09-18）之后的全部提交，共创 65 个提交
- **方法**：三绿与红线由我方**亲自运行**；代码与文档层面的可疑项派**只读审计子智能体**分头排查，报告中的关键项**由我方逐条复算复核**。下文严格区分「我方亲手核实」与「子智能体报告、我方未逐条复核」。

---

## 一、结论

**代码层：有条件通过。交付层：不通过（产物落后于源码）。**

- 三绿成立：`npm test` **619/619**、`npm run gate` **退出码 0**、`npm run ui:check` **退出码 0**（均我方实跑）。
- 功能与契约层质量扎实：真实故障注入（EISDIR/EPERM/ENOSPC）、失败关闭语义、并发 409 真断言、内容寻址 ETag 复算等，是真护栏。
- **但当前 release/ 三包与源码不一致**：三包均报「`web/m/m.js` 与当前源码不一致（包里是旧版本）」，即 09-20 构建的产物**不含本次验收的修复**。发布前必须重打并回填哈希。
- 交付文档自相矛盾：同一交付出现 `cba485d`（结果文件）/ `bd99743`（目录名与台账）/ `493ec8f`（实际包内容）三个构建号，且 `packages.md` 记录的三个 SHA-256 与 `release/` 现物**全不符**。

---

## 二、我方亲手核实的事实

| 事项 | 实测 | 判定 |
|---|---|---|
| 测试全量 | `npm test` 619/619，0 失败 | 通过 |
| 门禁 | `npm run gate` 退出码 0；覆盖率门禁通过；winRate Δ0.000、avgDays Δ-0.050、isolation 0 | 通过 |
| 界面验收 | `npm run ui:check` 退出码 0，界面验收全部通过 | 通过 |
| 版本单一来源 | `release-version.json` = 1.5.2 / code 9；`build.gradle` versionCode 9 / versionName 1.5.2；`version:check` 一致 | 通过 |
| 包内源码 vs 源码 | 抽样 6 个文件（含 09-21 新增的 `web/shared/session-model.js`）SHA-256 与 APK 内条目**逐字节一致**；`app:verify` 109/110 文件全内容比对一致 | 通过（**在本日两次提交之前**） |
| 包内源码 vs 源码（现状） | 三包各报 1 处问题：`web/m/m.js` 与当前源码不一致（包里是旧版本） | **不通过** |
| 真机截图 | `output/takeover-2026-09-20/mobile-summary.png`：本局总结弹层在 390×844 下完整撑开 | 通过 |
| 工作树与远端 | 工作树 0 处改动；`origin/main` == HEAD | 通过 |
| 红线 | `config.json` 无改动；`saves/*.json` 73、`logs/game-*.log` 86（较我方离开时的 72/84 各有增长，来自后续设备实测流程，非我方写入） | 说明 |

---

## 三、本次验收中发现并已修复（我方提交）

1. **`30989e9` 手机端总结的「我的得分构成」渲染成空行**（P2，我方引入）
   根因：`src/engine/score.js:26` 的 `details` 是**字符串数组**（`"+10 存活到最后"`），而 `web/m/m.js` 按对象取 `d.points`/`d.label` → 每行渲染成空字符串。**靠真机截图发现，不是靠测试**。
   回归：`scripts/ui-check.js` 新增断言——得分构成每一行都必须有文字；修后实测 `{"header":true,"rows":["+10 存活到最后"],"blank":0}`。

2. **`d6d44d6` 四处 `404 || 500` 收紧为精确 404**（测试有效性，P2）
   `test/profiles-api.test.js:142/186/309/327`：路由崩成 500 也算通过，恰好放过最该拦的错误路径。收紧后四场景实测均返回 404，18/18 通过 —— **当前实现正确，但原断言是定时炸弹**。

3. **`d6d44d6` `dropped >= 0` 恒真断言收紧，并修掉测试自身的缺陷**（P2）
   `test/remediation.test.js`：收紧为 `dropped2 >= 1` 后**先变红**，排查发现是测试自己丢掉了第二次 `pruneGames` 的返回值（第一次调用时该局仍在 running，恒返回 0），`src/api.js:312-318` 的 prune 行为本身正确。现该断言真能红。

---

## 四、未修缺陷清单

### 我方已复核确认

| 级别 | 位置 | 问题 |
|---|---|---|
| P1 | `web/sw.js:29-54/88` + `src/static.js:171-180` | 预缓存清单是无查询串 URL（`/app.js`），而服务端下发 HTML 会把本地 js/css 改写成 `?v=<hash>`；`networkFirstAsset` 用 `cache.match(req)`（**无 `ignoreSearch`**）→ 预缓存条目**永远命中不了**。后果：装完 SW 未再联网就断网打开，页面外壳在、脚本全 miss。另 `SHELL` 漏了 `shared/session-model.js`（两个 HTML 都引用）。sw.js:85 的 `cache.put()` 未挂 `event.waitUntil`。 |
| P1 | `artifacts/acceptance/1.5.2-bd99743/packages.md:8-10` | 记录的三包 SHA-256 与 `release/` 现物全不符；台账 `docs/final-delivery-status.md:48` 却称「哈希已更新」。**交付完整性不通过。** |

### 子智能体报告、我方未逐条复核（均带 file:line，建议按序核实）

| 级别 | 位置 | 问题 |
|---|---|---|
| P1 | `src/profiles/store.js:237/243/244` | `trash()` 先写 index 再 rename 目录、restore.json 最后写，全程无回滚：rename 失败则档案从界面上消失但文件仍在；目录已进回收站却无 restore.json 则**永久不可恢复**。 |
| P1 | `scripts/build-desktop.js:62` | 构建前 `readdirSync(dist)` 无 `existsSync` 守卫 → 干净检出打包直接 ENOENT。 |
| P2 | `web/app.js:1771`、`web/m/m.js:2526` | 「清除标注」用 PUT 写空标注而非已有的 DELETE（`src/api.js:844`）→ 座位永久留在 `doc.seats`，导出计数含已清空座位（前后端口径不一致）。 |
| P2 | `web/pwa.js:92-97` + `web/style.css:1320-1323` | Esc 关闭浮层用 `l.hidden = true`，但 `.modal{display:flex}` 覆盖 UA 的 `[hidden]{display:none}` → 弹层仍在；且不走 `closeModal`，遮罩监听与焦点恢复不清理。 |
| P2 | `src/profiles/store.js:272-281` | `touch()` 全仓无调用者，前端按 `lastUsedAt` 排序实为「最近编辑」，且它绕过原子写。 |
| P2 | `web/app.js:996-1013`、`web/m/m.js:1112-1126` | `saveProfilePrefs` 遇 409 不重拉档案 → revision 永远过期，之后每次保存都 409（自锁），直到刷新页面。 |
| P2 | `src/profiles/migration.js:76` | `_clearDefaultId()` 从未被调用 → 默认档案被归档/删除后，启动时可能**再建一个「默认玩家」**。 |
| P2 | `src/api.js:160-165`、`src/profiles/store.js:85` | `_cleanupStaleTmp()` 无调用者，且现有临时文件命名都不匹配它的过滤 → 硬杀后临时文件永久占盘。 |
| P2 | `src/static.js:34-38/189-197` | 图标类资源 `max-age=86400` 且 URL 不版本化（本次 icon 内容变了名字没变）→ 最长 24h 旧图标；`depsUnchanged()` 每次 HTML 请求全量读盘哈希，与注释宣称的 stat 快路径不符。 |
| P2 | `src/profiles/store.js:249-269` | `restoreFromTrash` 生产零调用、无路由 → 「归档代替删除」的恢复能力只存在于注释里。 |
| P2低 | `src/annotations/store.js:117-134` | `putSync` 生产无调用（仅测试），是绕开每文件串行队列的版本（`api.js:1906` 注释描述的正是它的历史丢写缺陷）→ 复用它即回归。 |
| P2低 | `scripts/build-apk.js:48-49` | 硬编码本机 JDK/SDK 路径（非本次新增），分发不可移植。 |

### 测试有效性（子智能体报告，我方已复核其中两处）

- **已复核**：`test/profiles-api.test.js` 四处 `404 || 500`、`test/remediation.test.js:653` 的 `assert.ok(true)` 与 `:812` 的 `dropped >= 0`（前两处已修，第三处已修并连带修掉测试自身缺陷）。
- **待处理**：`scripts/ui-check.js:856` 用 `b.exceptions.splice(beforeExc)` 清掉本段新增的页面异常（注释写明是为已知缺口 F5 让路），使全局「无未捕获异常」检查在该段失效 —— 建议改为按段独立记账，而不是删除。
- **系统性风险**：ui-check 90 条 `check` 中仅 4 处量盒子几何，设置页/恢复卡/离线横幅/状态条仍是「存在 + 文字」型断言 —— 与「文字都在、盒子 2px」同型事故的漏洞面仍在。
- **无 meta 检查**：没有机制拦截 `assert.ok(true)`、`>= 0`、`404 || 500` 这类模式重新进仓库。

---

## 五、无法核实（缺证据，不当作通过）

- 物理真机与 MuMu 设备参数、除 `mobile-summary.png` / `mobile-game.png` 外其余截图的语义。
- AC-04 双窗口档案交互的端到端行为（仅代码层核对到实现）。
- 导出入口在 Capacitor WebView 中是否真的触发下载（`window.open('/api/profiles/:id/export')`）。
- 性能/时长类门槛：619 条测试中没有一条会因接口变慢或卡死而红。

---

## 六、建议的下一步（按性价比）

1. **重打三包并回填哈希**（当前产物已落后源码一个文件；同时可把 `packages.md` 的哈希与构建号收敛到**单一 HEAD**）。
2. 修 `web/sw.js`：`cache.match(req, { ignoreSearch: true })` + `SHELL` 补齐 `shared/session-model.js` + `cache.put` 挂 `waitUntil`（离线能力是产品承诺，且修复成本极低）。
3. 修 `src/profiles/store.js` 的 `trash()` 顺序（先落盘再改 index，失败回滚）——这是唯一会造成**用户数据不可恢复**的缺陷。
4. 给 `scripts/build-desktop.js` 加 `existsSync` 守卫（一行）。
5. 把 ui-check 的异常记账改为按段独立，并给设置页/恢复卡补几何断言。
