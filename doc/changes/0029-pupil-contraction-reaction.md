# 0029 · 瞳孔收缩反应:鼠标快速接近宠物时受惊缩瞳

## 状态

草稿(2026-08-17 typecheck + 逻辑仿真通过;待真机目视确认后改"已验证")

## 日期

2026-08-17

## 目的

Live2D 角色已有 `ParamPupilSize`(瞳孔收缩)参数(0 = 正常,1 = 缩到最小),但运行时从未驱动它。
本次实现:宠物**空闲(视线跟随鼠标)时**,鼠标以足够快的速度**接近**宠物 → 瞳孔快速收缩,
接近停止/远离后缓慢复原 —— 形成"突然逼近 → 受惊缩瞳 → 缓缓复原"的拟真神态。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/src/pet/live2d/parameters.ts` | `ViewLook` 增加 `pupilContract: number`(0..1;结构里唯一 0..1 通道,其余 -1..1) |
| `src/renderer/src/pet/live2d/view-follower.ts` | 瞳孔反应核心:径向接近速度检测 + 低通滤波 + 不对称平滑;`ViewFollowerConfig` 增加 `pupilSensitivity/Max/Attack/Release`(可选,缺省取 DEFAULT);`setEnabled(false)` 复位速度状态 |
| `src/renderer/src/pet/live2d/cubism-runtime.ts` | `ParamIndexSet` 增加 `pupil`;加载时缓存 `ParamPupilSize` 索引;`applyViewLook` 内用 `setParam` 写入(归一化 0..1 线性映射) |
| `src/renderer/src/pet/live2d/runtime.ts` | `setViewLook` 注释同步(瞳孔通道 0..1) |
| `assets/pet/live2d/README.md` | §2 手动/程序驱动补充瞳孔反应行为说明 |
| `doc/changes/0029-pupil-contraction-reaction.md` | 本文 |

### 未改动(设计使然)

- `create-live2d-animator.ts`:零改动 —— 瞳孔随 `follower.look()` 并入 `ViewLook`,经既有
  `runtime.setViewLook()` 链路写入;跟随启用(非 thinking)即生效,thinking 自动回落。
- `sprite-animator.ts`(占位后端):不消费 `ViewLook`,不受影响。
- 设置面板 / pet-config:未加新滑块(手感默认值已合理,待用户目视后按需微调)。

## 关键决策

1. **触发量 = 径向接近速度,而非整体速度或距离**。每帧计算 `(上一帧距离 - 当前距离)/dt`(正 = 接近),
   排除了"鼠标在宠物旁快速横向掠过(切向快、径向 0)"与"快速远离"两种误触发;
   也排除了"鼠标停在宠物脸上不动"(无接近速度,瞳孔反而缓慢复原)。
2. **门控 = follower 启用状态**:`shouldFollow = state !== 'thinking'`,即"未进行任务/视线跟随鼠标时"。
   thinking 期间 `setEnabled(false)` → 瞳孔目标归零、经 release 回落,不会在工作时继续缩瞳。
3. **低通滤波在前,不对称平滑在后**。主进程 33ms 轮询光标 + renderer 60fps 帧推进,原始径向速度呈
   30Hz 的 `[0, 2×真实速度]` 交替 —— 先以 `PUPIL_SPEED_FILTER=12/s` 低通收敛到接近真实接近速度
   (稳态 ≈ 0.9×),再以 **attack=14/s 起效、release=1.8/s 回落** 的不对称指数平滑输出:
   起效约 0.2s 内到位,回落约 2s 复原,符合"受惊 → 缓缓放松"。
4. **死区内目标归零**:鼠标进入 12px 死区后视角目标本就防抖归零,瞳孔目标同步归零 ——
   接近阶段已把收缩"打进"currentPupil,停驻在宠物脸上时按 release 自然复原,不会因为贴脸而持续缩瞳。
5. **参数映射直接复用 `setParam` 归一化通道**:已从 `ds-pet.moc3` 二进制解析核实
   `ParamPupilSize` min=0 / max=1 / default=0(与 cdi3 顺序对齐,索引 10),
   归一化 0..1 经 `def + norm×(max-def)` 线性映射 = 参数原值,0=正常、1=缩到最小,无需特判。
6. **瞳孔手感参数可选(缺省取 DEFAULT)**:`toFollowerConfig`(设置面板链路)只就地覆盖跟随手感字段,
   瞳孔字段用 `??` 取创建时配置,不破坏 `Object.assign` 就地更新机制,也不必为此给面板加滑块。

## 踩坑记录

- **moc3 参数范围无法从运行时探针读取**:Core 是 wasm(本仓库无 .wasm 文件,由浏览器运行时加载),
  无法在 Node 里跑 SDK 查参数。改为直接解析 moc3 二进制:参数数据按"列"存储 ——
  max 数组(0x3F40 起) → min 数组(0x3FC0 起) → default 数组(0x4040 起),各列 64 字节对齐,
  参数 ID 字符串区(0x38C8 起)每项 64 字节定长;依 cdi3 顺序对齐后确认
  `ParamPupilSize`(索引 10)= min 0 / max 1 / default 0。
- **验证脚本首版误报**:五个场景共享同一 follower,前一个场景遗留的 `prevDist/closingSpeed`
  污染后一个场景(快速接近首帧无历史、慢速接近读到上场景的陈旧距离)→ 结果颠倒。
  改为每个场景新建 follower + 静止预热建立距离历史后,行为符合预期。
- **低通收敛值 ≠ 手算值**:光标"每 2 帧一个样本"的 30Hz 交替信号,低通稳态不是简单平均
  (约 0.9×真实速度,与采样占空比/滤波速率相关),验证以仿真输出为准,不做手算精确断言。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
```

逻辑仿真(tsx 直跑 `view-follower.ts`,60fps 帧推进 + 30Hz 光标采样):

| 场景 | 输入 | pupilContract 峰值/走势 | 判定 |
|---|---|---|---|
| 快速接近 | 3000px/s,dist 800→50 | 峰值 0.993 | ✓ 接近满缩 |
| 停驻死区 5s | dist 4 | 0.72 → 0.17(0.5s)→ 0.003(2s)→ 0(4.5s) | ✓ 缓慢复原 |
| 慢速接近 | 100px/s,dist 800→200 | 峰值 0.127 | ✓ 低速不明显 |
| thinking(禁用) | 3000px/s 接近 | 峰值 0.000 | ✓ 不触发 |
| 重新启用后静止 | 3s 不动 | 峰值 0.000 | ✓ 无虚假触发 |
| 快速远离 | 3000px/s 远离 | 峰值 0.000 | ✓ 径向方向敏感 |

待用户真机目视:快速甩鼠标到宠物脸上瞳孔骤缩、停住后 1~2s 缓缓复原;
正常移动/远离/thinking 时无异常缩瞳。

## 遗留 / 后续

- [ ] 真机目视后按手感微调默认值(当前 sensitivity=600px/s、attack=14/s、release=1.8/s)
- [ ] (可选)若想把灵敏度做成设置面板滑块,需在 `PetPetSettings` 加字段并走 0017 的平铺链路
- [ ] (可选)后续表情里程碑(exp3)若接管瞳孔,注意与本次运行时写入的优先级
