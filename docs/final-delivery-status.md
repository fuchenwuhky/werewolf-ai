# 最终交付施工台账（FIN-00）

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
