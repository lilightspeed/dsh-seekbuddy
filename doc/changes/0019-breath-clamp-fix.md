# 0019 · 修复:自动呼吸不可见 —— 加算型更新器的 load/save 节奏 + 呼吸 offset 校正

## 状态

已验证(2026-08-17 typecheck + build + 参数波形实测)

## 日期

2026-08-17

## 目的

用户反馈"没有任何呼吸效果"。两个叠加的根因:

1. **`CubismBreath` 是"加算型"更新器**:`addParameterValueById(id, v)` = 在当前值上加
   `v`(见 cubismmodel.ts)。我们的 `update()` 没有官方示例的 `loadParameters → saveParameters`
   节奏,呼吸值每帧累加,被参数 clamp 钉死在最大值 —— 波形完全被吞掉。
2. **offset 与基准叠加偏移**:`ParamBreath` 模型默认值(基准)是 0.5,我们设了 offset=0.5,
   最终值 = 基准0.5 + 0.5 + 0.5·sin = `1.0 + 0.5·sin`,上半截全被 clamp 削顶(波形实测:
   大部分时间钉在 1.000,只在下半周短暂下探)。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/src/pet/live2d/cubism-runtime.ts` | `update()` 增加官方示例的帧节奏:`loadParameters → 写跟随参数 → saveParameters → 调度器 → model.update`;`setViewLook` 改为暂存、由 `update()` 在 load 后/save 前写入;呼吸参数 offset 0.5 → 0(最终 0..1 干净摆动) |

## 关键决策

1. **复刻官方示例的 load/save 节奏**:把"调度器效果"(呼吸/眨眼/物理输出)限制在单帧内,
   每帧从基准重算 —— 加算型更新器不再跨帧累积。跟随参数写入放在 load 与 save 之间
   (正是示例里 motion 更新的位置),既不会被 load 冲掉,又对调度器可见(物理能读到本帧头部角度)。
2. **呼吸 offset 归零**:既然基准 = 模型默认值 0.5,`offset=0, peak=0.5` 即可得到 `0.5±0.5 = 0..1`。
3. **`setViewLook` 语义从"立即写"改为"暂存"**:模型写入时机统一收敛到 `update()` 内,
   避免在 loadParameters 前写入被冲掉。

## 踩坑记录

- **"加算型"更新器**:`addParameterValueById` 是 `current + value`(再 clamp),不是覆盖写。
  没有 load/save 节奏时,正弦正半周把参数推到 max 并钉死 —— 波形实测(1Hz 采样)大部分是 1.000。
- **基准值≠0**:`ParamBreath` 默认值 0.5,offset 必须按"基准 + offset + peak·sin"反推,
  否则偏移。修复后波形实测:`0.598 → 0.906 → 0.075 → 0.426 → 0.984 → …`,周期 ~3.2s,峰 ~0.99 谷 ~0.00。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

参数波形实测(临时日志,已删除):ParamBreath 在 0..1 按 ~3.2s 周期正弦摆动 —— 呼吸参数级确认生效。
眨眼(直接 set,不受影响)与物理(输出 set,且能读到本帧头部角度)在 load/save 节奏下均正常。

## 遗留 / 后续

- [ ] 目视确认呼吸可见;若仍不可见 → 模型里 ParamBreath 未绑可见变形(与身体幅度同源,模型侧)
- [ ] 呼吸参数(周期/幅度)后续可进设置面板
