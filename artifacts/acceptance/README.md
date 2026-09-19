# 验收证据目录（FIN-13）

约定：`<product-version>-<commit>/` 子目录存放一次交付的完整证据。
清单要求见 docs/final-delivery-construction-plan.md §18。

本目录内容不替代台账（docs/final-delivery-status.md）；台账负责状态，这里负责可查验材料：
- acceptance-results.md：C01-C08 / R01-R08 / V01-V16 逐条结果（命令、退出码、环境、时间）
- screenshots/：双端改版前后对照（每张注明 commit、尺寸、场景）
- recordings/：旧缓存首升级、满字段待确认、断线恢复、导入故障与清理重试
- packages.md：制品文件名 / SHA-256 / commit / 版本 / 构建命令 / 设备安装结果

> 当前交付：1.5.2-bd99743（2026-09-19）
