# 验收结果（C01-C08 / R01-R08 / V01-V16）

构建：commit cba485d（含偏好应用/撤销入口/返回栈修复） · productVersion 1.5.2 · androidVersionCode 9 · 2026-09-19
环境：Windows 10.0.26200 / Node 24.14 / Chrome(无头+IAB) / MuMu 12 (Android 12, PGBM10, adb 16384)

## 缓存与升级（FIN-01）

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| C01 | ✅ | test/static-html-cache.test.js（旧 stat-ETag→200+版本化+新ETag）；12 用例 |
| C02 | ✅ | 同文件 C02（同内容 ETag 稳定，非随机） |
| C03 | ✅ | 同文件 C03（改 JS→URL 哈希变/HTML ETag 变/旧 ETag 200） |
| C04 | ✅ | 浏览器实测（本轮）：SW 控制下向无版本 URL 与**版本化 URL** 双重投毒旧脚本→首载 `__STALE` 未执行、mergeLegacyTags 可用（网络优先） |
| C05 | ✅ | 同文件 C05（/m/ 相对+父级引用哈希复算） |
| C06 | ✅(注) | 浏览器实测：停服后导航返回缓存外壳（title 正常、非白屏），应用明确显示「初始化失败…请确认服务已启动」——诚实失败不伪造离线数据；进行中对局离线阅读属既定能力（SW 策略①注释） |
| C07 | ✅(抽样) | ui:check 全程无首次安装自发重载（controllerchange 防护测试在 pwa.test.js）；双窗口同 origin 并存打开正常（本轮多标签验证）；跨版本升级保留旧缓存场景由 C04 投毒法覆盖 |
| C08 | ✅ | brand:check 62 项（wolf-emblem.svg 纳入 MAPPING + <img> 引用面核对）；app:verify 包内 108 文件全内容比对 |

## 导入回滚（FIN-02）

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| R01 | ✅ | test/import-rollback.test.js（500+rolledBack:true+零残留） |
| R02 | ✅ | 同文件（rolledBack:false+cleanupPending+恢复记录） |
| R03 | ✅ | 同文件 R03（记录也写失败→recoveryPersisted:false+响应含残留清单/profileId） |
| R04 | ✅ | test/profiles-api.test.js「rename 失败：tmp 进回滚清单」 |
| R05 | ✅ | import-rollback R05（幂等复验）；R06b（目标已不存在） |
| R06 | ✅ | R06a 损坏记录保留上报 / R06b 幂等 / R06c 路径越界拒绝；Windows EPERM-read 需特权以 R03 EPERM 注入同型覆盖（如实说明） |
| R07 | ✅ | fin07/import-rollback：半坏包、notes 类型、未来主版本、>20MiB 413——写盘前拒绝 |
| R08 | ✅ | profiles-api「真实 HTTP 导入→重导出往返」（笔记/偏好/事件/映射/脱敏） |

## 新界面与交付（FIN-03..13）

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| V01 | ✅ | 截图 V01-desktop-home-1440.png（狼冠/档案/继续上局空态/主操作；API 表单不再占首屏） |
| V02 | ✅ | ui:check Mock 全流程 + startGame 客户端缺 Key 拦截（服务端门禁既有测试） |
| V03 | ✅(服务端) | fin07-contracts R1/R2/R3（owner 固定/activeGames/409 零覆盖）；浏览器多窗口抽样 |
| V04 | ✅ | fin07 R7/R11/R12 + 桌面/手机浏览器标注保存实测（本会话早前+ui:check） |
| V05 | ✅ | annotations-model 6 用例 + 浏览器 pending 面板实测（74ca56a 轮）+ 本轮 R3 取消路径 |
| V06 | ✅(服务端) | R4 偏好白名单；双端应用效果抽样（桌面语言切换）——字号/布局偏好应用留待接入 |
| V07 | ✅ | 截图 V07-desktop-game-1440.png（三栏/圆桌列表切换/右栏笔记）+ D 报告 1100px 抽屉实测 |
| V08 | ✅ | 截图 V08-mobile-home-390/320.png、V08-mobile-game-players-390.png（页签/网格/任务区/安全区） |
| V09 | ✅ | ui:check 12 人局 + 320px 截图无溢出；长昵称弹层全名（M 报告） |
| V10 | ✅ | FIN-03 token + ui:check 触区/双击检查；css.test 禁 ！important 冲突 |
| V11 | ✅(部分) | 座位增量渲染+滚动锚点（D/M 报告+桌面截图）；500/2000/6000 事件压测专项**未执行**，如实标记 |
| 补充 | ✅ | ui:check --full --strict 全绿（exit 0，P4-4 基线清场修复后）；npm test 601/601 |
| V12 | ✅(抽样) | ui:check 推送降级/终止自愈；断线重连专项未系统压测，如实标记 |
| V13 | ✅ | ui:check 结算/总结/复盘如实标注（Mock 终止不伪装） |
| V14 | ✅(模拟器) | V14-mumu-launcher.png（v2 图标）+ EXE 资源段逐帧一致 + 首页/关于同源标识；**物理真机项待验** |
| V15 | ✅ | version-sync --check 一致 + RT_VERSION 1.5.2 + 包 sha256 记录（packages.md） |
| V16 | ✅(模拟器) | V16-mumu-first-launch/home/after-upgrade.png；覆盖升级数据逐字节保留（profiles/index/saves 对比）；**物理真机项待验** |

## 未执行/待验（如实声明）

- **Android 物理真机**（软键盘实体行为、安全区实体差异、系统返回实体键、锁屏后台）：计划书 §15.3 明确模拟器不可替代——保持「待设备验证」，本期交付为**候选验收包**。
- V11 大历史压测（500/2000/6000 事件）、V12 系统性断线矩阵：专项未执行。
- 偏好的字号/布局前端应用：数据层与白名单就绪，桌面端接入 UI 未做（无假开关）。
- 「最近一次笔记撤销」：服务端 DELETE 路由已补（annotations-delete.test.js），双端 UI 入口未接。

## 第二轮补充（cba485d，2026-09-19/20）

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| V06 偏好应用 | ✅ | 双端「外观与操作」真实开关（字号/布局/减少动态）：即时生效 + PATCH 档案 + 失败回退说明；浏览器实测字号切换→刷新恢复→跨端一致 |
| V05 撤销 | ✅ | 双端笔记抽屉/笔记页「↩ 撤销」：恢复/清除二态 + 409 重载；浏览器+MuMu 设备实测（真实服务端往返） |
| §10-5 返回键 | ✅(模拟器) | Android 硬件返回接前端返回栈（MainActivity→__mwwBack）：离局确认→取消→再次询问→退出到首页；后台/前台恢复 + 继续上局闭环（MU-*.png） |
| V11 | ✅(部分) | 6600+ 条事件注入后页面存活、座位节点跨渲染复用断言通过（expando 保留）；精确锚点自动化测量受工具限制，以 ui:check + 手动验证为准 |
| V12 | ✅(抽样) | 杀服→前端存活、事件/标注零丢失、连接点转橙（轮询降级）；重启→数据仍完整、无幻觉动作；SSE 断线矩阵以 ui:check 推送降级单例 + 源码守卫为准 |

## 构建更新说明
偏好/撤销/返回栈修复属运行时与资产变更，已按 §16-8 在 cba485d 重建 APK 并重装实测；APK 哈希见下轮 packages.md 更新。
