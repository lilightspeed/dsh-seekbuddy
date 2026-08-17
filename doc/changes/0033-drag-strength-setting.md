# 0033 · 设置面板:拖动反馈强度滑块

## 状态

草稿(2026-08-18 typecheck + build 通过;待真机拖动目视确认后改"已验证")

## 日期

2026-08-18

## 目的

0032 落地拖动物理反馈后,效果强度固定(常量 `DRAG_FULL_TRAVEL` / `DRAG_SMOOTHING`)。
用户要求把强度做成可调项:在设置页「宠物(Live2D)」组加「拖动反馈强度」滑块,
0% = 关闭拖动反馈,100% = 0032 默认效果,实时生效并持久化。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/shared/pet-config.ts` | `PetPetSettings` 新增 `dragStrength`(0..1,默认 1);`PetConfigUpdate` 新增 `petDragStrength` |
| `src/main/config.ts` | `update()` / `load()` 对 `petDragStrength` clamp 0..1(旧配置无该字段时保持默认 1) |
| `src/main/index.ts` | `sanitizeConfigUpdate` 放行 `petDragStrength`(clamp 0..1) |
| `src/preload/index.ts` | `sanitizeConfigUpdate` 用 `toFinite` 收敛 `petDragStrength` |
| `src/renderer/index.html` | 「宠物(Live2D)」组新增「拖动反馈强度」滑块行(0..100,step 5);hint 文案补充拖动反馈 |
| `src/renderer/src/ui/panel.ts` | 绑定 `#pet-drag` / `#pet-drag-val`:回填、标签刷新、`petPatchFromSliders` 全量 11 项、加入 `petSliders`(走既有 120ms 防抖实时链路) |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | `applyPetSettings` 收敛 `dragStrength`(clamp01);拖动归一化目标乘 `dragStrength`(0 = 无反馈) |
| `doc/changes/0033-drag-strength-setting.md` | 本文 |
| `doc/changes/0032-drag-physics-feedback.md` | 状态改「已验证」(用户真机确认),补充验证结果 |

### 未改动(设计使然)

- 主进程光标轮询 / `pet:cursor` 事件 / `Live2dRuntime.setDrag`:拖动位移采样链路不变,
  强度只做 renderer 侧乘法,物理输入范围仍是满行程 ±1。
- `assets/pet/live2d/README.md`:参数契约未变,无更新。

## 关键决策

1. **强度 = 0..1 幅度比例,乘在归一化拖动目标上**:0 = 完全关闭,1 = 0032 默认满强度。
   与 `headAmplitude` / `pupilMax` 等 0..1 幅度字段同语义,UI 显示百分比。
   不做 >1 增强(需要改物理输入超程,不必要)。
2. **默认 1(保持 0032 现状)**:升级后老用户配置无 `dragStrength` 字段 → `load()` 合并默认值 1,
   行为与升级前完全一致,不会"升级后反馈变样"。
3. **滑块放「视线跟随鼠标时」合集外**:拖动反馈不是视线跟随行为,放进该 details 语义不符;
   放在外观区(水平/垂直位置/显示大小之后)独立一行,常驻可见。
4. **沿用既有 pet* 配置链路**:扁平 pet 键 + 主进程 clamp + preload toFinite + 120ms 防抖,
   与其余 10 个宠物滑块完全一致,零新机制。

## 踩坑记录

- 无(纯"字段 + 滑块"扩展,模式与 0030 瞳孔滑块完全一致)。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

待用户真机:设置页「宠物(Live2D)」组显示「拖动反馈强度」滑块,默认 100%;
拖到 0% 后拖动窗口宠物无摆动反馈,调高恢复并实时生效;重启后强度保持。

## 遗留 / 后续

- [ ] 若希望强度 >1(超程增强),可放开范围为 0..200% 并放大 `DRAG_FULL_TRAVEL` 之外的输入,
      当前无此需求。
