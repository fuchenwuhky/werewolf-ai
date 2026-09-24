# 月蚀圣龛卡牌皮肤：专项交付与剩余验收

日期：2026-09-24。范围仅为 `docs/card-skin-replacement-construction-plan.md` 的 SKIN-00—05；不把账号、玩法或整机发布混进本单。代码基线为 `6295e6d`，本轮接线与验收改动见工作区后续提交。

## 已落地

| 项 | 实际接入/证据 | 状态 |
| --- | --- | --- |
| SKIN-00—02 | 17 件 V3/R2 素材、`CardFrame.mount()`、共享样式、SW 预缓存；`node scripts/card-skin-manifest.js --quiet` 源/生产/台账三方哈希一致；设计包 `verify-kit.cjs` 2116 条断言 | 通过 |
| SKIN-03 | 双端图鉴列表/详情、角色检视、本人翻牌、桌面 62px/手机 52px 常驻小牌、统一 neutral 牌背都走 `CardFrame.mount`。原图鉴筛选/分页/选择、Esc/返回与对局流程保持；桌面图鉴 15/15 新框、四主题齐、旧框叠套 0；真实翻牌正反均 230×345，手机小牌 52×78 | 通过；见下方交互未测边界 |
| SKIN-04 | 浏览器探针 52/52：52/62/112/113/132/210/230/320px 切档与比例、未揭示 DOM/ARIA/请求同形、PNG/SVG/立绘失效降级、小卡不增量请求 1.94MiB 材质、五张大卡共用一个材质 URL；SW 控制下真断网请求牌背/大框/小框/金属图均 200 且有字节 | 核心通过；旧 Worker 升级场景未单列实测 |
| 双端产品流程 | `npm run ui:check -- --full --strict` 退出码 0；含桌面/手机图鉴、详情、开局翻牌、手机常驻小牌、320×568/390×844 小屏与浏览器控制台检查。截图在本机 `logs/ui-shots/02c-codex.png`、`06b-mobile-codex.png`、`06c-mobile-codex-detail.png`、`07b-flip.png`、`07c-flip-open.png`、`13-mobile-game.png` | 通过；截图为可复跑本机证据，不随源码包分发 |

## 尚不能宣称完成的判据

| 判据 | 当前缺口 | 下一步 |
| --- | --- | --- |
| SV-07 连续 20 次开关检视 | 现有浏览器流程覆盖打开/关闭/返回，但没有 20 次循环与监听器计数的专项读数 | 用双端真实按钮循环 20 次，记录 DOM 数量、`ResizeObserver` 订阅与 Esc 焦点归还 |
| SV-09 旧 Worker 升级 | 已验证新 Worker 离线包及网络优先策略；未从旧代缓存作为初始状态做升级录像 | 用隔离浏览器配置注入旧代缓存，按应用更新提示刷新，验证首载 V3/R2、草稿不被强刷 |
| SV-11 原生运行时 | APK、WIN 目录/zip、portable EXE 已重建，`npm run app:verify` 退出码 0：APK/WIN 各 144 件、portable EXE 内 145 件与当前源码逐字节一致；但设备内实际开牌截图尚未复验 | Android 设备与 EXE 运行时截图另取证。当前 `adb devices` 报 `emulator-5554 offline`，设备子项明确记未执行 |

## 复跑命令

```text
node design/card-frames/v3/verify-kit.cjs
node scripts/card-skin-manifest.js --quiet
node --test test/card-frame.test.js test/card-frame-skin.test.js
node scripts/card-skin-probe.js
npm run ui:check -- --full --strict
npm run gate
npm run app:verify
```

所有脚本使用隔离数据目录或只读检查，不应写入玩家的 `saves/`、`profiles/`、`config.json`。`logs/ui-shots/` 是本机测试产物，提交中不作为生产运行资源。新皮肤不改变玩家档案/对局存储格式，也不新增皮肤切换或付费解锁。
