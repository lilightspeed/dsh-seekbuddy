# 0014 · Live2D 视角跟随 —— 动画器骨架 + 跟随核心逻辑 + SDK 接缝

## 状态

已验证(2026-08-17 typecheck 通过)

## 日期

2026-08-17

## 目的

Live2D 视角跟随里程碑第一步(doc/08 §6.2 的"骨架先行"策略):把动画后端切到 Live2D 的**接缝
全部铺好** —— 参数 ID 契约、视角跟随核心计算、SDK 运行时接口、`PetAnimator` 实现;
官方 Cubism SDK for Web 未 vendor 前,**应用行为零变化**(回落占位球宠)。

前提素材已入库(提交 `0b28385`):`assets/pet/live2d/` 模型 runtime 包 + 兼容性说明卡。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/src/pet/live2d/parameters.ts` | 新增:模型参数 ID 契约(`PARAM_HEAD/EYE/BODY/BACK_HAIR/MANUAL/EXPRESSION` + `ViewLook`),与 `ds-pet.cdi3.json` 一一对应 |
| `src/renderer/src/pet/live2d/view-follower.ts` | 新增:视角跟随核心逻辑(纯计算)—— 鼠标偏移 → 归一化目标 → 分通道平滑;死区防抖、幅度上限、禁用回中 |
| `src/renderer/src/pet/live2d/runtime.ts` | 新增:官方 Cubism SDK 唯一接缝 `Live2dRuntime` 接口 + `registerLive2dRuntime/getLive2dRuntime` 注册机制;附接入步骤注释 |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | 新增:`createLive2dAnimator(stage, opts)` —— 有 runtime 走 Live2D,无 runtime 回落 `createSpriteAnimator`;实现 `PetAnimator`(play/tick/dispose),含鼠标监听、模型异步加载、语义状态 → 跟随开关/自动眨眼 |
| `src/renderer/src/main.ts` | 一行切换:`createSpriteAnimator(stage)` → `createLive2dAnimator(stage)`(状态机/事件/UI 零改动) |
| `doc/changes/0014-live2d-view-follow-skeleton.md` | 本文 |

## 关键决策

1. **follower 与 runtime 之间用归一化 -1..1 作契约**。参数实际 min/max 只存在于 `.moc3`
   里(编辑器导出不带到 cdi3),所以归一化值由 `Live2dRuntime` 适配层查询参数范围后映射并 clamp。
2. **无 runtime 时回落 `createSpriteAnimator`**,不是空实现 —— 保证 SDK 未接入时应用与之前
   完全一致,`main.ts` 的切换因此无风险。
3. **`Live2dRuntime` 是唯一懂 SDK 的层**:`loadModel / update / setViewLook / setAutoBlink /
   playMotion / playExpression / dispose`。SDK 落地时新建 `cubism-runtime.ts` 实现该接口,
   模块加载时自注册,`createLive2dAnimator` 自动启用,主链路零改动。
4. **视角跟随默认开关 = `state !== 'thinking'`**("DSH 工作时不看鼠标");thinking 时目标清零、
   视线以 `recenterSpeed` 回中。
5. **分通道平滑(眼 12/s > 头 6/s > 身 3/s)+ 死区 24px + 幅度上限(眼 1.0 / 头 0.55 / 身 0.25)**
   用指数趋近(帧率无关),手感参数集中在 `ViewFollowerConfig`,真机再调。
6. **物理零代码**:`update()` 内 SDK 自动跑 physics3.json,后发随 `ParamAngleX/Y` 摆动
   (README §3.3 已验证物理接线)。

## 踩坑记录

- **`noUnusedParameters`(TS6133)**:`createLive2dAnimatorWithRuntime` 原本带 `stage` 参数,
  Live2D 路径实际用不到(canvas 由 runtime 自管)→ 直接移除参数,不是下划线妥协。
- 参考:模型 moc3 版本 = 6,需匹配较新 Cubism Core(已记入 `assets/pet/live2d/README.md` §3.1,
  本次未涉及 SDK 加载,无复测)。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck
# node + web 两个 tsc 配置均通过(仅 workspace 无关的 linux-arm64 平台 WARN)
```

运行时行为未变(SDK 未注册 → 回落球宠),真机验证待 SDK 接入后进行。

## 遗留 / 后续

- [ ] vendor 官方 Cubism SDK for Web(需从 live2d.com 下载 zip,许可页人工同意)+
      实现 `live2d/cubism-runtime.ts`(canvas 挂 #stage、resize/DPR、参数范围映射)
- [ ] 表情 / 姿势 / 动画 / HitAreas 素材与 `model3.json` 注册(README §4)
- [ ] 真机调 `ViewFollowerConfig`(死区 / 幅度 / 平滑),当前为默认值
- [ ] model3.json EyeBlink 组为空 → 自动眨眼待补组或运行时手动驱动
- [ ] talking 缺嘴部参数(`ParamMouthOpenY` 等),需回编辑器补
