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
| FIN-07 | 待施工（先核验） | — | — | — |
| FIN-08 | 资产地基完成，页面接入进行中 | 6921c0c | web/assets/brand/wolf-emblem.svg（母版直拷）+ svg-master 校验链；映射条目待页面引用落地后加入 | 页面引用未落地前 brand:check 暂不含该资产 |
| FIN-09 | 待施工 | — | — | 无真机时 Android 项保留待验证 |
| FIN-10 | 待施工 | — | — | — |
| FIN-11 | 已完成（62e4fb3） | 62e4fb3 | release-version.json 单一来源 + scripts/version-sync.js --check 全绿 | 对外版本号仍为 1.5.2，发布号需用户确认 |
| FIN-12 | 待施工 | — | — | Android 真机待 MuMu/实机 |
| FIN-13 | 待施工 | — | — | — |

## 纪律

- 每个工作包一组可独立审查的提交；缓存修复 / UI 格式化 / 版本升级不混提交。
- 测试只增不删；改旧断言必须说明契约变化理由。
- 施工期间不发布、不动 `release/` 历史制品。
