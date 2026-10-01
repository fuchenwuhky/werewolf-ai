# 2026-10-01 当前交付记录

范围：当前 `1.5.2` / Android versionCode `9` 工作区快照。面向本机多玩家档案，不新增云账号、密码或存档格式。手机继续是主要使用与后续优化对象，本轮补齐 Windows 桌面包及仓库交付。

## 本次整理与交付范围

1. 双端哥特界面精修：大厅、玩家中心、四分类设置、四步开局、对局分栏/抽屉、图鉴与 AI 名册；复用 V3 卡框与已批准角色美术。
2. 交互动效：短时页面/弹层过渡、统一按钮反馈、减少动态效果、保存忙碌态与迟到响应保护。手机座位选择与参与页布局收紧。
3. 身份揭示与检视：翻开完成前不显示技能、阵营、狼队或检视入口；关闭大卡检视返回原资料层，保留滚动位置与焦点。
4. AI 时间线与速度：提示词约束当前阶段、发言顺序与已发生证据；默认低思考，每日记忆整理仅处理存活的既有 AI 智能体。
5. AI 等待上限：公开发言 60 秒、其他决策 30 秒；排队、准备、响应体、协议与内容修复共用绝对截止时间。一次决策最多三个实际网络请求，迟到结果不得覆盖降级结果或写入记忆。
6. 实时反馈：排队、思考、重试状态与本地秒表；没有新推送帧时秒表仍刷新。兼容网关 JSON 成功响应，复用已付费答案，不为解析流式协议再次外呼。
7. 仓库整理：补齐共用模块、专项回归、生产背景资产及设计参考；重写 README，新增文档索引，为历史报告加日期边界。设计素材索引改用仓库相对路径。
8. 人工探针：`probe-current-effort.js` 保留为诊断工具，新增 `--live` 显式授权开关；默认不读取配置、不请求模型。不属于门禁或正常开局步骤。

没有为“整理代码”全局格式化、换框架或批量重命名业务模块，也没有删除个人档案、存档、历史报告或旧安装包。已有卡框与原生导出的两个本地提交将随本次正常推送一并同步。

## 本机构建产物

以下路径相对仓库根目录，文件均保存在本机 `release/`，不提交 Git，也未另行上传 GitHub Release。

| 制品 | 文件 | 大小 | 签名与用途 |
| --- | --- | --- | --- |
| Windows x64 桌面应用 | `release/werewolf-ai-1.5.2-win-x64-portable.exe` | 127,020,660 字节，约 121.1 MiB | Electron 免安装单文件；无 Authenticode 发布者签名 |
| Android APP | `release/werewolf-ai-1.5.2-debug.apk` | 187,818,696 字节，约 179.1 MiB | debug 签名，测试交付；本轮沿用当日已重建包并重新核对 |

SHA-256：

```text
E6EAB6328B54CAD68571E7D3DBA230340B5414BEBE65325F7F23D146B1E52681  werewolf-ai-1.5.2-win-x64-portable.exe
D93848897F994EFDD2217B062FAF16161E603892BD37BB1C2F049BE98B8B7659  werewolf-ai-1.5.2-debug.apk
```

Windows 包于 2026-10-01 20:59 重建，Android 包于当日 20:31 重建。旧 Windows 和 APK 均有本地备份。同名旧包不能仅靠版本号区分，核对本表哈希。

Windows 数据落在 `%APPDATA%\werewolf-ai-desktop`；APK 使用 Android 应用私有目录。包不包含开发者本机 `config.json`、玩家档案、存档或日志。已有安装的数据不会因为重新生成 EXE 文件自动迁到另一设备。

旧式 `werewolf-ai-1.5.2-win-x64.zip` 本轮没有重建，不能视为本次交付。最新版电脑端请使用上表的 Electron EXE。

## 本轮验证结果

- `npm run gate`：退出码 0。全量 1209 项测试通过、0 失败；临时残留专项重新运行同样 1209/1209，沙箱顶层新增 0 项。
- lint：284 个 JS 文件通过。ESLint：0 error，保留 7 条已有原生验收/对比脚本的未使用变量 warning，未隐藏或降级门禁。
- 覆盖率：全局行 95.52%、分支 87.12%、函数 90.69%；`api.js` 行 95.61%、分支 87.58%，五项门禁通过。
- Mock eval：base / nosheriff / noexplode 各 30 局，共 90 局；隔离审计通过，不调用真实模型。
- 品牌、版本、CSP/断言守卫和真实 HTTP e2e 全部通过。
- 实际 APK：151 个服务端/前端文本及二进制载荷文件全内容一致；26 项品牌资源字节一致。
- 实际 Windows EXE：从 NSIS 包解出载荷，再比对服务器目录及 `app.asar/main.js`，152 个文件全内容一致；图标资源七帧与品牌母版一致，EXE 版本资源含 `1.5.2`。
- 提交前执行 `git diff --check` 与密钥/私人路径/大文件扫描；不会把 `config.json`、档案库、原始用户反馈图或构建目录加入提交。

首轮门禁曾因整理时把诊断源码加入忽略规则，触发 lint 防漏扫测试而失败。已移除该排除，保留全部源码扫描，并对探针加显式真实请求开关；随后全套门禁重新通过。没有删除或放宽该测试。

此前浏览器精修和动效证据见 [9 月 30 日布局记录](dual-ui-refinement-delivery-2026-09-30.md)与 [动效记录](ui-motion-refinement-2026-09-30.md)。10 月 1 日身份揭示、检视、等待计时等专项脚本也随源码交付；原始截图在本机 `output/playwright/`。本轮打包核验不冒充重新完成全部浏览器/设备验收。

## 重建与两包核验

```bash
npm ci
npm run gate
npm run app:desktop
# Android 构建需要 JDK 21 与 Android SDK
npm run app:apk
```

仅核验本次必交的 APK 与 Electron EXE，不检查历史浏览器 ZIP：

```bash
node -e "const p=require('./scripts/verify-packages'); for(const [name,file,check] of [['APK','release/werewolf-ai-1.5.2-debug.apk',p.verifyApk],['DESKTOP','release/werewolf-ai-1.5.2-win-x64-portable.exe',p.verifyDesktop]]) {const r=check(file); console.log(name,r.checked,r.problems); if(r.problems.length) process.exitCode=1;}"
```

文件缺失、工具缺失或包内容不一致均应失败，不能以跳过代替发布验证。`npm run app:verify -- --release` 的原契约仍要求三类包，本轮没有修改它来规避旧 WIN 制品检查。

## 已知限制与下一步

- 本轮没有对新 EXE 重新执行完整原生窗口交互往返，也没有进行 Android 物理真机安装；包内一致不等于设备交互都通过。
- 物理真机的软键盘、安全区、实体返回键、锁屏后台恢复，以及完整断线矩阵和长事件流压测仍需专门验收。
- APK 是 debug 包，Windows EXE 未做发布者签名；正式公开发行前需要独立的签名、版本与设备验收流程。
- UI 的普通浏览器验证不能保证 AI 每次发言都正确；提示词与预算回归降低了错误风险，真实模型仍需持续小样本对局复核。
- 后续优先顺序：手机账号/头像及 UI 实机体验 → 恢复与稳定性 → 新玩法。保持本地多档案定位，不在这次发布整理中扩展云账号或联机系统。
