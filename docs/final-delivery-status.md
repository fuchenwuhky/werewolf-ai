# 最终交付施工台账（FIN-00）

> 2026-09-20 复验更新：下文的 bd99743 / 601 项 / AC 全关闭为历史施工记录，**不是当前验收结论**。286e20a 仍存在复现缺口，审核方已直接接手修复，详见 [返修复验与接手记录](acceptance-takeover-2026-09-20.md)。当前修改在本地工作区，未提交/推送；完整三步向导、物理真机、V11/V12 仍未关闭。

计划书：`docs/final-delivery-construction-plan.md` V3.0（基线 74ca56a）
最终构建：**bd99743** · productVersion 1.5.2 · androidVersionCode 9 · 2026-09-19
最终自动化：`npm test` **601/601**；`npm run gate` 全链 EXIT=0；`ui:check --full --strict` EXIT=0；`brand:check` 62/62；`app:verify` 双端全内容比对通过
执行环境：Windows 10.0.26200 / Node 24.14 / Chrome（无头+受控浏览器）/ MuMu 12（Android 12，adb 16384）

## 台账

| 编号 | 状态 | 提交 | 证据 | 剩余风险 |
| --- | --- | --- | --- | --- |
| FIN-00 | 已完成 | 4728f54 起 | 本文件；基线 577→589→601（只增未删）；临时 WW_DATA_DIR 纪律执行 | — |
| FIN-01 | 已完成 | 875e035 | test/static-html-cache.test.js 12 项（C01-C03/C05/C06服务端/C07/C08）；内容寻址 ETag+依赖缓存键 | C04/C06/C07 浏览器侧已由主控实测补证（见 acceptance-results） |
| FIN-02 | 已完成 | 2c12f2b | test/import-rollback.test.js R01-R08 故障矩阵 | 「设备与数据」待清理状态入口在 FIN-04 设置分组落地 |
| FIN-03 | 已完成（D+M） | 8251960/78c1c17 | ui:check --full --strict 全绿；双端触区 token、composing 守卫、防双击保宽、模态焦点锁（Esc/遮罩/归还焦点） | 物理真机触区留待真机项 |
| FIN-04 | 已完成（D+M） | 8251960/78c1c17 | 截图 V01（桌面首页狼冠+档案+继续上局）、V08（手机品牌首页+四主入口）；设置四分组；结算分层 | 字号/布局偏好前端应用未接（不做假开关） |
| FIN-05 | 已完成（D） | 8251960 | 截图 V07（三栏+右栏笔记+圆桌/列表切换）；1100px 抽屉降级实测 | 240px 栏内圆桌目标区由列表视图承担（代码注释说明） |
| FIN-06 | 已完成（M） | 78c1c17 | 局内三页签（发言全宽/玩家网格/笔记列表）+返回栈 popstate 状态机+安全区/100dvh/键盘补偿；截图 V08-mobile-game-players | 实体键盘/安全区/实体返回键属真机项 |
| FIN-07 | 已完成（Q） | 17dcea3 | fin07-contracts.test.js +11；十二行核验结论（本文件下文）；撤销路由 DELETE annotations 补齐 | 「最近一次笔记撤销」双端 UI 入口未接（服务端原语已备） |
| FIN-08 | 已完成 | cf024ab 前批 | brand:check 62 项：web/assets/brand/wolf-emblem.svg（母版直拷 svg-master）+ <img> 引用面核对；双端页面引用截图 | — |
| FIN-09 | 已完成（R） | 8251960 前批 | app:verify：EXE 图标 7 帧逐帧一致+RT_VERSION 1.5.2；APK 26 品牌资源字节一致；包内 108 文件全内容比对（0 个只查存在） | 资源管理器/任务栏视觉属真机项 |
| FIN-10 | 已完成（D+M） | 8251960/78c1c17 | 座位以 seat 为 key 增量 patch（消除全清重建）；直播骨架化；滚动锚点+N条新发言；修复 smooth-scroll 跟随脱钩 | 500/2000/6000 事件压测专项未执行 |
| FIN-11 | 已完成 | 62e4fb3 | release-version.json 单一来源+version-sync --check 全绿+构建脚本直读 | 对外发布号 1.5.2 待用户确认 |
| FIN-12 | 部分完成（如实） | bd99743 | acceptance-results.md C/R/V 逐条（未执行项如实标注）；ui:check --full --strict exit 0；MuMu 安装/覆盖升级/数据逐字节保留/启动/launcher 图标 | **Android 物理真机（键盘/安全区/实体返回/锁屏后台）与 V11 压测、V12 断线矩阵待验证**——按计划书 §15.3 模拟器不可替代，本期为候选验收包 |
| FIN-13 | 已完成 | fe746b5/319300b | artifacts/acceptance/1.5.2-bd99743/{acceptance-results.md,packages.md,screenshots/*}；三制品在最终提交重建并重验 | 后续任何运行时/资产变更需重建重验 |

## FIN-07 核验结论（计划书 §11 十二行）

见 git 历史 17dcea3 版本的本文件下文完整表格。摘要：9/12 行「已满足+证据」（6 行补服务端回归）；3 行（草稿断网、偏好前端应用、旧 SSE 释放）部分契约留浏览器侧，已在集成轮抽样；发现 2 个能力缺口——「座位笔记删除路由」（已补 DELETE /annotations?seat=N + clearSeat 队列化 + 测试）与「最近一次笔记撤销」（服务端原语已备，双端 UI 入口未接）。

## 纪律

- 每个工作包一组可独立审查的提交；缓存修复 / UI 格式化 / 版本升级不混提交。
- 测试只增不删；改旧断言必须说明契约变化理由。
- 施工期间不发布、不动 `release/` 历史制品；最终制品在 bd99743 重建重验。


## 第一轮返修单回填（2026-09-20，docs/acceptance-review-2026-09-20.md）

| 编号 | 状态 | 修复/证据 |
| --- | --- | --- |
| AC-01 | ✅ 已修复 | PUT 走入队 put() 与 DELETE 同队列；annotations-concurrency.test.js 4 用例（2 项旧实现下失败）；IO 故障 5xx 语义 |
| AC-02 | ✅ 已修复+设备复验 | setGameTab 统一面板显隐；device flow 断言「面板可见且非零尺寸」通过 |
| AC-03 | ✅ 已修复+设备复验 | /api/games 行状态机；磁盘局走 /resume 换发令牌；无句柄按服务端找回；force-stop 重启后恢复卡出现并可继续（MU-resumed-after-restart.png） |
| AC-04 | ✅ 已修复 | view 下发 owner 快照；双端句柄固化归属；恢复前三选确认框；顶栏显示本局 owner。浏览器级完整交互复验受工具稳定性限制（弹窗原语已单独验证） |
| AC-05 | ✅ 已修复 | verifyDesktop payload 内容核对 108 文件 + app.asar main.js 校验 + 发布失败模式（--release）；三包在最终提交重建（packages.md 哈希已更新） |
| AC-06 | ✅ 已修复 | openModal 初始焦点 + #app inert（MutationObserver 兜底）+ Esc 走最上层弹窗自己的关闭键（dirty 守卫生效） |
| AC-07 | ✅ 已修复 | 自称下拉改全板子角色池（可记录对跳），候选池语义不变（双端） |
| AC-08 | ✅ 已修复 | HTTP 成功响应透传 pendingRecoveries；GET /api/import/recoveries + retry；桌面设备卡+手机设置可见入口 |
| AC-09 | ✅ 已修复 | 看门狗 8s→40s（心跳 16s 的 2 倍+余量），检查周期 8s |
| AC-10 | ✅ 已修复 | .m-keys .key[data-confirm] 特异性修复（52px 实测生效）；桌面默认座位视图=列表（圆桌为切换模式） |
| AC-11 | ✅ 部分 | 桌面设置长表单默认收起+开局最终确认弹窗+无 Key 一键 Mock；手机模式卡+按档案对局列表。三步向导完整形态仍待下轮打磨 |
| AC-12 | ✅ 已修复 | device-e2e 通过/失败/未执行三分记账（失败 exit 1、必测未执行 exit 2）；页签断言面板可见尺寸；撤销按钮可见才点；键盘无输入框记 SKIP |
| §4 视觉 | ✅ 部分 | 模式卡、板子卡角标胶囊、桌面列表默认、emoji 清除；「真实对局」按钮改模式卡的形态重构已做，圆桌在窄栏的拥挤保留（列表为默认） |

诚实声明：AC-04 浏览器级完整交互复验与 Android 物理真机项仍未完成；V11 精确锚点测量、V12 全矩阵保持原状。
