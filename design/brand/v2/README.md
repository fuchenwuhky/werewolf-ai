# 月夜狼冠 V2 · SVG 与软件图标交付包

本包是供施工方接入的新版品牌资产，未覆盖现有 `web/assets/icon*`、Android mipmap、Electron 安装包。

## 设计

从用户提供的旧图保留“暗色狼首、古金圆环、红眼”，重新手绘为清晰的高耳、收长吻部、银灰金属切面与尖拱背景。无嵌入位图、无外链字体、无脚本、无模糊滤镜；路径、渐变和分组均可编辑。

- `wolf-emblem.svg`：1024×1024 纯矢量母版，外圆以外透明。
- `export/app-icon.svg`：完整方形底的软件图标 SVG。
- `export/icon-1024.png`：1024px 软件图标，实色背景，无 alpha 通道。
- `export/wolf-decal-1024.png`：透明背景贴图，保留完整纹章，适合启动页或宣传排版。
- `export/app.ico`：Windows ICO，内含 16/24/32/48/64/128/256px 七个 PNG 帧。
- `export/icon-{size}.png`：16、24、32、48、64、72、96、128、144、180、192、256、512、1024px。
- `export/icon-maskable-512.png`：PWA maskable 专用，纹章缩至 82%，背景满铺；勿用普通图标假冒。
- `export/adaptive-foreground-{size}.png`：108、162、216、324、432px 透明前景，分别对应 mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi 的 108dp Android 自适应画布；图案缩至 69%，位于中心安全圆内。
- `export/manifest.json`：母版及导出资源 SHA-256、尺寸与渲染器版本。

## 接入映射

| 现有目标 | 使用新文件 |
| --- | --- |
| `web/assets/icon.svg` | `export/app-icon.svg` |
| `web/assets/icon-192.png` | `export/icon-192.png` |
| `web/assets/icon-512.png` | `export/icon-512.png` |
| `web/assets/icon-maskable-512.png` | 同名导出文件 |
| `web/assets/apple-touch-icon.png` | `export/icon-180.png` |
| Windows 文件图标 | `export/app.ico`（还要验证 exe 资源是否真正写入） |
| Android legacy mipmap | 48/72/96/144/192px 对应五档密度 |
| Android adaptive foreground | 108/162/216/324/432px 对应五档密度 |
| Android adaptive background | 实色 `#080D17`，在 XML 色值中设置 |

Android round 资源可由对应 legacy 图在工具中圆形裁切；不能把已经圆角化的图片再当 adaptive 前景。Android 13 monochrome 版本属于施工补充项，需另做单色轮廓／负形并真机验收，不用彩色 PNG 冒充。

Android 前景／背景使用 108dp 画布，关键图形置于中央 66dp 安全区域；外圈为系统裁切与动画留白。[Android 官方规范](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)。

## 可复现导出

母版只能维护一份。不要修改 PNG，也不要运行旧的数学狼头生成器覆盖本包。

导出脚本：`scripts/export-brand-v2.js`。它只写入 `design/brand/v2/export/`，不修改生产图标。构建工具需要 Sharp（开发期工具，不进入软件运行依赖）。可使用已安装版本，或将 `WW_SHARP_MODULE` 指向独立工具环境中 Sharp 模块的绝对路径，再执行：

```powershell
node scripts/export-brand-v2.js
node --test test/brand-v2.test.js
```

本次使用 Sharp 版本见 manifest。施工方将其固定到构建工具锁文件；重建后更新 manifest，并校验资产内容。后续统一 `make-icons.js` 与 `gen-icon.js` 的入口时，可调用这一流程或已审核的同源渲染器，禁止保留三份互不相干的狼头轮廓。

## 验收

检查 SVG 可编辑、PNG 尺寸与透明度、ICO 七帧、PWA 圆形裁切、Android 圆形／圆角方形掩模；在浅／深桌面背景查看 16/24/32/48/64px。品牌预览见 `design/ux-v2/index.html`。

现有 Electron 配置 `signAndEditExecutable: false` 可能让 exe 保留默认图标；不能把“窗口标题栏出现新图”当作“exe 图标已替换”。需在施工阶段验证资源编辑链，并记录签名与 SmartScreen 状态，不承诺仅更换图标就消除系统警告。
