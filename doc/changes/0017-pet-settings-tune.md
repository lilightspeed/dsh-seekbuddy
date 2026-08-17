# 0017 · Live2D 视角跟随调优 + 设置面板(位置/大小/手感)

## 状态

已验证(2026-08-17 typecheck + build 通过;手感待用户目视确认后微调)

## 日期

2026-08-17

## 目的

根据真机反馈修复/优化视角跟随,并把可调参数暴露到**设置面板**(持久化):

1. **上下反转**:鼠标在上方时宠物却向下看 → Y 通道取反(屏幕 y 向下,ParamAngleY 正向为抬头)。
2. **转动幅度远小于编辑器范围**:旧线性距离映射在窗口内最多只到满幅的 ~47%,再乘 0.55 头部幅度,
   实际只有 ±8° 左右 → 改为指数距离曲线 + 头部幅度默认提到 0.9。
3. **窗口外距离失效**:0016 把窗口外光标夹取到边缘,抹掉了距离信息 → 去掉夹取,原样透传,
   由指数曲线让窗口内外距离都持续影响视角。
4. **可调参数进设置面板**:宠物水平/垂直位置、显示大小、头部/眼珠/身体幅度、死区、跟随距离、
   跟手速度 —— 9 项,拖动实时生效并持久化到 config.json。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/shared/pet-config.ts` | 新增 `PetPetSettings`(9 项)+ `PetConfig.pet` + 默认值 + `PetConfigUpdate` 平铺 `pet*` 键 |
| `src/main/config.ts` | `update/load/cloneDefault` 支持 `pet` 段(范围收敛) |
| `src/main/index.ts` | `sanitizeConfigUpdate` 白名单 `pet*` 字段(范围 clamp) |
| `src/preload/index.ts` | `sanitizeConfigUpdate` 同步 `pet*` 字段(toFinite) |
| `src/renderer/index.html` | 设置 tab 新增「宠物(Live2D)」组(9 个滑块)+ CSS |
| `src/renderer/src/ui/panel.ts` | 宠物滑块绑定(input → 标签 + 120ms 防抖 `onPetSettingsChange`);`refreshSettings` 回填;`PanelHooks` 加 `onPetSettingsChange?` |
| `src/renderer/src/main.ts` | 启动应用持久化 `cfg.pet`;面板变更 → `setConfig` 落盘 → `animator.applyPetSettings(cfg.pet)` |
| `src/renderer/src/pet/animator.ts` | `PetAnimator` 加可选 `applyPetSettings?` |
| `src/renderer/src/pet/live2d/view-follower.ts` | 距离映射改指数曲线(`distanceScale`,不截断);Y 取反;默认头部幅度 0.9 / 死区 12 / 曲线尺度 320 |
| `src/renderer/src/pet/live2d/runtime.ts` | `Live2dRuntime` 加 `setAppearance` + `Live2dAppearance`(位置/大小) |
| `src/renderer/src/pet/live2d/cubism-runtime.ts` | 实现 `setAppearance`:视图矩阵 = scale(大小)× translate(位置);`resize` 拆分出 `rebuildView` |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | 持有 `petSettings`;`applyPetSettings` 就地覆盖 follower 配置(闭包共享对象)+ `runtime.setAppearance`;跟随锚点随位置设置移动;去掉 0016 的边缘夹取 |
| `doc/changes/0017-pet-settings-tune.md` | 本文 |

## 关键决策

1. **follower 配置就地覆盖**:`createViewFollower(config)` 的闭包持有 config 引用,
   `applyPetSettings` 用 `Object.assign` 改同一对象 → 实时生效,无需重建 follower(不丢平滑状态)。
2. **指数距离曲线 `t = 1 - exp(-(dist-dead)/scale)`**:不饱和截断,近处响应快、远处缓慢逼近满幅,
   窗口内外距离都持续影响;旧线性映射在窗口内永远到不了满幅是"幅度小"的主因之一。
3. **设置链路**:面板(renderer)→ `pet*` 扁平补丁 → preload toFinite → 主进程 sanitize(clamp)→
   存储合并落盘 → 返回完整配置 → renderer `applyPetSettings`。沿用了 0004/0010 的既有纪律。
4. **窗口外不再夹取**:0016 夹取解决了"跟随不动",但抹掉了距离;0017 去掉夹取,距离信息由曲线
   保留 —— 宠物在窗口外也能根据鼠标远近/方向调整视角。
5. **跟手速度 = 平滑速度倍数**:`response` 乘到眼/头/身平滑与回中速度,单一滑块即可整体调快慢。

## 踩坑记录

- **夹取与距离的矛盾**:0016 的边缘夹取(为修复不动)会把所有窗外点映射到同一边缘 → 窗外距离失效;
  修复"不动"的根是主进程轮询,夹取本身可以去掉 —— 两者要拆开看,不能一起保留。
- **`PetAnimator` 加可选方法而非必选**:占位/贴图后端不实现,`main.ts` 用 `?.` 调用,接口零破坏。
- 导入路径:`pet/animator.ts` 引用 shared 是 `../../../shared/…`(三级),少一级会 TS2307。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

待用户目视:Y 方向正确、幅度明显变大、窗外移动鼠标宠物持续跟随、设置面板 9 项实时生效并重启后保留。

## 遗留 / 后续

- [ ] 用户按手感微调默认值(当前:死区 12px / 距离 320px / 头 0.9 / 眼 1.0 / 身 0.35 / 速度 1.0)
- [ ] (可选)设置面板折叠/分组样式优化
