# 08 · Live2D 角色接入 —— Cubism 工程 → 项目可用文件(已落地)

> 主题:如何把 **Live2D Cubism Editor** 里编辑的工程文件转换为本项目可用的运行时资源;
> 本项目(Live2D 视角跟随里程碑)的接入方式与落地记录。
>
> 本文最初是 2026-08-15 的设计稿,现已**完整落地**(0014–0019)。文件转换与兼容矩阵仍有效;
> 实际代码结构以 `src/renderer/src/pet/live2d/` 与 `vendor/live2d/README.md` 为准。

## 1. 一句话结论

**Cubism Editor 的工程文件(.cubismproj / .can3 / 源 PSD)运行时用不了,必须用 Editor 导出成"嵌入用(runtime)包"**。导出后,角色的核心能力(网格变形、物理、表情、动画、口型)几乎**全部可兼容**;不兼容的只有编辑器内部工程与预览级特效。本项目运行时走**官方 Cubism SDK for Web + 独立 canvas 自绘**(Pixi v8 不兼容经典插件,见 §4)。

## 2. 转换流程:Editor 工程 → 项目可用文件

在 Cubism Editor 中对每个"工程零件"分别导出(**File → Export for embedded use / 組み込み用に書き出し**):

| 编辑器里的东西 | 导出产物 | 项目里放哪 |
|---|---|---|
| 整个模型(网格 + 纹理 + 参数 + 变形器) | `.moc3` + 纹理 `.png` + `.model3.json`(清单) | `assets/pet/live2d/<model>/` |
| 物理(头发/衣物摆动,Physics 窗口) | `.physics3.json` | 同上 |
| 预设姿势(Pose 窗口) | `.pose3.json` | 同上(未制作) |
| 表情(Expression 窗口) | `*.exp3.json` | 同上(未制作) |
| 动画(Animation 时间轴,每段单独导出) | `*.motion3.json` | 同上(未制作) |
| 可点区域(Hit Area) | 写入 `.model3.json` 的 `HitAreas` | 同上(未制作) |

导出一个干净目录后放进 `assets/pet/live2d/`;electron-vite 的 publicDir(`assets`)会把它拷进 `out/renderer`。

## 3. 兼容矩阵(本项目实测)

| 角色元素 | 兼容性 | 说明 |
|---|---|---|
| 网格 / 权重 / 变形器 / 参数 | ✅ | 全部打进 `.moc3`,SDK 原生驱动 |
| 纹理(PSD/PSB 分层) | ✅ | 导出时合并成带透明通道的 PNG(本项目单张 1024²) |
| 物理(头发摆动) | ✅ | `.physics3.json`,SDK 自动模拟 —— 头部角度变化即触发后发摆动(实测) |
| 自动眨眼 | ✅ | model3.json EyeBlink 组为空,运行时显式注入 `ParamEyeLOpen/ROpen` 绕过(0018) |
| 自动呼吸 | ✅ | `ParamBreath` 由 `CubismBreathUpdater` 驱动(0018/0019,注意 load/save 帧节奏) |
| 姿态 / 预设姿势 | ⏳ 未制作 | `.pose3.json`,SDK 支持 |
| 表情 | ⏳ 未制作 | `.exp3.json`,可映射语义状态 |
| 动画 | ✅ 摸头已接入(0037) | `.motion3.json`,运行时直接加载,不依赖 model3.json 注册 |
| 口型(`ParamMouthOpenY`) | ✅ 参数已就绪(0037) | 模型已带嘴部参数,口型动画素材待制作 |
| Hit Area 点击热区 | ⏳ 未制作 | 数据会导出,点击检测运行时自写 |
| 混合模式 | ✅ 基本兼容 | SDK 支持常见 blend |
| 编辑器内后期特效 | ❌ 不导出 | 只是 Editor 预览 |
| 编辑器工程文件(.cmo3 / 源 PSD) | ❌ 运行时用不到 | 已移出仓库(0021),存于 `C:\Users\wanyu\Desktop\projects\live2d\`;勿放回 assets/ |

## 4. 本项目接入点(实际落地)

架构留好的路(AGENTS.md"换 Live2D 只加实现类,状态机/事件/UI 零改动")已兑现:

1. **`PetAnimator` 接口**(`src/renderer/src/pet/animator.ts`)不变;新增 `createLive2dAnimator(stage)`
   工厂(0014),`play(state)` 切状态 + 启停眨眼,`tick(delta)` 驱动跟随/呼吸/物理;另有可选
   `applyPetSettings?`(设置面板实时调位置/大小/手感,0017)。占位球宠(`sprite-animator.ts`)
   在 WebGL2 不可用时回落。
2. **运行时**:`pet/live2d/cubism-runtime.ts` —— 独立 WebGL2 canvas 挂 `#stage`(不依赖 Pixi 渲染),
   官方 SDK 5-r.5 自绘;每帧 `loadParameters → 写跟随参数 → saveParameters → 调度器(物理/眨眼/呼吸)→
   model.update → 渲染`(0019 修复加算型更新器累加)。`view-follower.ts` 是纯计算跟随逻辑
   (指数距离曲线 + Y 取反 + 分通道平滑),与 SDK 解耦。
3. **SDK vendor**:`vendor/live2d/` —— 官方 **Cubism SDK for Web 5-r.5**(Core 06.00.0001),
   Framework 编译为 ESM+d.ts(`@live2d/framework` 别名),Core 经 index.html script 标签引入全局,
   着色器在 `assets/pet/live2d/shaders/`。许可与再构建步骤见 `vendor/live2d/README.md`。
4. **视角跟随数据源**:主进程 33ms 轮询光标(`screen.getCursorScreenPoint` + 窗口 bounds)经
   `pet:cursor` 推给 renderer(0016 修复拖拽区域吞鼠标事件;0017 去掉边缘夹取让窗外距离生效)。
5. **设置面板**:宠物水平/垂直位置、显示大小、头部/眼珠/身体幅度、死区、跟随距离、跟手速度,
   实时生效并持久化(0017,`PetConfig.pet`)。

### 语义状态 ↔ Live2D 素材建议映射(表情/动画里程碑用)

| 状态机语义 | 动作(motion3) | 表情(exp3) |
|---|---|---|
| idle | 待机循环;摸头反馈 `pat-head`(0037:鼠标在头部停留触发,见 README §4.1) | —(默认) |
| thinking | 思考动画(眼神漂移/挠头) | 疑惑 |
| happy | 开心动画 | 笑 |
| sad | 难过动画(`Expression_sad` 素材已导出,待接入) | 哭/低落 |
| talking | 说话动画 | 口型联动(TTS 音量驱动 ParamMouthOpenY) |

## 5. 风险与注意(已核实)

- **版本匹配**:本项目模型 moc3 格式版本 = 6(`MocVersion_53`,5.3.00+),由 Core **06.00.0001**
  (SDK for Web **5-r.5**)支持 —— 已实测加载通过,无 `moc3 unsupported`。换旧 Core 会报错。
- **许可**:Core 为 Live2D Proprietary Software License,Framework 为 Live2D Open Software License,
  许可文件已随 `vendor/live2d/` 入库;角色素材版权另算(`assets/pet/README.md` License 表)。
- **体积/性能**:moc3 + 纹理 + Core js 为主要增量;`.cmo3` 编辑器工程已移出 assets(0021),不会再被打包。

## 6. 落地记录与剩余项

- **落地**:0014(骨架+跟随逻辑)→ 0015(vendor + 独立 canvas 运行时)→ 0016(光标主进程轮询)→
  0017(调优 + 设置面板)→ 0018(眨眼/呼吸)→ 0019(呼吸 load/save 节奏修复)→
  0037(表情动作 motion 接入:摸头反馈 + 模型补嘴部/眼泪参数)。
- **剩余**:其他语义状态(thinking/happy/talking)的动画素材、exp3 表情、pose3、HitAreas
  (导出清单见 `assets/pet/live2d/README.md` §4);口型动画素材;LipSync。
