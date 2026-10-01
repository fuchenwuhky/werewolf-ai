# AI 狼人杀 · 月夜议会

1 名人类玩家与多名 AI 的本地狼人杀，也支持纯 AI 观战和无需密钥的 Mock 试玩。原生 HTML/CSS/JavaScript 前端，哥特暗黑主题；同一套 Node 服务运行在浏览器、Windows 桌面应用和 Android APP 内。

账号采用**本机多玩家档案**，不是云账号：无需密码，不做云同步。支持玩家自定义头像、私人笔记、对局归属、战绩与档案导入导出。

当前版本：`1.5.2`，Android versionCode：`9`。本次为同版本的 2026-10-01 更新构建，不代表此前同名安装包内容相同。交付状态、验证范围和制品摘要见 [本次交付记录](docs/current-delivery-2026-10-01.md)；文档入口见 [文档索引](docs/README.md)。

## 快速开始

需要 Node.js ≥18.18。服务端没有 npm 运行时依赖，直接启动即可；执行开发检查前需安装开发依赖。

```bash
node server.js
# 或 npm start
```

默认自动打开电脑端 `http://localhost:3210/`；手机端为 `http://localhost:3210/m/`。`PORT` 可修改端口，`NO_OPEN=1` 可关闭自动打开。

1. 在玩家中心选择或创建本机档案；可上传、裁切和移除自定义头像。
2. 进入“设置 → 模型与连接”，填写 OpenAI Chat Completions 兼容接口地址、模型和完整 API Key，保存并测试连接。配置保存到本机 `config.json`，不入 Git、不随档案导出。
3. 从大厅“开始新局”进入四步流程：**模式准备 → 板子与规则 → 参与与座位 → 确认开局**。后退保留草稿，最终确认前不创建对局；无 Key 时可选 Mock 试玩。
4. 点击身份牌翻开后查看技能与私密信息。轮到自己时输入发言，投票或夜间行动通过目标选择与确认完成。

真实模型调用需要联网，可能消耗服务商额度。仅安装 APP 不会自动填入开发者的 API Key；手机与电脑的本机设置相互独立。测试连接出现 401 时，应检查完整密钥、接口地址和模型权限，不能仅凭输入框显示“已保存”判断可用。

## 主要功能与边界

- **身份与记忆隔离**：服务端裁剪公开、指定座位和上帝信息；普通玩家与 AI 只能看到各自有权限的信息。身份牌翻开完成前不显示技能、阵营或狼队。
- **板子与规则**：15 种角色、10 个内置板子及自定义组成；警长、女巫、守卫、夜间顺序、自爆和遗言等规则由引擎统一定义。依据与差异见 [规则书](docs/rules.md)和 [角色图鉴](docs/roles.md)。
- **AI 上下文**：反思纪要、可见事件实录与即时快照分层组装，按预算裁剪；提示词明确阶段、发言顺序和已发生事件。每日记忆整理仅针对存活且已创建智能体的 AI，不阻止死亡后的合法技能或遗言。
- **思考与容错**：默认主决策使用低思考强度。公开发言总预算 60 秒，其他决策 30 秒，覆盖排队、请求和修复；可在预算内使用轻量降级，降级状态对用户可见。鉴权、额度等致命错误有单独处理，并非保证所有网络错误都能继续。
- **本机档案**：头像、偏好、战绩、归档、回收站和脱敏导入导出。创建对局时固定归属，之后切换当前档案不会转移该局。
- **私人笔记**：自称、候选身份和备注分层；并发修改使用 revision 冲突控制。旧标记无法完整合并时保留待确认内容，不静默丢弃。
- **存档恢复**：自动落盘并在昼夜边界建立恢复锚点；重启后从可恢复存档继续。恢复边界以实际锚点为准，不承诺进程被强杀时保留尚未写盘的每条事件。
- **跨局经验与统计**：AI 复盘经验按对局档案归属隔离。新档案使用 `profiles/<id>/experiences.json`，迁移的旧池可继续使用原路径。经验是提示词辅助，不是保证 AI 每局变强的模型训练。
- **上帝调试**：有权限时可查看提示词、日志、调用遥测与模型返回的 reasoning；不属于普通玩家可见信息。[打断与终止规则](docs/interrupts.md)另有说明。
- **双端体验**：共享视觉样式与短动效，支持减少动态效果；手机底栏、独立开局流程，电脑侧栏与窄窗口抽屉。角色详情进入大卡检视后，关闭检视返回原资料层。

## 开发与检查

```bash
npm ci
npm run gate
```

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动本地服务 |
| `npm test` | 全量 Node 测试 |
| `npm run lint` / `npm run eslint` | 语法与代码检查 |
| `npm run coverage` | 覆盖率门禁，同时运行测试 |
| `npm run eval` | 隔离 Mock 对局评估，不调用真实模型 |
| `npm run gate` | lint、ESLint、覆盖率、eval、品牌、版本、守卫、e2e、临时残留全链 |
| `npm run ui:check` | 现有 UI 静态检查，不替代浏览器视觉验收 |
| `npm run brand:check` | 品牌资产哈希与引用校验 |
| `npm run version:check` | 检查各工程版本与唯一来源一致 |
| `npm run hooks:install` | 安装 pre-push 守卫；敏感路径改动增加全量测试 |
| `npm run gen-docs` | 从角色定义生成 `docs/roles.md` |

浏览器专项脚本位于 `scripts/ui-*.playwright.js`，是 Playwright 工具执行的回调，不是直接运行的 Node CLI。涉及创建档案或 Mock 对局的脚本仅可在其要求的隔离服务中执行；不要对个人数据目录运行验收写入。原始浏览器截图保存在本机 `output/playwright/`，默认不提交。

`node scripts/probe-current-effort.js --live` 是人工诊断低思考／关闭思考兼容性的付费探针，最多两次短请求，不在门禁中执行；不带 `--live` 不读取配置、不访问网络。不要自动运行到用户账号上。

修改页面内联守卫、品牌母版或 Service Worker shell 时，需要同步相应 CSP、品牌与 shell 测试，不能只修改快照断言让门禁变绿。维护说明见 [守卫整改记录](docs/fix-plan-2026-09-21.md)。

## Windows 电脑端

```bash
npm run app:desktop
```

生成 `release/werewolf-ai-1.5.2-win-x64-portable.exe`。这是 x64 免安装桌面应用，内嵌窗口和本地服务，不依赖外部 Node 或浏览器。构建脚本首次运行会安装桌面工程依赖；需要联网获取构建工具。

本机数据位于 `%APPDATA%\werewolf-ai-desktop`，不在 EXE 旁边；“免安装”不表示关闭后不留下数据。当前包没有 Authenticode 发布者签名，Windows 可能提示未知发布者，不能描述为已签名正式发行版。

`npm run app:win` 是旧式“内置 Node + 浏览器”的文件夹/ZIP 交付方式，不是 Electron 包。本轮仅重建 Electron EXE，不更新历史 ZIP；不要把旧 ZIP 与本轮源码混用。

## Android 手机端

工程采用 Capacitor 与 capacitor-nodejs，在手机本地运行 Node 服务，WebView 连接 `127.0.0.1:3210`。离线可浏览本机资料和使用 Mock，真实 AI 仍需联网。

构建需要 JDK 21 和 Android SDK；通过 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT` 配置本机工具路径。`app/android/local.properties` 不入库。首次准备 Android 工程依赖后构建：

```bash
npm --prefix app ci
npm run app:apk
```

`app:apk` 依次同步服务端/前端、Capacitor sync、Gradle debug 构建、拷贝与源码核验。产物为 `release/werewolf-ai-1.5.2-debug.apk`，**默认不安装到设备**。显式需要覆盖安装时使用 `node scripts/build-apk.js --install`。

当前 APK 使用 debug 签名，用于测试交付；实体手机、软键盘和后台恢复仍需设备验证，不等同于应用商店正式发行。

## 版本与制品核对

版本唯一来源为 `release-version.json`。修改版本后运行 `node scripts/version-sync.js --fix` 同步声明点，再执行 `npm run version:check`。不要分别手改各工程的版本号。

`npm run app:verify -- --release` 默认要求 APK、旧式 WIN 文件夹和 Electron EXE 三类制品均存在且内容一致；本轮只交 APK 与 EXE，不能用旧 WIN 文件夹冒充第三项通过。两包专用核验命令见 [本次交付记录](docs/current-delivery-2026-10-01.md)。

构建产物保存在本机 `release/`，不提交到 Git。任何 `src/`、`web/`、桌面主进程或打包载荷变更后，需要重新构建对应包并检查实际包内内容，不能只检查 `win-unpacked` 或文件名。

## 数据与网络安全

- 默认监听 `127.0.0.1`。局域网访问需要显式 `WW_LAN=1` 并重启；远端管理接口采用配对会话门禁，只在可信网络启用。`WW_HOST` 可指定监听地址。
- `config.json`、`logs/`、`saves/`、根目录 `profiles/`、`migrations/` 和安装包不入 Git。日志及存档可能含私人发言、笔记或调试信息，分享前需脱敏。
- 服务端配置可由 `WW_CONFIG` 指定，数据根目录可由 `WW_DATA_DIR` 指定。开发、评估和制品测试使用临时目录，不能混入真实档案库。
- 档案导出不携带 API Key；模型配置属于设备级设置。提交前仍需检查新增脚本、文档和素材，不能仅依赖 `.gitignore`。

## 项目结构

```text
server.js                 本地 HTTP 服务入口
release-version.json      版本唯一来源
src/engine/               角色、规则、流程、事件和可见性
src/ai/                   模型客户端、调度、上下文、记忆与提示词
src/profiles/             本机档案、头像、迁移、导入导出
src/annotations/          私人笔记与并发控制
src/request-scope.js      请求绝对截止时间与取消生命周期
src/api.js                REST 接口与对局生命周期
web/                      电脑前端及图鉴、AI 名册
web/m/                    手机前端
web/shared/               双端共享状态、样式和交互
web/assets/               已批准品牌、角色、AI 肖像与主题素材
desktop/                  Electron 主进程与构建配置
app/                      Capacitor Android 工程
scripts/                  构建、核验、回归与隔离评估工具
test/                     Node 自动化测试
design/                   设计母版、Figma 交接稿与 OpenPencil 试验
docs/                     使用、设计、施工及历史验收文档
release/                  本机构建产物（忽略）
```
