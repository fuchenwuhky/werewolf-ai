# 制品清单（最终构建）

commit cf024ab · productVersion 1.5.2 · androidVersionCode 9 · 构建时间 2026-09-19
构建命令：npm run app:apk / app:win / app:desktop；校验：npm run app:verify（EXIT=0）

| 制品 | 大小 | SHA-256 | 校验 |
| --- | --- | --- | --- |
| release/werewolf-ai-1.5.2-debug.apk | 175MB | 9a208dd296a4636036948d604446dbc1033da497cda80329d964e196fab400e3 | 108 文件全内容比对；品牌 26 PNG 字节一致 |
| release/werewolf-ai-1.5.2-win-x64.zip | 55MB | 5a3492adbc10039723af0350ae15cb152dd09312b8d1eaf4f231836d2d894c06 | EXE 图标 7 帧逐帧一致；RT_VERSION 1.5.2 |
| release/werewolf-ai-1.5.2-win-x64-portable.exe | 118MB | 17923398a06084a8ca5dec870ca13275bf2c3f1766bcad62aa7c5ef71fb27038 | EXE 图标 7 帧逐帧一致（图标组 103） |

签名状态：全部未签名（改图标不消除 SmartScreen 提示，未做签名承诺）。
安装记录：MuMu 12（Android 12）首次安装 Success → 冷启动 → 覆盖升级 install -r Success → 数据逐字节保留 → 升级后启动正常。
