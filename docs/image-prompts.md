# 角色卡 AI 生图提示词（哥特暗黑风）

> 用法：把下面的英文 prompt 喂给 Midjourney / Stable Diffusion / 即梦 / DALL·E 等任意生图工具。
> 生成后把图片按"目标文件名"保存到 `web/assets/roles/` 目录（覆盖同名 .svg 占位图，
> 或直接放 .png——程序自动识别 png > webp > svg），刷新页面即生效。
> 建议尺寸：**768×1024（竖版 2:3）**，PNG 或 WebP。

## 统一风格前缀（每张 prompt 都以这段开头，保证整套一致）

```
Gothic dark fantasy oil painting, werewolf game character card, dramatic chiaroscuro lighting,
deep black and crimson red with antique gold accents, foggy moonlit atmosphere, macabre elegance,
highly detailed, portrait orientation, full-bleed artwork with no border, edge-to-edge painting
```

统一负面提示词（Negative prompt，SD 系适用）：

```
text, watermark, signature, bright cheerful colors, cartoon, chibi, low quality, blurry,
deformed hands, modern clothing, daylight, oversaturated, frame, border
```

出图参数：`--ar 2:3`（Midjourney）；一致性技巧：固定同一风格前缀、尽量用同一 seed、
先出一张满意的当"垫图/风格参考"再生成其余。

> **注意：画面不要画边框！** 金色雕花边框由程序在卡牌外层统一叠加，
> AI 只需要画出顶到边缘的角色画（full-bleed）。生成时负面提示词里可加 `frame, border`。

---

## 角色卡（10 张）

### 1. 狼人 → `web/assets/roles/wolf.png`
- 中文：月下荒原上一头半直立的黑毛巨狼，猩红双眼发光，獠牙滴涎，身后血月与枯树剪影，雾气缠绕爪牙
- 英文：`a massive black dire wolf standing half-upright on a misty moor under a blood moon, glowing crimson eyes, bared fangs, silhouettes of dead trees, swirling fog around its claws` + 统一前缀

### 2. 狼王 → `web/assets/roles/wolfking.png`
- 中文：戴破碎黑铁王冠的狼人王者，披风染血，居座于骸骨王座，手持弯月战斧，眼中有王者的冷光
- 英文：`an alpha werewolf king wearing a broken black iron crown and blood-stained cloak, seated on a bone throne, holding a crescent battle axe, cold glowing eyes` + 统一前缀

### 3. 白狼王 → `web/assets/roles/whitewolfking.png`
- 中文：苍白毛发上沾霜雪的巨型白狼王，双眼金红，周身缠绕闪电与白雾，气质狂傲，背景是被撕裂的教堂彩窗
- 英文：`a colossal white alpha wolf with frost-covered fur, golden-red eyes, arcs of lightning and pale mist, proud and ferocious, shattered cathedral stained-glass window behind` + 统一前缀

### 4. 预言家 → `web/assets/roles/seer.png`
- 人设：**年轻的女性预言家**（官方形象），神秘学少女
- 中文：年轻的哥特裙少女预言家俯视发光水晶球，球中狼形暗影，桌面星图塔罗，烛光与青蓝秘法光辉
- 英文：`a beautiful young female seer in a dark gothic gown gazing down into a glowing crystal ball revealing a shadowy wolf silhouette, star charts and tarot cards scattered on the table, candlelight mixed with arcane blue glow on her face, mysterious youthful beauty` + 统一前缀（负面词加 `old man, beard`）

### 5. 女巫 → `web/assets/roles/witch.png`
- 人设：**成熟妩媚的黑袍女巫**；与守卫是情侣——腕间系一小段**红色丝带**作为信物（画面含蓄点到即可）
- 中文：成熟妩媚的黑袍女巫在坩埚前调药，手持解药红瓶，腕间系一小段红色丝带，绿紫毒雾升腾，窗外血月，架上有骷髅与干草药
- 英文：`a mature alluring witch in an elegant dark gothic gown brewing potions beside a cauldron, holding a red vial of antidote, a small red ribbon tied around her wrist, green and purple toxic mist swirling, skulls and dried herbs on shelves, blood moon through the window` + 统一前缀

### 6. 猎人 → `web/assets/roles/hunter.png`
- 中文：披斗篷的猎人持老式火枪，枪口仍冒着蓝烟，腰间挂银弹与狼牙项链，雪夜森林背景，眼神冷峻
- 英文：`a cloaked hunter aiming an antique flintlock gun with blue smoke, silver bullets and a wolf-fang necklace on his belt, snowy night forest, cold determined eyes` + 统一前缀

### 7. 守卫 → `web/assets/roles/guard.png`
- 人设：**成熟稳重的重甲守卫**；与女巫是情侣——剑柄上系着**同款红色丝带**（呼应女巫腕间，不点破）
- 中文：成熟稳重的中世纪重甲守卫持塔盾与长剑立于村庄大门，剑柄系一小段红色丝带，盾面刻十字玫瑰纹，身后火把长廊，坚定中带一丝柔情
- 英文：`a mature resolute medieval guardian in heavy plate armor holding a tower shield etched with a cross and roses and a longsword, a small red ribbon tied around the sword hilt, standing at a village gate, torch-lit corridor behind, solemn with a trace of tenderness` + 统一前缀

### 8. 骑士 → `web/assets/roles/knight.png`
- 中文：银甲骑士单膝跪地、长剑指天，剑身圣纹发光，破披风在夜风中猎猎，身后是残破教堂与血月，庄严悲壮
- 英文：`a silver-armored knight kneeling on one knee raising a glowing longsword etched with holy runes, tattered cape fluttering in the night wind, ruined cathedral and blood moon behind, solemn and tragic` + 统一前缀

### 9. 白痴 → `web/assets/roles/idiot.png`
- 中文：戴破帽的傻瓜疯癫大笑，手里抛着三张旧塔罗牌，衣服补丁似小丑但眼瞳深处藏着一丝清醒，荒诞马戏团废墟
- 英文：`a mad fool in a torn jester hat laughing wildly, juggling three worn tarot cards, patchwork clothes, a spark of lucidity in his eyes, ruined gothic circus background` + 统一前缀

### 10. 平民 → `web/assets/roles/villager.png`
- 中文：粗布斗篷的村民提一盏油灯站在自家木门前，门后是黑暗森林，脸上是恐惧与坚毅交织，油灯是画面唯一暖光
- 英文：`a common villager in rough cloak holding an oil lantern in front of a wooden door, dark forest looming behind, mixed fear and resolve on his face, the lantern is the only warm light` + 统一前缀

---

## 附加素材（可选）

### 牌背 → `web/assets/roles/card_back.png`（用于卡背，可选）
- 中文：哥特玫瑰窗纹样居中，月轮与十字碑环绕，黑金对称花纹，中央一颗血红宝石
- 英文：`ornate gothic rose window pattern, crescent moon and crossed tombstones, symmetrical black and gold filigree, a single crimson gemstone in the center, no characters` + 统一前缀（把 character 相关词删掉）`--ar 2:3`

### 桌面端背景 → `web/assets/bg_desktop.png`（2560×1440，可压缩）
- 中文：俯视一张古老木桌，桌上散落羊皮纸、蜡烛、银匕首与塔罗牌，中央留大面积暗部供 UI 叠加
- 英文：`top-down view of an ancient wooden table scattered with parchment scrolls, burning candles, a silver dagger and tarot cards, large dark empty area in the center, vignette` + 统一前缀 `--ar 16:9`

### APP 图标 → `web/assets/icon.png`（1024×1024）
- 中文：极简哥特狼头剪影嵌在血月之中，黑底金边，边缘雕花
- 英文：`minimalist gothic wolf head silhouette inside a blood moon, black background with gold ornate border, flat emblem style` `--ar 1:1`

---

## 接入清单（生成后对照放文件）

| 图 | 文件 | 备注 |
|---|---|---|
| 狼人 | `web/assets/roles/wolf.png` | 竖版 2:3 |
| 狼王 | `web/assets/roles/wolfking.png` | 同上 |
| 白狼王 | `web/assets/roles/whitewolfking.png` | 同上 |
| 预言家 | `web/assets/roles/seer.png` | 同上 |
| 女巫 | `web/assets/roles/witch.png` | 同上 |
| 猎人 | `web/assets/roles/hunter.png` | 同上 |
| 守卫 | `web/assets/roles/guard.png` | 同上 |
| 骑士 | `web/assets/roles/knight.png` | 同上 |
| 白痴 | `web/assets/roles/idiot.png` | 同上 |
| 平民 | `web/assets/roles/villager.png` | 同上 |

> 放好后刷新浏览器即可（服务会自动扫描识别）。占位 SVG 保留不影响，程序优先用 .png。
