# 08 · Live2D 角色接入 —— Cubism 工程 → 项目可用文件(技术咨询整理)

> 主题:如何把 **Live2D Cubism Editor** 里编辑的工程文件转换为本项目可用的运行时资源;
> 哪些角色元素可兼容、哪些不可兼容;以及在本项目(DSH 桌面宠物)里的接入点与风险。
>
> 本文是 2026-08-15 会话中的技术咨询整理稿(暂无代码落地,属设计/研究文档),实现时以实际
> 选定的 Cubism SDK 版本与 Editor 版本为准。

---

## 1. 一句话结论

**Cubism Editor 的工程文件(.cubismproj / .can3 / 源 PSD)运行时用不了,必须用 Editor 导出成"嵌入用(runtime)包"**。导出后,角色的核心能力(网格变形、物理、表情、动画、口型)几乎**全部可兼容**;不兼容的只有编辑器内部工程与预览级特效。真正的难点在**运行时集成**(本项目是 Pixi v8,经典 Live2D 插件不兼容,见 §4)。

## 2. 转换流程:Editor 工程 → 项目可用文件

在 Cubism Editor 中对每个"工程零件"分别导出(**File → Export for embedded use / 組み込み用に書き出し**):

| 编辑器里的东西 | 导出产物 | 项目里放哪 |
|---|---|---|
| 整个模型(网格 + 纹理 + 参数 + 变形器) | `.moc3` + 纹理 `.png` + `.model3.json`(清单) | `assets/pet/live2d/<model>/` |
| 物理(头发/衣物摆动,Physics 窗口) | `.physics3.json` | 同上 |
| 预设姿势(Pose 窗口) | `.pose3.json` | 同上 |
| 表情(Expression 窗口) | `*.exp3.json` | 同上 |
| 动画(Animation 时间轴,每段单独导出) | `*.motion3.json` | 同上 |
| 可点区域(Hit Area) | 写入 `.model3.json` 的 `HitAreas` | 同上 |

导出一个干净目录后,整个目录放进 `assets/pet/live2d/`;electron-vite 的 publicDir 会把它拷进
`out/renderer`,打包时 `assets/**` 已纳入 asar(阶段 5 无需额外配置)。

> **没有 Cubism Editor 也能起步**:Live2D 官网免费示例模型都是现成的 runtime 包
> (moc3 + model3.json),可先下载调通管线,再换自己的角色。

## 3. 兼容矩阵

| 角色元素 | 兼容性 | 说明 |
|---|---|---|
| 网格 / 权重 / 变形器 / 参数(Live2D 核心价值) | ✅ 完全兼容 | 全部打进 `.moc3`,SDK 原生驱动 |
| 纹理(PSD/PSB 分层) | ✅ 兼容 | 导出时按材质合并成带透明通道的 PNG |
| 物理(头发/裙摆/胸部摆动) | ✅ 兼容 | `.physics3.json`,SDK 自动模拟,零代码 |
| 姿态 / 预设姿势 | ✅ 兼容 | `.pose3.json`,SDK 支持 |
| 表情 | ✅ 兼容 | `.exp3.json`,可映射语义状态(如 happy → exp_happy) |
| 动画 | ✅ 兼容 | `.motion3.json`,可映射语义状态(idle → 循环待机) |
| 自动眨眼 / 呼吸 / 口型参数(ParamEyeLOpen / ParamMouthOpenY…) | ✅ 兼容 | SDK 有 auto-blink / auto-breath;口型可外部驱动(如 TTS 音量 → 嘴张) |
| 混合模式(普通/正片叠底/加算) | ✅ 基本兼容 | SDK 支持常见 blend,极端材质可能效果有差 |
| Hit Area 点击热区 | ⚠️ 兼容但需接线 | 数据会导出,但点击检测要自己在运行时写 |
| 编辑器内后期特效(阴影/模糊/后处理/特殊渲染) | ❌ 不导出 | 只是 Editor 预览,运行时没有 |
| 编辑器工程文件(.cubismproj / .can3 / 源 PSD) | ❌ 运行时用不到 | 必须导出,别把工程目录当资源 |
| 逻辑类联动(Editor 里"按条件切换表情"等) | ❌ 编辑器无脚本 | 逻辑必须写在运行时 TS(本项目状态机已承担) |

**难点是运行时集成,不是文件转换** —— 见下。

## 4. 本项目接入点(改哪几处)

架构早为此留好路(AGENTS.md 明示"换 Lottie/Live2D 只加实现类,状态机/事件/UI 零改动"):

1. **`PetAnimator` 接口**(`src/renderer/src/pet/animator.ts`):新增 `createLive2dAnimator(stage)` 实现类,
   `play('idle'|'thinking'|'happy'|'sad'|'talking')` 内:切 motion + 设 expression + 启停
   auto-blink / auto-breath;`tick(delta)` 内喂口型参数(阶段 6 TTS 接入后)。
   状态机 / 事件 / 面板**一行不改**。
2. **`stage.ts`**:Live2D 需要独立 WebGL 渲染 —— 在 Pixi 舞台旁挂一个 Live2D canvas(或遮住 Pixi
   占位球宠),resize / 居中逻辑照旧(0009 已加 resize 监听)。
3. **运行时依赖**:官方 **Cubism SDK for Web**(框架为 TS 源码 + 单文件 `live2dcubismcore.min.js`,
   官方以 zip 分发,需 vendor 进仓库并保留许可声明)。
   ⚠️ 经典插件 `@pixi/live2d-display` 只支持 Pixi v6/v7 且已不维护,而本项目是 **Pixi v8** ——
   Live2D 建议走**独立 canvas 自绘**,不依赖该插件,这是最稳的路线。
4. **CSP**:renderer 已放行 `unsafe-eval`(Pixi 着色器),Live2D 大概率无需再放宽,实现时验证。
5. **打包**:`assets/**` 已进 asar,零改动;纹理建议单张 ≤4096,运动数量克制,避免撑爆安装包。

### 语义状态 ↔ Live2D 素材建议映射

| 状态机语义 | 动作(motion3) | 表情(exp3) |
|---|---|---|
| idle | 待机循环 | —(默认) |
| thinking | 思考动画(眼神漂移/挠头) | 疑惑 |
| happy | 开心动画 | 笑 |
| sad | 难过动画 | 哭/低落 |
| talking | 说话动画 | 口型联动(TTS 音量驱动 ParamMouthOpenY) |

## 5. 风险与注意

- **版本匹配**:Editor 5.x 导出的 `.moc3` 需要较新的 Cubism Core;SDK/Core 与 Editor 版本不匹配会报
  `moc3 unsupported`。选型时锁定 Editor 版本对应的 SDK 版本。
- **许可**:Cubism SDK for Web 是 Live2D 专有许可(符合条款可免费使用);角色素材版权另算 ——
  `assets/pet/README.md` 的 License 表需补 Live2D 条目。
- **体积/性能**:moc3 + 纹理 + 运动集是主要增量;粒子、多张高分辨率纹理需克制。

## 6. 后续建议(未实施,待模型/SDK 定版)

1. `assets/pet/README.md` 补 `live2d/` 目录规则(命名、体积上限、license 占位)。
2. 新增 `createLive2dAnimator` 骨架(先返回"未接入"降级实现 + 接入步骤注释),等定版后填实现。
3. vendor Cubism SDK for Web 到仓库(vendor/live2d 或 assets 同级),记录许可与版本。
