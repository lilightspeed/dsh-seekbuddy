# 0018 · 实现自动眨眼 + 确认自动呼吸(运行时显式注入眨眼参数 ID)

## 状态

已验证(2026-08-17 typecheck + build 通过;目视确认眨眼/呼吸可见性)

## 日期

2026-08-17

## 目的

补上宠物"活过来"的最后两块自动效果:

1. **自动眨眼**:此前 model3.json 的 EyeBlink 组为空,SDK 按组创建眨眼失败 → 运行时
   `CubismEyeBlink.create()` 显式注入 `ParamEyeLOpen/ParamEyeROpen` 绕过,`setAutoBlink` 真正生效。
2. **自动呼吸**:呼吸其实已接线(0015),本次核对公式并微调周期,让 `ParamBreath` 以
   0..1 满幅、周期 ~3.2s 摆动;可见性取决于模型里 ParamBreath 是否绑了可见变形。

顺带回答两个"为什么"(不改代码):

- **ParamAngleZ 未用**:视角跟随只把 2D 光标点映射为偏航(X)与俯仰(Y);翻滚(Z)没有自然的
  单点来源,`view-follower` 里 `headZ` 恒为 0。若想要,可映射鼠标水平速度或待机随机摆动,属设计取舍。
- **身体幅度滑块无效果**:代码侧已接通(`bodyX = nx·bodyMax → ParamBodyAngleX`,滑块改的就是
  写入值);看不到变化说明模型里 `ParamBodyAngleX` 没有绑定可见的身体变形(或绑定极其轻微)——
  属于模型侧 rigging 问题,不是代码问题。可在 Cubism Editor 里手动拖 ParamBodyAngleX 验证。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/src/pet/live2d/cubism-runtime.ts` | 新增 `CubismEyeBlink`(显式 `setParameterIds` + 间隔 3.5s)+ `CubismEyeBlinkUpdater`(用 `motionUpdated` 回调做 `setAutoBlink` 门控);呼吸周期 3.2345 → 3.2;就绪日志加眨眼/呼吸状态;dispose 释放眨眼 |
| `assets/pet/live2d/README.md` | §3.4 更新:眨眼已由运行时显式注入绕过空组;LipSync 仍待表情里程碑 |
| `doc/changes/0018-blink-breath.md` | 本文 |

## 关键决策

1. **用 updater 的 `motionUpdated` 回调做眨眼开关**:`CubismEyeBlinkUpdater(motionUpdated, eyeBlink)`
   在 `!motionUpdated()` 时才眨眼 → 传入 `() => !this.autoBlink`:`setAutoBlink(true)`(待机)眨眼,
   `false`(thinking)停眨。零额外状态机,复用 SDK 机制。
2. **不依赖 EyeBlink 组**:组为空是模型导出配置问题(README §3.4),运行时显式注入 ID 即可,
   无需重导模型;编辑器侧补组仅为了与 SDK 标准流程对齐,可选。
3. **呼吸仍只驱动 ParamBreath**:公式 `offset + peak·sin(2πt/cycle)`(cycle 为周期秒),
   0.5±0.5 满幅、周期 3.2s;不碰头部角度,避免与视角跟随抢参数(呼吸在调度器里晚于 setViewLook 执行,会覆盖头部)。
4. **身体幅度不动代码**:确认写入链路完好后,把"看不见"归因于模型 rigging,不给代码打补丁
   掩盖模型问题(用户已确认本问题先不解决,仅解释)。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

待目视:待机时宠物应周期性眨眼(~3.5s 一次)并随 ParamBreath 呼吸;thinking 时停眨。
若呼吸不可见,在 Cubism Editor 拖 ParamBreath 确认是否绑了可见变形。

## 遗留 / 后续

- [ ] 目视确认;若呼吸不可见 → 编辑器补 ParamBreath 的可见绑定(模型侧)
- [ ] LipSync(口型)待表情/TTS 里程碑(model3.json LipSync 组同样为空)
- [ ] (可选)ParamAngleZ 用法(待机随机摆头/鼠标速度联动)待设计
