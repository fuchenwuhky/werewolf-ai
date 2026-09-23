# 验收快照 · 1.5.2 @ 4092351

- 提交：`312e0aeab4149d6af707974784acd3c063d589f4`
- 版本：`1.5.2`
- 生成时间：2026-09-23T13:49:03.601Z
- **结论：存在未通过项 ❌**

| 检查项 | 结果 | 读数 | 日志 |
| --- | --- | --- | --- |
| 提交与工作区：工作区干净（除 design/card-frames 未跟踪，见台账 §16.36.6） | ❌ | 未提交改动 2 项：M scripts/r01-pendingid.js ; ?? artifacts/acceptance/1.5.2-ac240c0/ | — |
| 全量测试 node --test | ✅ | tests 1147 / pass 1147 / fail 0 | `logs/test.log` |
| 制品一致性 npm run app:verify | ✅ | 见日志 | `logs/app-verify.log` |
| 证据目录空白帧闸门 png-stats docs/evidence/* | ✅ | 合计 200 张：有画面内容 200 张，空白或读取失败 0 张 | `logs/png-stats.log` |
| Android 真机验证 device-check | ✅ | 结果：10/10 条判据成立 | `logs/device-check.log` |
| 制品清单与 sha256（9 个） | ✅ | werewolf-ai-1.4-win-x64.zip=54447959B , werewolf-ai-1.4.0-win-x64-portable.exe=94137304B , werewolf-ai-1.5.0-debug.apk=179168116B , werewolf-ai-1.5.0-win-x64.zip=54486405B , werewolf-ai-1.5.2-debug.apk=185535461B , werewolf-ai-1.5.2-win-x64-portable.exe=124875554B , werewolf-ai-1.5.2-win-x64.zip=148458487B , app-debug.apk=185535461B , werewolf-ai-1.4.1-debug.apk=179090811B | — |

## 制品哈希

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `release/werewolf-ai-1.4-win-x64.zip` | 54447959 | `11f19fcc07fa9b1c98b8970f0ceda1eebf0c1ad961a5cd0b4d41d41284ff35f1` |
| `release/werewolf-ai-1.4.0-win-x64-portable.exe` | 94137304 | `c03c2ee82069c0e356983ebda6bd29f6008107bc2af5354f34138400ae31aed5` |
| `release/werewolf-ai-1.5.0-debug.apk` | 179168116 | `5eff38f123ed57ede5cb0bf237bd9d94525a9c33dd7911208c18e94d15e4c8fc` |
| `release/werewolf-ai-1.5.0-win-x64.zip` | 54486405 | `928fb721f9cef500cfb22a72904aa9110a3e16272e3b4c392b48d1f7d7729bea` |
| `release/werewolf-ai-1.5.2-debug.apk` | 185535461 | `edbadbaa90fcd1f5deaec046e9512e80e86d61dc92f983b86e418cdc79496fde` |
| `release/werewolf-ai-1.5.2-win-x64-portable.exe` | 124875554 | `8ab5060efb747915370dc21cf37accd7aac2a4354c73fbae3a4c455540952e02` |
| `release/werewolf-ai-1.5.2-win-x64.zip` | 148458487 | `4675278b0850a885921d9f5c44c46fdc3aa0f77fa246e94918427cfdf87182e7` |
| `app/android/app/build/outputs/apk/debug/app-debug.apk` | 185535461 | `edbadbaa90fcd1f5deaec046e9512e80e86d61dc92f983b86e418cdc79496fde` |
| `werewolf-ai-1.4.1-debug.apk` | 179090811 | `241c0acd9099dc534577e8b1cc7075ff1f82b5448501b929384b111ccf1e986a` |

> 本目录由 `node scripts/acceptance-snapshot.js` 生成，可一键复跑。
> 每一项都是真跑：未跑的项会**显式写成"未跑"并计入未通过**，不会因为跳过而变绿。
