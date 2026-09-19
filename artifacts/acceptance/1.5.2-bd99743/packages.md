# 制品清单（最终构建）

commit cba485d（最终构建：含偏好应用/撤销/返回栈修复）· productVersion 1.5.2 · androidVersionCode 9 · 构建时间 2026-09-19
构建命令：npm run app:apk / app:win / app:desktop；校验：npm run app:verify（EXIT=0）

| 制品 | 大小 | SHA-256 | 校验 |
| --- | --- | --- | --- |
| release/werewolf-ai-1.5.2-debug.apk | 175MB | 34b623d87147d19e2aae72f1c6a88879f1e9e766e4f0cba4dc10b025cc94dbb8 | 108 文件全内容比对；品牌 26 PNG 字节一致 |
| release/werewolf-ai-1.5.2-win-x64.zip | 55MB | d327738dfbab804d3b54eeaa687654ddec9fed74c9fd15a662cb2fc2e8dda10f | EXE 图标 7 帧逐帧一致；RT_VERSION 1.5.2 |
| release/werewolf-ai-1.5.2-win-x64-portable.exe | 118MB | ef90e5a8c221e9c85deb841e680e976d724c8141386f342109b37a96e03de914 | EXE 图标 7 帧逐帧一致（图标组 103） |

签名状态：全部未签名（改图标不消除 SmartScreen 提示，未做签名承诺）。
安装记录：MuMu 12（Android 12）首次安装 Success → 冷启动 → 覆盖升级 install -r Success → 数据逐字节保留 → 升级后启动正常。
