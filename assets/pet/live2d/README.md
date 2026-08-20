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

> 语义以素材作者确认口径为准(0052):贴纸类参数 **0=隐藏/无,1=完整显示/全灭终点,中间值=部分状态或动效过程**,默认 0;样式切换类通过贴图隐藏/显示实现,不同值=不同贴图。

### 视角跟随(鼠标)
| ID | 含义 |
|---|---|
| `ParamAngleX` / `ParamAngleY` / `ParamAngleZ` | 头部角度(左右 / 上下 / 倾斜;working 素材驱动 ParamAngleY 低头、exclaim 点头) |
| `ParamEyeBallX` / `ParamEyeBallY` | 眼珠转动 |

### 物理驱动(仅由物理写入,运行时不手动设)
| ID | 含义 |
|---|---|
| `ParamBackHairUp` / `ParamBackHairDown` / `ParamBackHairSwing` | 后发上 / 下 / 上下摆动(Setting1/2 角度物理输出) |
| `ParamHairSwayX` / `ParamHairSwayY` | 前发摆动(Setting3/4 角度物理输出;拖动时 Setting5/6 亦输出,0036 重放恢复) |
| `ParamTailRoot` / `ParamTailTip` | 尾巴根部 / 尖端(Setting5/6 拖动输出) |

### 拖动反馈(运行时输入,物理演算输出 —— 0032)
| ID | 含义 |
|---|---|
| `ParamDragX` | 左右拖动宠物 —— 运行时按窗口水平位移写入,PhysicsSetting6 输入 |
| `ParamDragY` | 上下拖动宠物 —— 运行时按窗口垂直位移写入,PhysicsSetting5 输入 |

### 手动 / 程序驱动
| ID | 含义 |
|---|---|
| `ParamBreath` | 呼吸(与 SDK auto-breath 同名) |
| `ParamPupilSize` | 瞳孔收缩 —— **0 = 正常,1 = 缩到最小**(moc3 已核实 min=0/default=0/max=1)。运行时在空闲(视线跟随)时由"鼠标快速接近"驱动收缩、停驻后缓慢复原(0029) |
| `ParamBrowLAngle` / `ParamBrowRAngle` / `ParamBrowLY` / `ParamBrowRY` | 眉毛角度 / 上下 |

### 表情 / 说话
| ID | 含义 |
|---|---|
| `ParamEyeLOpen` / `ParamEyeROpen` | 眼睛开闭(眨眼;motion 播放期间由 autoBlink=false 让位) |
| `ParamEyeLSmile` / `ParamEyeRSmile` | 眼睛微笑 |
| `ParamEyeForm` | 眼睛形状(1 = 笑眼/眯眼) |
| `ParamArmRChange` | 右手抬起(working 思考姿态) |
| `ParamTeasrs` | 眼泪,备用(当前无素材驱动;模型参数名 `ParamTeasrs`,旧代码/README 曾写作 `ParamTear`) |
| `ParamMouthOpenY` | 嘴部开合(LipSync/说话) |
| `ParamMouthFormOpen` | 张嘴时的嘴型(贴图隐藏/显示切换,不同值=不同嘴型) |
| `ParamMouthFormClose` | 闭嘴时的嘴型(同上) |
| `PartEyeMask` | 眼睛蒙版部件 |
| `Part2` | 隐藏的表情嘴 `mouth2.psd`(当前隐藏,"未找到对应图层"是预期,勿删) |

### 贴纸参数(0=隐藏/无,1=完整显示或动效终点,中间值=部分状态/动效过程;默认 0)
| ID | 含义 |
|---|---|
| `ParamBubbleEllipsis` | 思考气泡"点点走路":0=`___`(全灭),0→1 依次 `___→.__→.._→...→_..→__.→___`(首尾都是全灭,循环点衔接自然;0050 硬重启防中间态闪帧) |
| `ParamBubbleEllipsis2` | 思考气泡**底座**:0=隐藏,1=显示,默认 0(素材恒 1.0 = 气泡框常显) |
| `ParamAngry` | 愤怒贴纸(单贴图):0=不可见,1=可见(0052 澄清,非皱眉强度) |
| `ParamDizzy` | 眩晕贴纸:0.1→0.9 循环,与 BubbleEllipsis 同类贴纸动效 |
| `ParamSymbolExclamation` | 感叹号贴纸:0=隐藏,1=显示(exclaim 变体 1) |
| `ParamStickerLightbulb` | 灯泡贴纸:同感叹号(exclaim 变体 2) |
| `ParamSymbolZzz` | 睡觉 zzZ 贴纸:0→1 动效 `___→z__→zz_→zzz→_zz→__z→___` |
| `ParamSymbolQuestion` | 三个问号贴纸:动效同 Zzz |
| `ParamEmotionConfused` | 困惑表情贴纸:0=隐藏,1=显示(实现同 ParamAngry) |
| `ParamBreathSigh` | 叹气贴纸:0→1 先淡入后淡出,中段可见,1.0 已淡出完毕=隐藏 |

### 样式切换(贴图隐藏/显示,不同参数值=不同贴图)
| ID | 含义 |
|---|---|
| `ParamIrisStyle` | 虹膜样式切换(不同值=不同虹膜,dizzy 期间恒 0.65) |

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

- 素材:`Expression_pat_head.motion3.json`(3.83s,素材 Loop=true —— 眯眼 + 闭眼 + 微笑 + 脸颊泛红)。
  以"表情动作"方式从动画时间轴导出,格式是 motion3(非 exp3)。
- 接入:`cubism-runtime.ts` 的 `MOTION_FILES` 注册逻辑名 → 素材配置(含 loop),`playMotion('pat-head')` 播放;
  SDK 5-r.5 的 `CubismMotion.create` **不读 json 的 Loop 字段**(create 内赋值被注释),按配置
  `setLoop`;**摸头强制非循环**(见坑 3);motion 内部不做 load/save,只 set 有曲线的参数,
  插在每帧 load 之后、视角跟随之前 —— 只覆盖表情参数,不碰头部/眼珠视角。
- 触发:`create-live2d-animator.ts` —— idle(未工作)时**点击头部点击区**触发
  (`#pet-head-hit`,no-drag 透明**矩形**,与命中区域一致)。**命中判定优先用 HitArea 网格**:
  运行时按 model3.json HitAreas(旧格式 Id 引用 moc3 触碰检测网格 drawable)取顶点,
  经 `buildProjectionMatrix` 映射到屏幕做**射线法点包含测试**(`hitTestPoint`,最贴合
  轮廓);无网格回退新格式矩形坐标,再无则"锚点上方 0.18 窗口高 + 104px"估算。
  **网格每次按当前帧顶点重算**(0037:HitAreaHead 挂在变形器上,顶点随头部角度变化,
  缓存会与渲染错位 → overlay/命中区域跟随模型实际位置)。HitAreaHead 是 4 顶点矩形,
  包围盒即网格本身 → no-drag 区域 = 触发区域 = 模型上的 hitarea。
  Editor 流程:`建模 → 图形网格 → 创建触碰检测用途的图形网格` → 编辑纹理集 → 导出。
  动画**非循环播一遍(3.83s)自然结束 → 运行时检测队列清空自动平滑复位**;期间再次
  点击续摸(播放中幂等、已结束重新播放);状态离开 idle 立即停止(`stopMotion` =
  stopAllMotions + 表情参数**指数平滑拉回模型默认**,速度 10/s ≈0.3s 回归待机 ——
  **SDK fadeOut 拉向当前值而非默认值,会残留摸头表情,弃用**)。播放期间
  `setAutoBlink(false)` 让眨眼让位(motion 接管眼睛);复位时恢复。素材未写 FadeInTime
  时 SDK 默认 1.0s 渐入(看起来没反应),运行时压到 0.15s。
- **调试:设置面板"显示点击判定网格"**(0037,`pet.showHitMesh`)——打开后在宠物上叠
  加 SVG 多边形轮廓(每帧跟随网格顶点),用于核对命中范围与 Live2D Editor/Viewer 里
  的 hitarea 是否一致;无 hitarea 时画估算矩形。
- **必踩坑 1:`CubismMotion.create` 后必须 `setEffectIds([], [])`**(0037 实测)——不调
  时 `_eyeBlinkParameterIds` 为 null,`doUpdateParameters` 首帧抛 `null.length`
  TypeError → 动画器 tick 崩溃、模型定格"完全静止"。本模型 EyeBlink/LipSync 组为
  空,传空数组即可;若素材加了 Effect 组,改为传 model3.json Groups 里的 Ids。
- **必踩坑 2:表情停止后残留**(0037 实测)——每帧 save 快照已含 motion 写的表情值,
  SDK fadeOut 拉向"当前值"→ 摸头表情残留。停止/自然结束 = 立即清队列 + 运行时平滑复位
  (`expressionReset`,`EXPRESSION_PARAM_IDS` 覆盖摸头曲线 10 参 + ParamTear)。
- **必踩坑 3:loop 动画循环点跳变**(0037 实测)——摸头曲线首尾不一致(`EyeLSmile`
  0s=0 / 3.833s=1),loop 循环点处表情闪没重来(V2 correctEndPoint + loop fade-in
  只能平滑无法消除)。**摸头强制非循环**,播完自然结束自动复位,无循环点。
- `Expression_sad.motion3.json`(2.03s,Loop=true,带 `ParamTear` 眼泪)已导出但**未接入**,
  等状态机 sad 态映射时用(注册进 `MOTION_FILES` 即可;若曲线首尾一致可开 loop)。

## 5. 待办 / 备忘

- [ ] 记录 **Cubism Editor** 版本(当前已知 SDK 5-r.5 / Core 06.00.0001,moc3 v6;编辑器版本未知)
- [ ] `assets/pet/README.md` 的 License 表补 Live2D 条目
- [x] `project file/` 移出 assets,避免打进安装包(0021;工程文件已移至仓库外 `C:\Users\wanyu\Desktop\projects\live2d\`)
- [x] 视角跟随运行时已接入(0015):`src/renderer/src/pet/live2d/cubism-runtime.ts`
