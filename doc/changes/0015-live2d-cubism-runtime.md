# 0015 · Live2D 视角跟随落地 —— vendor Cubism SDK for Web 5-r.5 + 独立 canvas 运行时

## 状态

已验证(2026-08-17 typecheck + build 通过;真机目视待 `pnpm dev`)

## 日期

2026-08-17

## 目的

把 0014 的 Live2D 接缝真正接通:vendor 官方 **Cubism SDK for Web 5-r.5** 进仓库,实现
`Live2dRuntime`(独立 WebGL2 canvas 自绘),让 ds-pet 模型以 Live2D 方式渲染 —— 鼠标视角跟随
(头部 + 眼珠 + 身体)+ 后发物理随头部角度摆动。应用默认启用 Live2D,不再回落球宠。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `vendor/live2d/Core/live2dcubismcore.d.ts` + `LICENSE.md` | 新增:Core 全局类型声明 + 专有许可 |
| `vendor/live2d/Framework/src/**`(59 文件) | 新增:官方框架 TS 源码(含 1 处补丁,见下) |
| `vendor/live2d/Framework/dist/**`(118 文件) | 新增:编译产物(ESM + d.ts),renderer 实际引用 |
| `vendor/live2d/Framework/tsconfig.build.json` | 新增:仓库内编译配置 |
| `vendor/live2d/Framework/LICENSE.md`、`LICENSE.md`、`NOTICE.md` | 新增:许可合规 |
| `vendor/live2d/README.md` | 新增:来源/版本/许可/再构建/升级步骤 |
| `assets/pet/live2d/core/live2dcubismcore.js` | 新增:Core 运行时(script 标签引入,全局 `Live2DCubismCore`) |
| `assets/pet/live2d/shaders/**`(12 个 .vert/.frag) | 新增:WebGL 着色器(renderer.loadShaders 拉取) |
| `src/renderer/index.html` | 模块脚本前加载 core(经典 script,先于 ESM) |
| `tsconfig.web.json` | 加 `@live2d/framework/*` 路径别名 + include Core d.ts |
| `electron.vite.config.ts` | renderer 加同名字 Vite 别名(指向 dist/src) |
| `src/renderer/src/pet/live2d/cubism-runtime.ts` | 新增:`Live2dRuntime` 实现 —— canvas/GL、异步加载(model3→moc→physics→纹理)、UpdateScheduler(物理+呼吸)、归一化参数写入、每帧渲染 |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | 无注入时自动 `createCubismRuntime`(WebGL2 失败才回落球宠) |
| `assets/pet/live2d/README.md` | 补 core/ 与 shaders/ 清单;§3.1 更新为 SDK 5-r.5 / Core 06.00.0001 支持 moc3 v6 |
| `doc/changes/0015-live2d-cubism-runtime.md` | 本文 |

## 关键决策

1. **SDK 版本锁定 Cubism SDK for Web 5-r.5(Core 06.00.0001)**:Core CHANGELOG 2026-01-08
   "Upgrade Core version to 06.00.0001";该 Core 的 `MocVersion_53 = 6`,正好匹配本模型
   moc3 格式版本 6(5.3.00+)—— 兼容性疑云彻底解除。
2. **Framework 以"编译产物 + d.ts"方式 vendor**:源码不进 renderer 的 strict typecheck
   程序(框架是 `strictNullChecks` 不兼容的老风格代码),产物经别名 `@live2d/framework` 引用。
   编译用**官方同版 TS 5.9.3**(TS 6 会额外报 TS2612/TS2345 等严格性/方差错误)。
3. **Core 走经典 script 标签**定义全局 `Live2DCubismCore`(EMScripten UMD,无 ESM 导出),
   置于模块脚本之前;shaders 作为静态资源放 `assets/pet/live2d/shaders/`,`loadShaders` 按路径拉取。
4. **不用官方 `CubismLook`**(SDK 自带视角跟随),继续用 0014 自研 `view-follower` 直接写参数:
   幅度/死区/平滑/跟随开关都归我们控制,且与状态机 gating 一致;官方 look 依赖 `_dragManager` 坐标约定,接入成本反而高。
5. **呼吸只驱动 `ParamBreath`**(不写头部角度),避免与视角跟随写头部参数打架。
6. **canvas `pointer-events: none`**:视角跟随走 window 级 `pointermove`,canvas 不拦截任何输入;
   后续点击热区(HitArea)里程碑再单独接 canvas 事件。
7. **模型加载是异步的,就绪前不绘制**(透明窗口);加载失败只 console.error,暂无回落
   (README §5 备忘;后续可加失败回落球宠)。

## 踩坑记录

- **TS 6.0.3 编译框架失败**:TS5011(rootDir 未显式)/ TS2612(`_gl` 覆盖基类字段)/
  TS2345(泛型构造器方差)。解法:改用官方同版 **TS 5.9.3**(`pnpm --package=typescript@5.9.3 dlx tsc`),
  仅剩 1 处 TS2612 → 给 `cubismoffscreenrendertarget_webgl.ts` 的 `_gl` 加 `declare`
  (运行时字段由基类提供;补丁已注释标注)。
- **框架必须关 `strictNullChecks`**:官方源码大量 `null` 初始化(`_moc = null` 赋给非空字段),
  官方 tsconfig 本就只开 `noImplicitAny`;照官方配置即可。
- **`exactOptionalPropertyTypes`**:给可选属性传 `undefined` 会报错 → `CubismRuntimeOptions.anchorRatioY`
  改必填,调用方 `?? 0.44` 兜底。
- **`noUnusedLocals/Parameters`**:只写不读的私有字段(TS6133)→ 删除或改造;
  构造函数里用不到的 `modelUrl` 参数直接删掉(loadModel 自带 url)。
- **`setRenderState` 的 fbo 可空**:默认帧缓冲绑定可能为 `null`(webgl 规范),框架 d.ts
  类型是非空 → `as WebGLFramebuffer` 断言(运行时传 null,框架按 lastFbo 语义处理,与官方示例一致)。
- 官方示例 `LAppModel` 用"子类化 CubismUserModel"访问 protected 成员 → 我们也建了
  `DsPetUserModel` 子类,仅暴露 `physicsHandle`。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0(node + web)
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0(renderer 774 modules,含框架)
# 产物核对:out/renderer/index.html 含 core script 标签;
# out/renderer/pet/live2d/ 22 个静态文件(core js + 12 shaders + 模型);
# 主 bundle 命中 "CubismFramework"(框架确实打包进产物)。
```

框架编译(vendor 再构建):

```powershell
pnpm --package=typescript@5.9.3 dlx tsc -p vendor/live2d/Framework/tsconfig.build.json  # 118 文件
```

## 遗留 / 后续

- [ ] **真机目视**:`pnpm --filter @deepseek-ai/dsh-pet run dev`,确认宠物出现、跟随鼠标、
      头部转动后发摆动;手感调 `ViewFollowerConfig`(死区/幅度/平滑)
- [ ] 记录 Cubism Editor 版本(README §5 备忘)
- [ ] 加载失败回落占位球宠(可选增强)
- [ ] 表情/姿势/动画/HitAreas 里程碑(README §4 导出清单;EyeBlink 组、嘴部参数待编辑器补)
- [ ] 自动眨眼:model3.json EyeBlink 组为空,现 setAutoBlink 为空实现(debug log)
