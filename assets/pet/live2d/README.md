# ds-pet Live2D 模型 —— 兼容性说明卡

> 本文件是 `assets/pet/live2d/` 模型的**兼容性速查卡**:记录导出文件、参数 ID、物理接线、
> 版本兼容事实与已知坑。后续接入或扩展(表情、姿势、动画、可点区域)直接照此办理,
> **无需重新排查兼容性**。总体接入方案见 `doc/08-live2d-integration.md`。

## 1. 文件清单

| 文件 | 作用 | 备注 |
|---|---|---|
| `ds-pet.model3.json` | 模型清单(运行时入口) | Version 3;引用 moc3 / 纹理 / 物理 / cdi |
| `ds-pet.moc3` | 网格 + 权重 + 参数 + 变形器 | 文件头版本号 = **6**(见 §3) |
| `ds-pet.1024/texture_00.png` | 纹理 | 1024×1024,8-bit RGBA,带透明通道 |
| `ds-pet.physics3.json` | 物理(后发摆动) | 输入 `ParamAngleX/Y`,输出后发参数,SDK 自动模拟 |
| `ds-pet.cdi3.json` | 参数/部件 ID 与显示名表 | 运行时随 model3.json 加载,开发时查 ID 用 |
| `core/live2dcubismcore.js` | **Cubism Core 运行时(全局 `Live2DCubismCore`)** | index.html 以 script 标签引入,须在模块脚本前;版本 06.00.0001(SDK 5-r.5) |
| `shaders/*.vert\|.frag` | WebGL 着色器(12 个) | `cubism-runtime.ts` 按 `/pet/live2d/shaders/` 拉取 |
> **Cubism Editor 工程文件已移出 assets(0021)**:`ds-pet.cmo3` 与备份 `ds-pet - 副本.cmo3`
> 现存放于仓库外 `C:\Users\wanyu\Desktop\projects\live2d\`,不再随 publicDir 拷进
> `out/renderer` / 安装包。它们是编辑器工程(非运行时),不要放回 `assets/` 或被 model3.json 引用。

## 2. 参数 ID 总表(按用途分组)

### 视角跟随(鼠标)
| ID | 含义 |
|---|---|
| `ParamAngleX` / `ParamAngleY` / `ParamAngleZ` | 头部角度(左右 / 上下 / 倾斜) |
| `ParamEyeBallX` / `ParamEyeBallY` | 眼珠转动 |
| `ParamBodyAngleX` / `ParamBodyAngleY` / `ParamBodyAngleZ` | 身体旋转(可选联动) |

### 物理驱动(仅由物理写入,运行时不手动设)
| ID | 含义 |
|---|---|
| `ParamBackHairUp` / `ParamBackHairDown` / `ParamBackHairSwing` | 后发上 / 下 / 上下摆动 |

### 拖动反馈(运行时输入,物理演算输出 —— 0032)
| ID | 含义 |
|---|---|
| `ParamDragX` | 左右拖动宠物 —— 运行时按窗口水平位移写入,PhysicsSetting6 输入 |
| `ParamDragY` | 上下拖动宠物 —— 运行时按窗口垂直位移写入,PhysicsSetting5 输入 |

### 手动 / 程序驱动
| ID | 含义 |
|---|---|
| `ParamTailSwing` | 尾巴上下晃动 |
| `ParamBreath` | 呼吸(与 SDK auto-breath 同名) |
| `ParamPupilSize` | 瞳孔收缩 —— **0 = 正常,1 = 缩到最小**(moc3 已核实 min=0/default=0/max=1)。运行时在空闲(视线跟随)时由"鼠标快速接近"驱动收缩、停驻后缓慢复原(0029) |
| `ParamHairFront` / `ParamHairSide` | 前发 / 侧发摆动(可手动联动头部角度) |
| `ParamCheek` | 脸颊泛红 |
| `ParamBrowLAngle` / `ParamBrowRAngle` / `ParamBrowLY` / `ParamBrowRY` | 眉毛角度 / 上下 |

### 表情 / 说话
| ID | 含义 |
|---|---|
| `ParamEyeLOpen` / `ParamEyeROpen` | 眼睛开闭(眨眼;motion 播放期间由 autoBlink=false 让位) |
| `ParamEyeLSmile` / `ParamEyeRSmile` | 眼睛微笑 |
| `ParamEyeForm` | 眼睛形状(1 = 笑眼/眯眼) |
| `ParamTear` | 眼泪(表情动画用,`Expression_sad` 已驱动) |
| `ParamMouthOpenY` | 嘴部开合(LipSync/说话;0037 起模型已带,口型素材待制作) |
| `PartEyeMask` | 眼睛蒙版部件 |
| `Part2` | 隐藏的表情嘴 `mouth2.psd`(当前隐藏,"未找到对应图层"是预期,勿删) |

## 3. 已确认的兼容性事实(避免重复排查)

1. **moc3 版本号 = 6**(文件头第 4~7 字节,小端)= `MocVersion_53`(moc3 5.3.00+)。
   已 vendor **Cubism SDK for Web 5-r.5**(Core 版本 **06.00.0001**,2026-01-08 起支持),
   vendor 详情见 `vendor/live2d/README.md`;若换用更老的 Core 会报 `moc3 unsupported`。
2. **Pixi v8 不兼容 `@pixi/live2d-display`**(插件锁 v6/v7 且已不维护)。运行时走
   **官方 Cubism SDK for Web + 独立 canvas 自绘**(见 doc/08 §4)。
3. **物理接线**:`PhysicsSetting1 后发` ← `ParamAngleX`,`PhysicsSetting2 后发上下` ←
   `ParamAngleY`,输出统一写 `ParamBackHairUp/Down/Swing`——头部角度变化即触发后发摆动,零代码。
4. **model3.json 的 EyeBlink / LipSync 组当前为空**:SDK 自动眨眼已由运行时显式注入
   `ParamEyeLOpen/ROpen` 绕过(0018),不再依赖该组;LipSync(口型)仍待表情里程碑。
   若想在编辑器侧也生效,把 `ParamEyeLOpen/ROpen` 加进 EyeBlink 组再导出。
5. **嘴部参数已就绪(0037)**:模型已含 `ParamMouthOpenY`,LipSync/说话可直接驱动;
   口型动画素材(时间轴)待制作。
6. **`CombinedParameters` 只是编辑器 UX**(头部 XY 联动),运行时忽略。
7. **参数改名后必须整包重导(Model 导出)**:编辑器会自动同步 physics3.json 等所有引用,无需手改
   JSON——本次 8 个参数 + 1 个部件改名已按此流程完成并验证(`Param6/7/8` → `ParamBackHair*` 等)。
8. **拖动接线(0032)**:`PhysicsSetting5 上下拖动` ← `ParamDragY`,`PhysicsSetting6 左右拖动` ←
   `ParamDragX`。主进程在光标轮询(33ms)中采样窗口位置增量,renderer 归一化(-1..1)后写入
   这两个参数,物理系统输出尾巴(`ParamTailRoot/Tip`)、前发(`ParamHairSwayX/Y`)、后发
   (`ParamBackHairUp/Down/Swing`)的惯性摆动;停止拖动参数回中,摆动经 delay/mobility 自然衰减。

## 4. 后续里程碑的导出清单

做完对应内容后导出到本目录;**动画(motion3)走运行时直接加载**(见 §4.1),
不注册进 model3.json 也能播;exp3 / pose3 / HitAreas 仍需按表注册:

| 里程碑 | 导出文件 | 注册位置 | 状态 |
|---|---|---|---|
| 表情 | `*.exp3.json` | `FileReferences.Expressions` + 运行时按语义状态切换 | ⏳ 未制作 |
| 预设姿势 | `*.pose3.json` | `FileReferences.Pose` | ⏳ 未制作 |
| 动画 | `*.motion3.json` | 运行时 `MOTION_FILES` 映射直接加载(0037) | ✅ 摸头已接入 |
| 可点区域 | HitAreas | 写入 model3.json 的 `HitAreas`(点击检测运行时自写) | ⏳ 未制作 |

### 4.1 摸头反馈(0037,已接入)

- 素材:`Expression_pat_head.motion3.json`(3.83s,Loop=true —— 眯眼 + 闭眼 + 微笑 + 脸颊泛红)。
  以"表情动作"方式从动画时间轴导出,格式是 motion3(非 exp3)。
- 接入:`cubism-runtime.ts` 的 `MOTION_FILES` 注册逻辑名 → 文件名,`playMotion('pat-head')` 播放;
  SDK 5-r.5 的 `CubismMotion.create` **不读 json 的 Loop 字段**(create 内赋值被注释),运行时
  按 json `Meta.Loop` 显式 `setLoop`;motion 内部不做 load/save,只 set 有曲线的参数,
  插在每帧 load 之后、视角跟随之前 —— 只覆盖表情参数,不碰头部/眼珠视角。
- 触发:`create-live2d-animator.ts` —— idle(未工作)时**点击头部点击区**触发
  (`#pet-head-hit`,no-drag 透明圆)。**点击区位置优先取运行时按 model3.json HitAreas
  算出的精确坐标**(Name 含 "head" 的条目,画布归一化坐标 → 投影矩阵 → 屏幕,0037;
  **需在 Cubism Editor 里把 HitHeadArea 导出为 Hit Area** —— 当前素材未导出,回退
  "模型中心锚点上方 innerHeight×0.18、半径 52px"的估算);播放 PAT_PLAY_MS(4s,
  约一个循环)后淡出停止,期间再次点击续摸;状态离开 idle 立即淡出(`stopMotion`
  设 0.35s fadeOut,避免表情参数硬切跳变)。播放期间 `setAutoBlink(false)` 让眨眼
  让位(motion 接管眼睛)。素材未写 FadeInTime 时 SDK 默认 1.0s 渐入(看起来没反应),
  运行时压到 0.15s。
- **必踩坑:`CubismMotion.create` 后必须 `setEffectIds([], [])`**(0037 实测)——不调
  时 `_eyeBlinkParameterIds` 为 null,`doUpdateParameters` 首帧抛 `null.length`
  TypeError → 动画器 tick 崩溃、模型定格"完全静止"。本模型 EyeBlink/LipSync 组为
  空,传空数组即可;若素材加了 Effect 组,改为传 model3.json Groups 里的 Ids。
- `Expression_sad.motion3.json`(2.03s,Loop=true,带 `ParamTear` 眼泪)已导出但**未接入**,
  等状态机 sad 态映射时用(注册进 `MOTION_FILES` 即可)。

## 5. 待办 / 备忘

- [ ] 记录 **Cubism Editor** 版本(当前已知 SDK 5-r.5 / Core 06.00.0001,moc3 v6;编辑器版本未知)
- [ ] `assets/pet/README.md` 的 License 表补 Live2D 条目
- [x] `project file/` 移出 assets,避免打进安装包(0021;工程文件已移至仓库外 `C:\Users\wanyu\Desktop\projects\live2d\`)
- [x] 视角跟随运行时已接入(0015):`src/renderer/src/pet/live2d/cubism-runtime.ts`
