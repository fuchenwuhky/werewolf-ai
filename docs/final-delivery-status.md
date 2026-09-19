# 最终交付施工台账（FIN-00）

施工基线：`74ca56a`（与计划书一致）
计划书：`docs/final-delivery-construction-plan.md` V3.0
基线自动化：`npm test` 577/577 通过（2026-09-19 实测，9.0s）
执行环境：Windows / Node 24 / Git Bash；测试均以临时 `WW_DATA_DIR` 启动。

## 台账

| 编号 | 状态 | 提交 | 证据 | 剩余风险 |
| --- | --- | --- | --- | --- |
| FIN-00 | 已完成 | 6921c0c+本提交 | 本文件；基线 577/577→589/589（FIN-01/02 带入新用例） | — |
| FIN-01 | 服务端已完成（875e035） | 875e035 | test/static-html-cache.test.js 12 项（C01-C03/C05 服务端侧全过）；内容寻址 ETag+依赖缓存键 | C04/C06/C07 浏览器侧待 FIN-12 ui:check 严格模式补证 |
| FIN-02 | 已完成（2c12f2b） | 2c12f2b | test/import-rollback.test.js（R01-R08 故障矩阵）；589/589 | 「设备与数据」查看待清理状态入口归 FIN-04 设置分组 |
| FIN-03 | 待施工 | — | — | — |
| FIN-04 | 待施工 | — | — | — |
| FIN-05 | 待施工 | — | — | — |
| FIN-06 | 待施工 | — | — | — |
| FIN-07 | 核验完成（本提交） | — | 下文「FIN-07 核验结论」：9/12 行已满足（6 行补服务端回归测试），3 行部分契约留浏览器验收；600/600 | 旧 SSE 释放、草稿、偏好应用效果等待主控浏览器 |
| FIN-08 | 资产地基完成，页面接入进行中 | 6921c0c | web/assets/brand/wolf-emblem.svg（母版直拷）+ svg-master 校验链；映射条目待页面引用落地后加入 | 页面引用未落地前 brand:check 暂不含该资产 |
| FIN-09 | 待施工 | — | — | 无真机时 Android 项保留待验证 |
| FIN-10 | 待施工 | — | — | — |
| FIN-11 | 已完成（62e4fb3） | 62e4fb3 | release-version.json 单一来源 + scripts/version-sync.js --check 全绿 | 对外版本号仍为 1.5.2，发布号需用户确认 |
| FIN-12 | 自动化严格化完成（本提交）；集成验收待做 | — | ui-check --strict（退出码 0/1/2 + 未执行清单，自测三态）；R07a/R07b 补全；C/R 缺口清单见下文 | C04/C06/C07 浏览器侧、V01-V16、真机待主控执行 |
| FIN-13 | 待施工 | — | — | — |

## 纪律

- 每个工作包一组可独立审查的提交；缓存修复 / UI 格式化 / 版本升级不混提交。
- 测试只增不删；改旧断言必须说明契约变化理由。
- 施工期间不发布、不动 `release/` 历史制品。

## FIN-07 核验结论（2026-09-19，计划书 §11 十二行核验面）

核验方法：先读实现找证据，再对每个能在 Node/HTTP 层落地的契约补回归测试（`test/fin07-contracts.test.js` 9 用例 + `test/import-rollback.test.js` R07a/R07b）。基线 589/589 → 600/600 全绿。纯前端行为一律登记「待主控浏览器验收」，不硬测。

| # | 核验面 | 结论 |
| --- | --- | --- |
| 1 | 当前档案与 owner | **已满足＋证据**：归属创建时锁定——`src/api.js:839-856`（createGame 等迁移就绪后解析并校验 profileId，归档档案拒绝建局）；存盘写 entry 固化 owner（`src/api.js:262-277`）；断点/暂停恢复随档回填（`src/api.js:428-430`、`461-463`）；经验池按 owner 分池（`src/api.js:168-176`）。服务端无「全局当前档案」状态（每客户端独立选择成立）。已补测试：`fin07-contracts` R1（先后两档案建局互不串归属＋标注落 owner 目录＋非法 profileId 400）。注：已实现内无 profiles.touch 的 HTTP 路由，「切档刷新 lastUsedAt」暂无服务端语义可测 |
| 2 | 进行中切档 | **服务端半已满足＋证据**：删除档案前统计 activeGames（`src/api.js:1556-1571`），store 层 `activeGames>0` 直接拒绝（`src/profiles/store.js:230-233`）。已补测试：R2（有进行中局的已归档档案 DELETE 400「仍有 N 局进行中」，结算后放行，被拒后档案原样）。**待浏览器验收**：「安全暂停并确认落盘后才切、不静默终止/隐性付费」的 UI 切档流程 |
| 3 | 多窗口与迟到响应 | **已满足＋证据**：expectedRevision 乐观并发——标注 `src/annotations/store.js:115-119`、档案 `src/profiles/store.js:189-191`，冲突 409。已有测试：`profiles-api.test.js`（PATCH/PUT 过期 409）、`annotations.test.js` 并发用例（审核 P2-6）。已补测试：R3（409 后服务端原文与 revision 原样——「放弃修改」路径零部分覆盖；档案侧同语义）。**待浏览器验收**：切换后旧响应不可写入当前 UI、旧 SSE 释放 |
| 4 | 偏好 | **服务端半已满足＋证据**：白名单三键 fontScale(≤3)/layout(reading/compact)/reducedMotion(布尔)，非法回落、未知字段丢弃（`src/profiles/store.js:154-168`、`195-202`）。已有测试：`profiles-api.test.js` 往返偏好继承。已补测试：R4（fontScale 99→钳 3、非法 layout/reducedMotion 保留原值；apiKey/baseUrl/theme 绝不进档案与接口回显——安装级 Key 不随档案变化的服务端半）。**待浏览器验收**：fontScale/layout/reducedMotion 在双端的实际应用效果、失败回退说明 |
| 5 | 战绩与列表 | **已满足＋证据**：四桶判定 `src/api.js:1740-1757`（mock/观战/终止/正式），胜负平互斥与 crush 动态阵营还原（`src/api.js:1755-1774`，A12）。已有测试：`profiles-api.test.js` 平局互斥（审核 P2-4）、按 owner 过滤。已补测试：R5（正式/Mock/观战/终止四桶互斥计数＋暗恋者绑狼/绑民分别记胜/负） |
| 6 | 导入导出 20MiB | **已满足＋证据**：`src/profiles/transfer.js:16`（MAX_BYTES=20MiB 唯一常量）；导入与预览同一上限（`src/api.js:724`、`733`）；导出超限 413（`src/api.js:1823-1825`）；超限拒绝不截断。已有测试：往返/半坏包/零残留（profiles-api）。已补测试：`import-rollback.test.js` R07b（>20MiB 导入与预览均 413、零落盘、常量契约断言） |
| 7 | 三层身份信息 | **已满足＋证据**：存储层白名单清洗（`src/annotations/store.js:31-46`）；静态审计已有（`annotations.test.js:90-97`：engine/flow/agent/prompts 无引用）。已补测试：R7（审计扩展到 src/engine+src/ai 全部 ≥20 个模块，零 references）。「不进公开 SSE/判定」由 `visibility.test.js` 事件层 fail-closed 覆盖。浏览器渲染分层留 UI 验收 |
| 8 | 候选与自称 | **重点核验结论：已满足，服务端本就无「排除自己占用唯一身份」的限制，已补测试固化**。`normalizeSeatAnnotation` 对 claimedRoleId 只做格式白名单（`src/annotations/store.js:38`），候选 ≤3 去重截断（`:35-37`，MAX_CANDIDATES=3）——「候选池扣除自己身份」是前端 `possibleRolesFor`（`web/app.js:1189-1203`，纯展示逻辑）的职责，服务端绝不猜隐藏身份，因此「自己是唯一 seer 仍可记录他人自称 seer」在存储层天然成立。已补测试：R8（normalize 直测＋HTTP PUT 保存他座自称 seer 并读回＋4 候选去重截 3＋常量断言）。**待浏览器验收**：候选下拉在唯一身份场景确实仍提供该选项 |
| 9 | 待确认旧标记 | **已满足＋证据**：mergeLegacyTags 六用例（`annotations-model.test.js`：满字段 pending 零截断、冲突合并、幂等）；409 API 侧已有（profiles-api put2）。已补测试：R3（409 后「取消/放弃」不部分覆盖——补齐「编辑、保存、取消、409」闭环的服务端侧最后一段；「仅清理已确认解决的座位」的刷新复验属前端，待浏览器） |
| 10 | 草稿与断网 | **待浏览器验收（无服务端契约）**：草稿归原上下文（profile/game/视角/版本绑定）与「未确认不显示已保存」均为前端状态管理；服务端唯一相关契约是「未获确认不得显示已保存」的 409 语义，已被 R3 覆盖。登记 UI 智能体后浏览器验收 |
| 11 | 编辑完成与撤销（笔记不触发行动） | **已满足＋证据**：标注路由与行动路由完全分离（`src/api.js:805-807` vs `:794`）。已补测试：R11（PUT 保存/清除前后 game.seq/day/phase/pending/events 与 view 事件数全部不变；action 仍 409——笔记写没留下伪行动）。已知边界如实登记：座位标注键删除只有 store 层 `clearSeat`（无 HTTP 路由），前端「清除」语义=覆写默认值，是否符合「显式清除需确认」由浏览器验收判断。**「最近一次笔记撤销」未发现服务端实现 → 需补实现（前端撤销能力，归 UI 工作包，不在本轮服务端测试范围）** |
| 12 | 视角切换 | **已满足＋证据**：token→视角即时构造（`src/api.js:1077-1154` buildView 纯函数，按请求视角裁剪）。已有测试：`visibility.test.js`（私密事件不泄漏给他人/上帝事件不出现在普通视角）。已补测试：R12（玩家视图无 llmStats/scheduler、未翻牌只见自己身份、me.role 下发；上帝视图全量；玩家→上帝→玩家往返逐字段一致零残留；伪造 token 403）。**待浏览器验收**：不把真相自动写入个人猜测（前端行为） |

## FIN-12 自动化严格化（2026-09-19）

**ui:check 严格模式**（`scripts/ui-check.js`，`node --check` 通过）：

- `--strict`：浏览器缺失 → 退出 2 并列出全部未执行规划段落；浏览器启动失败（含 spawn ENOENT，已修复无人监听 error 事件直接炸进程的问题）→ 退出 1＋未执行清单；中途异常打断后续段落 → 按未执行清单如实列出；全部执行且无失败 → 0。宽松模式（默认）行为不变：缺浏览器仍跳过退出 0，不破坏现有调用。`WW_CHROME=none` 可强制「无浏览器」自测两模式。
- 自测输出（本机实测）：宽松缺浏览器 `exit=0`；严格缺浏览器 `exit=2`＋13 条「未执行」清单；严格启动失败 `exit=1`＋「浏览器启动失败：spawn … ENOENT」＋未执行清单。
- 退出码语义已写入文件头注释：0=全过；1=实际执行且有失败；2=存在未执行项（不得按通过计数，对应计划书 §15.1）。

**C01–C08（计划书 §5.3）覆盖评估**（`test/static-html-cache.test.js`）：

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| C01 | ✅ Node 层已覆盖 | 旧 stat-ETag → 200＋版本化引用＋v2 内容寻址 ETag |
| C02 | ✅ Node 层已覆盖 | 同内容 ETag 跨进程稳定，条件请求 304 |
| C03 | ✅ Node 层已覆盖 | 改单 JS：URL 哈希前进、HTML ETag 前进、旧 ETag 200（同进程＋重置缓存） |
| C04 | ⏳ 待主控浏览器执行 | 服务端半程由 C01/C06 承担；「旧 Worker 接管页面首次导航即执行新迁移、不需二次刷新」必须真浏览器 |
| C05 | ✅ Node 层已覆盖 | /m/ 相对与父级引用、哈希可复算 |
| C06 | ⏳ 浏览器侧待主控执行 | 服务端半程已测（旧缓存头组合导航 → 最新表示）；断网回退不白屏需真浏览器（ui:check 有离线横幅检查，断网打开需严格模式实跑） |
| C07 | ⏳ 浏览器侧待主控执行 | 表示稳定＋引用文件真实存在已测；「新装/跨版本升级/两旧窗口」交互行为需真浏览器 |
| C08 | ✅ Node 层半程＋待集成 | 非脚本资源长缓存＋版本化范围如实已测；品牌资产真实页面引用与包校验归 FIN-08 页面接入后集成验收 |

**R01–R08（计划书 §6.3）覆盖评估**：

| 编号 | 状态 | 证据 |
| --- | --- | --- |
| R01 | ✅ | profiles-api「导入时笔记写盘故障」：500、rolledBack:true、零残留 |
| R02 | ✅ | profiles-api「回滚未完成」：rolledBack:false、cleanupPending:true、恢复记录落盘、真实残留对照 |
| R03 | ✅ | import-rollback R03：三重故障叠加，recoveryPersisted:false、残留相对清单、profileId、人工恢复文案 |
| R04 | ✅ | profiles-api「rename 失败」：tmp 进回滚清单、清理成功才报 rolledBack:true |
| R05 | ✅ | import-rollback R05：重试消化记录、二次重试零副作用、残留真实清理 |
| R06 | ✅ | R06a 损坏记录保留上报 / R06b 目标已不存在幂等消化 / R06c 越界拒绝删除；「访问被拒」语义由 R06c 拒绝路径＋R03 的 EPERM 注入同型覆盖（Windows 下可移植注入 EPERM-read 需特权，如实说明不硬造） |
| R07 | ✅（本轮补全） | 原有「半坏包 players 类型」；新增 R07a 未来主版本/缺 manifest/notes 类型错误/seats 数组/条目非对象/未结束局 → 写盘前 400 零残留；新增 R07b 超限包 413 |
| R08 | ✅ | profiles-api 真实 HTTP 导入→重导出往返 ×2（笔记/偏好/事件流/脱敏/anchor 事件回落） |

**遗留（不在本轮服务端/Node 层范围）**：C04/C06/C07 浏览器侧与 C08 集成、V01–V16 界面专项、§15.3 设备矩阵（含 Android 真机）、缓存升级/原子写/导入专项「连续三轮通过」记录——归 FIN-12 集成验收，由主控浏览器与真机执行。
