# 月蚀圣龛 · 素材来源与生成记录

## 方式与边界

- 金属浮雕贴图：使用内置 `image_gen` 工具生成，不使用 CLI/API Key 路径。
- 这是一张新生成的原创卡框素材，未引用具体商业游戏的框图，也未修改项目原始角色立绘。
- 最终 PNG：`assets/reliquary-metal.png`，1024×1536，RGBA，2,033,769 字节。
- SHA-256：`a230c9ba214ee2dfb3f20ca2f089ee625be6fb2d07ca1888205280914f0e4c4b`。
- 生成输出直接复制入本目录，未重新编码或抠图；中心及外缘透明度已经实际采样并通过角色图叠放验证。
- 15 份框/简版/徽记 SVG：代码绘制。`card-back-field.svg`：代码绘制底纹，内嵌项目原有 `web/assets/brand/wolf-emblem.svg` 的图形，不重画软件 Logo。
- 展示截图由真实浏览器渲染 `index.html` 得到，不是生图模型虚构的界面。

## 最终生成提示词

```text
Use case: stylized-concept. Asset type: production-ready transparent game UI card-frame overlay, original premium dark Gothic werewolf social-deduction game, named Moon Eclipse Reliquary. Create ONE front-facing perfectly flat orthographic portrait card FRAME ONLY, exact 2:3 overall aspect ratio, centered and filling the canvas, ideally 1024x1536 pixels. Genuinely transparent alpha both OUTSIDE the silhouette and THROUGH the entire large central illustration opening. Do NOT draw a character, scene, paper, gray fill, black fill or checkerboard in the opening. A usable transparent game sprite, not a photograph or a perspective mockup. Structure: narrow sturdy vertical rails taking only 6-7 percent of card width on either side; a beautifully articulated low Gothic pointed-arch crown occupying the top 9 percent of card height, with a tiny empty round cabochon socket at its center; the central art opening spans approximately x=7% to93%, y=9% to91%. At the foot a broad but shallow EMPTY dark obsidian name plaque across x=19% to81%, y=91% to97%, sized for live HTML role text. Almost all interior is open for artwork. Strong distinctive sculpted silhouette with small wolf-ear-like points at the top corners, moon-crescent tracery and restrained interlacing thorn / cathedral-window metalwork concentrated at the four corners, architectural buttresses on side rails. No giant wolf head, skull, bat wings, literal religious cross, floating runes, lettering, numbers or watermark. Material: believable cast dark gunmetal with carved deep recesses, cool tarnished silver high bevels, restrained pale champagne antique-gold inlay and fine chisel marks. Jewelry-level craftsmanship, physically convincing layered metal thickness and tiny hand-engraved ornament, not flat vector lines, not plastic, not yellow brass or brown wooden picture frame. Only small controlled edge highlights from upper left; dark underside and recessed grooves create depth. Neutral metal palette, no colored gems yet so SVG gems can be layered later, no glow or external mist. Symmetrical structural geometry, varied delicate local engraving. Elegant and richly detailed at inspection scale while having bold readable contours at 200px width. Keep front-facing silhouette completely inside canvas with 1% safety margin, no cropping, no cast shadow outside the object. This is a reusable card BORDER on transparent background, empty center and blank nameplate, with no text anywhere.
```

## 设计落地与提示词的区别

生成提示词是美术意图，不是精确几何规范。最终生成的冠部比提示词的估计值更高，交付组件已按实际 PNG 重新确定拱形画窗、徽记中心和铭牌位置。施工方应复用 `frame-kit.js` 的坐标和真实预览，不能仅依据提示词中的百分比重新裁切。

新增四种宝石主题由 SVG 控制，不需要再次生图：血月红、月谕蓝金、炉火绿铜、命线紫银。隐藏身份始终统一为中性月色；这些配色不表示新的胜负阵营。

推荐保留同一份中性金属 PNG，让所有主题共享纹理；不要逐角色重新生成不同框，避免尺寸、光照和边界漂移。
