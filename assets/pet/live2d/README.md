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
| `project file/ds-pet.cmo3` | **Cubism Editor 工程文件(非运行时)** | 含备份 `ds-pet - 副本.cmo3`;不要被运行时加载 |

> `project file/` 是编辑器工程与备份,当前因 `publicDir = assets/` 会被拷进 `out/renderer`;
> 想省包体积时再移出 assets 或做打包排除,不影响功能。

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

### 手动 / 程序驱动
| ID | 含义 |
|---|---|
| `ParamTailSwing` | 尾巴上下晃动 |
| `ParamBreath` | 呼吸(与 SDK auto-breath 同名) |
| `ParamPupilSize` | 瞳孔收缩 |
| `ParamHairFront` / `ParamHairSide` | 前发 / 侧发摆动(可手动联动头部角度) |
| `ParamCheek` | 脸颊泛红 |
| `ParamBrowLAngle` / `ParamBrowRAngle` / `ParamBrowLY` / `ParamBrowRY` | 眉毛角度 / 上下 |

### 表情 / 说话(后续里程碑)
| ID | 含义 |
|---|---|
| `ParamEyeLOpen` / `ParamEyeROpen` | 眼睛开闭(眨眼) |
| `ParamEyeLSmile` / `ParamEyeRSmile` | 眼睛微笑 |
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
5. **当前没有嘴部参数(`ParamMouthOpenY` 等)**:talking 状态需先回编辑器补嘴部参数。
6. **`CombinedParameters` 只是编辑器 UX**(头部 XY 联动),运行时忽略。
7. **参数改名后必须整包重导(Model 导出)**:编辑器会自动同步 physics3.json 等所有引用,无需手改
   JSON——本次 8 个参数 + 1 个部件改名已按此流程完成并验证(`Param6/7/8` → `ParamBackHair*` 等)。

## 4. 后续里程碑的导出清单

做完对应内容后导出到本目录,并注册进 `ds-pet.model3.json`:

| 里程碑 | 导出文件 | 注册位置 |
|---|---|---|
| 表情 | `*.exp3.json` | `FileReferences.Expressions` + 运行时按语义状态切换 |
| 预设姿势 | `*.pose3.json` | `FileReferences.Pose` |
| 动画 | `*.motion3.json` | `FileReferences.Motions` |
| 可点区域 | HitAreas | 写入 model3.json 的 `HitAreas`(点击检测运行时自写) |

## 5. 待办 / 备忘

- [ ] 记录 **Cubism Editor** 版本(当前已知 SDK 5-r.5 / Core 06.00.0001,moc3 v6;编辑器版本未知)
- [ ] `assets/pet/README.md` 的 License 表补 Live2D 条目
- [ ] (可选)`project file/` 移出 assets,避免打进安装包
- [x] 视角跟随运行时已接入(0015):`src/renderer/src/pet/live2d/cubism-runtime.ts`
