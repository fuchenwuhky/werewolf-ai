# OpenPencil 试验：月夜议会大厅

这是工具可行性试验，不是现有应用的正式改版，也不是完整设计稿。

- `lobby-sample.html`：用于导入的独立静态页面，不含用户数据或 API Key。
- `nocturne-ui-sample.op`：OpenPencil v0.8.4 导入后生成的可编辑节点文档；试验中把主卡标题改为“召集今夜的议会”。
- `nocturne-ui-sample.png`：从 `.op` 文件导出的预览。

实测：HTML 导入得到 46 个节点；文本修改、保存、PNG 导出均成功。导入器警告 CSS margin 无法无损表示，导出图中右侧说明出现了异常换行；需要人工校对布局，不能把 HTML 导入结果直接视为像素级还原。内置 lint 报 2 条警告，其中圆角不一致是有意设计，不宜机械照单修改。

使用的是 [ZSeven-W/openpencil](https://github.com/ZSeven-W/openpencil) v0.8.4 官方 Windows 便携版，下载包 SHA-256 已与 GitHub Release 的 digest 核对。程序仅解压在系统临时目录，未执行全局安装，也未配置模型 Key 或向远端提交本项目素材。试验时 `--web` 返回“web bundle not found”；桌面编辑器与无界面 MCP/CLI 可用。
