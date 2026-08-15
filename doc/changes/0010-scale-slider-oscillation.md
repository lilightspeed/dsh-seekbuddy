# 0010 · 修复:缩放滑块拖拽反馈回路 —— 滑块来回跳 10%、窗口不断缩放

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:阶段 5 遗留修复(设置页缩放滑块)

---

## 目的

修复阶段 5 设置页的缩放滑块缺陷:鼠标**不动**时,滑块会在约一个 step(10%)的范围内**来回跳动**,导致窗口不断缩放。这是 0009 引入实时缩放预览后的反馈回路 bug。

## 根因

```
用户拖拽滑块 → input 事件 → (防抖 120ms) setConfig({scale}) 
  → 主进程 applyAppearance → window.setBounds(按 scale 缩放窗口)
  → 滑块元素宽度随窗口变化(面板 left:8 right:8,占满窗口宽)
  → Chromium 在"拖拽进行中"把静止的指针位置按【新的滑块宽度】重新映射出新的 value
  → 又触发一次 input → setConfig({scale: 新值}) → 窗口再缩放 → 滑块再变宽/变窄 …
```

回路方向:scale 调大 → 窗口变宽 → 滑块变宽 → 同一指针位置映射出**更小**的 value → 窗口变窄 → 滑块变窄 → 映射出**更大**的 value → ……,每次差一个 step(缩放滑块 step=10),形成"10% 来回跳、窗口不断缩放"的稳态振荡。鼠标没动,是**几何变化驱动 Chromium 重算 value**,不是重复的鼠标事件。

## 改动

| 文件 | 改动 |
|---|---|
| `src/renderer/src/ui/panel.ts` | 缩放滑块改为 **input 只更新数值标签,change(松手)才 setConfig** 并回填生效值;透明度滑块保留实时预览但**独立防抖定时器**(原共享一个 timer,两个滑块会互相取消对方的待应用);`refreshSettings` 对两个滑块都加 `document.activeElement` 守卫(交互中不回填,防打断) |

关键点:缩放改为松手应用后,**拖拽期间窗口尺寸不再变化 → 滑块几何恒定 → Chromium 没有重算触发条件 → 回路被切断**。透明度不改窗口尺寸,无此反馈,保留实时预览。

## 关键决策

1. **松手应用(change)而不是"拖拽中实时缩放"**:虽然实时预览体验更好,但该反馈回路是 Chromium range input 的固有行为(拖拽中元素几何变化会重映射指针),与其对抗不如错开时机;数值标签仍实时反馈,交互损失最小。
2. **主进程侧的幂等守卫仍在**(`next.scale !== prev.scale` 才 setBounds):即使 change 在同值上触发,也不会做无谓的窗口缩放。
3. 顺手修了共享 timer 的隐患(opacity 与 scale 各自独立的防抖)。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- `pnpm --filter @deepseek-ai/dsh-pet run build` ✅
- 重新打包 NSIS + portable(dist 产物含修复)✅
- 逻辑验证:拖拽期间不再有任何 setConfig(只更新标签),松手后单次 setConfig → 单次 setBounds;滑块值与配置一致(60–150 整数值,无 clamp 漂移)
- 视觉确认需用户在 dev(`pnpm --filter @deepseek-ai/dsh-pet run dev`)或打包版里拖一下滑块:松手窗口缩放一次、滑块不再来回跳

## 遗留 / 后续

- 若以后想恢复"拖拽中实时缩放",可用"滑块固定像素宽 + max-width"方式让几何恒定(拖拽期窗口变化不影响滑块宽度),但会在小窗口(scale < ~66%)时退化为宽度受限;当前松手应用方案更稳,暂不引入。
