# 🐺 AI 狼人杀（本地网页版 + 手机 APP 端）

1 名人类玩家 + N 名 AI 的狼人杀。轮流发言、记忆严格隔离、随机发身份牌，默认适配**网易《狼人杀-官方正版》12 人守卫局（进阶场）**，所有规则细则可开关、板子可自定义。只需一个 **OpenAI 兼容 API Key**。哥特暗黑风界面。

> 规则依据与官方出处见 [docs/rules.md](docs/rules.md)（开发对照规则书）；角色图鉴见 [docs/roles.md](docs/roles.md)；
> 角色卡生图提示词见 [docs/image-prompts.md](docs/image-prompts.md)（把 AI 生成的图放入 `web/assets/roles/` 即自动生效）。

## 快速开始

```bash
node server.js        # 或 npm start（要求 Node ≥ 18，零 npm 依赖）
```

启动后自动打开 `http://localhost:3210`（可用 `PORT=xxxx` 换端口，`NO_OPEN=1` 关闭自动打开）。

- **桌面版**：完整设置页（API 配置/板子/规则开关/玩家昵称）+ 上帝调试面板 + 日志查看器
- **📱 APP 端（手机）**：手机浏览器访问自动跳转 `/m/`（也可手动打开），三步开局：**选板子 → 确认规则 → 开始**；左下角 ⚙ 配置 AI。已打包为安卓 APP（离线内嵌 Node 服务端，见下方「安卓 APP」）

1. **① API 配置**：填 OpenAI 兼容的 `base_url` / `model` / `API Key`（DeepSeek、Kimi、智谱、通义、OpenAI 等均可），点「测试连接」→「保存配置」。配置存在本机 `config.json`。
2. **② 板子**：默认 12 人进阶场（狼王+3狼+预女猎守+4民），可换模板或完全自定义各身份数量。
3. **③ 规则开关**：警长竞选、吞警徽模式（单爆/双爆）、女巫自救、同守同救、守卫连守、空刀、自爆、遗言、夜晚顺序……全部可调，默认即网易官方守卫局。
4. **④ 玩家**：选你的座位和昵称（或勾「纯观战」看 AI 互杀；勾「Mock 试玩」可在无 Key 时用脚本 AI 验证流程）。
5. 开始游戏 → 翻看身份牌 → 轮到你时打字发送（**无时间限制**），投票/夜晚行动点选目标即可。

## 特性

- **记忆隔离**：全局事件日志 + 可见性标签（公开/指定座位/上帝），AI 只能看到"它该看到的"；人类前端同样被服务端裁剪。引擎测试含隔离审计断言。
- **缓存省钱**：每个 AI 的上下文是**追加式消息数组**（system 整局不变、动态内容只在最后一条），稳定前缀命中服务商前缀缓存；上帝面板展示**缓存命中率**与 token 消耗。可选显式 `cache_control` 标记。
- **秘密投票**：按座位顺序收集，但每张票只对投票者本人（和上帝）可见，收齐后统一亮票。
- **规则开关系统**：14 组开关集中在 `src/engine/rules.js`，设置页自动生成控件，游戏内「规则书」按本局实际开关渲染。
- **开发者日志**：控制台 + `logs/` JSONL（全局 server.log + 按局 game-*.log）；启动与开局打印**生效配置快照**；每次 LLM 调用记录 token/缓存/延迟/重试，报错带堆栈；上帝面板内嵌日志查看器（级别/模块过滤、错误堆栈展开）与 **AI 上下文调试器**（直接查看某个 AI 收到的完整提示词）。
- **上帝/观战模式**：纯 AI 局或随时切换上帝视角，可见全部事件、原始提示词、遥测统计。
- **容错**：LLM 调用自动重试，输出解析失败带提示重试，多次失败降级（随机票/空过）并在上帝面板标注，对局永不卡死；对局自动存档 `saves/`。

## 角色（15 种，均按官方技能原文）

🐺 狼人 ｜ 👑 狼王 ｜ ⚡ 白狼王 ｜ 🌫️ 隐狼 ｜ 💃 狼美人 ｜ 🔮 预言家 ｜ ⚗️ 女巫 ｜ 🎯 猎人 ｜ 🛡️ 守卫 ｜ 🃏 白痴 ｜ ⚔️ 骑士 ｜ 🌙 摄梦人 ｜ 🐦 乌鸦 ｜ 💗 暗恋者 ｜ 🌾 平民

新身份只需在 `src/engine/roles.js` 注册能力字段（`nightStep` / `deathTrigger` / `selfExplode` 等），流程编排自动适配——未来魔术师、熊等照此扩展。

## 板子（10 个内置，均对照网易官方）

12 人进阶场（守卫局·默认）、12 人守卫局纯狼版、12 人标准场白痴版、10 人速推局、12 人白狼王骑士场、12 人白狼王守卫场、12 人狼王摄梦人场、12 人狼美人骑士场（板规：女巫不可自救）、12 人乌鸦隐狼场、12 人暗恋者场——板子支持携带内置板规（选中即预填、可手调），另有完全自定义板子。

## 项目结构

```
werewolf-ai/
├─ server.js               # HTTP 服务 + 静态文件 + 配置（零依赖）
├─ src/
│  ├─ engine/              # 纯逻辑引擎（可被未来安卓版复用）
│  │  ├─ roles.js          #   身份牌唯一数据源（驱动 AI 提示词/UI/文档）
│  │  ├─ rules.js          #   规则开关系统
│  │  ├─ game.js           #   对局状态、事件日志、可见性隔离
│  │  ├─ flow.js           #   流程状态机（夜/警长竞选/白天/投票/结算）
│  │  └─ render.js         #   事件渲染（AI 上下文与前端共用）
│  ├─ ai/
│  │  ├─ llm.js            #   OpenAI 兼容客户端（重试/遥测/缓存）
│  │  ├─ agent.js          #   分层上下文智能体（反思纪要 + 实录 + 快照）
│  │  ├─ context.js        #   上下文组装 v2（预算裁剪/任务分层思考/防幻觉快照）
│  │  └─ prompts.js        #   提示词模板
│  ├─ api.js               # REST 接口
│  └─ log.js               # 日志系统
├─ web/                    # 前端（原生 HTML/CSS/JS，移动自适应）
│  └─ m/                   # 手机端 UI（圆桌座位 + 发言舞台 + 底部操作栏）
├─ test/engine.test.js     # 引擎单元测试（npm test）
├─ scripts/
│  ├─ simulate.js          # mock 批量模拟（npm run simulate -- --n=100）
│  ├─ e2e.js               # 端到端验证（起真实服务打完整局）
│  ├─ mock-agent.js        # 脚本化测试智能体
│  ├─ play.js              # 代玩助手（人类接管座位，调试用）
│  ├─ build-app.js         # 同步服务端到 Capacitor webDir（app/www/nodejs）
│  ├─ gen-icon.js          # 生成应用图标
│  ├─ update-app.sh        # 一键 APK：同步 → cap sync → 构建 → adb 安装
│  └─ gen-roles-doc.js     # 生成 docs/roles.md
├─ app/                    # Capacitor 安卓工程（webDir=app/www）
├─ docs/rules.md           # 规则书（含官方出处）
├─ logs/  saves/           # 日志与对局存档（git 忽略）
└─ config.json             # API 配置（含密钥，git 忽略；模板见 config.example.json）
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 启动服务（默认 :3210） |
| `npm test` | 引擎单元测试（隔离审计/规则矩阵/胜负/投票保密） |
| `npm run simulate` | mock 智能体批量模拟，验证闭环与隔离 |
| `node scripts/e2e.js` | 端到端：真实 HTTP 服务 + 人类玩家 REST 打完整局 |
| `npm run gen-docs` | 从 roles.js 重新生成 docs/roles.md |
| `npm run app:sync` | 把服务端+前端打进 Capacitor 工程 |
| `npm run app:apk` | 一键出 APK 并尝试 adb 安装（需 JDK21 + Android SDK） |

## 安卓 APP

已落地：**Capacitor 8 + [capacitor-nodejs](https://github.com/hampoelz/capacitor-nodejs)** 在手机本地内嵌 Node 运行时，同一套服务端随 APP 离线运行，WebView 指向 `127.0.0.1:3210`——安装即用，只需首次填 API Key。

打包流程（Windows，需 JDK21 与 Android SDK，路径见 `app/android/local.properties`——该文件不入库，clone 后自建）：

```bash
npm run app:sync      # 同步服务端/前端进工程
cd app/android && ./gradlew assembleDebug
# 产物：app/android/app/build/outputs/apk/debug/app-debug.apk
```

或直接 `npm run app:apk`（同步 → 构建 → `adb install -r` 四连）。
