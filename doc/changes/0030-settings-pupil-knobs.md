# 0030 · 设置面板:删除"身体幅度",新增瞳孔缩放(灵敏度/收缩幅度)

## 状态

草稿(2026-08-17 typecheck + build + 逻辑仿真通过;待真机目视确认后改"已验证")

## 日期

2026-08-17

## 目的

0029 实现瞳孔收缩反应后,用户希望手感可调:

1. **删除**设置面板「宠物(Live2D)」里的「身体幅度」滑块(身体跟随幅度不再暴露,走默认值);
2. **新增**瞳孔缩放的可调参数:瞳孔灵敏度(接近速度阈值)+ 瞳孔收缩幅度(最大收缩量)。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/shared/pet-config.ts` | `PetPetSettings` 删 `bodyAmplitude`,加 `pupilSensitivity`(px/s)/`pupilMax`(0..1);默认 600 / 1;`PetConfigUpdate` 同步(`petBodyAmplitude` → `petPupilSensitivity`/`petPupilMax`) |
| `src/main/config.ts` | `update()` / `load()` 删 bodyAmplitude,加 pupil 字段(clamp 200..2000 / 0..1) |
| `src/main/index.ts` | `sanitizeConfigUpdate` 白名单同步(范围收敛同上) |
| `src/preload/index.ts` | `sanitizeConfigUpdate` 同步(toFinite 收敛) |
| `src/renderer/index.html` | 设置面板删「身体幅度」行,加「瞳孔灵敏度(px/s)」「瞳孔收缩(%)」两行;hint 文案更新 |
| `src/renderer/src/ui/panel.ts` | 删 petBody 相关;加 petPupilSensitivity/petPupilMax 的查询/回填/补丁/标签;petSliders 数组更新(9→10 项) |
| `src/renderer/src/pet/live2d/view-follower.ts` | `bodyMax` 改为可选(缺省 DEFAULT 0.35);瞳孔参数从"创建时捕获"改为**使用时解析**(`resolve()` 回退 DEFAULT)—— 支撑设置面板 Object.assign 就地覆盖实时生效 |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | `toFollowerConfig` 不再输出 `bodyMax`(走默认),输出 `pupilSensitivity`/`pupilMax`;`applyPetSettings` 同步(删 bodyAmplitude,加 pupil 字段 clamp) |
| `doc/changes/0030-settings-pupil-knobs.md` | 本文 |

## 关键决策

1. **身体幅度删除后走默认 0.35**:`ViewFollowerConfig.bodyMax` 改可选,follower 内 `resolve('bodyMax')`
   回退 DEFAULT(0.35)—— 删除滑块 ≠ 删除联动,宠物身体仍随头部轻微摆动,只是不再可调。
2. **瞳孔参数改为使用时解析**:0029 把瞳孔配置在 `createViewFollower` 创建时捕获进局部常量,
   设置面板的 `Object.assign(followerConfig, toFollowerConfig(...))` 就地覆盖会失效。改为每帧
   `resolve(key) = config[key] ?? DEFAULT[key]`,设置面板拖动立即生效,与其它手感字段同一机制。
3. **灵敏度单位用 px/s 而非百分比**:语义是"接近速度达到该值 → 缩到 pupilMax",与「死区」「跟随距离」
   的 px 单位风格一致;滑块 200..2000 step 50,默认 600。
4. **新增两个而非一个滑块**:灵敏度(触发阈值)与收缩幅度(最大效果)是"瞳孔缩放"的两个正交轴,
   都暴露,用户可独立调节(如只想要轻微缩瞳 → 调低收缩幅度,不影响触发阈值)。

## 踩坑记录

- **验证脚本断言 body/head ≈ 0.35 失败**:实际稳态比值是 `bodyMax/headMax = 0.35/0.9 ≈ 0.389`
  (头部按方向向量 90%、身体按 35%,二者相对锚点同一方向)。行为正确,是断言写错了相对基准。
- **验证脚本对灵敏度 5000 的期望 0.12 失败**:接近速度低通后 ≈ 真实速度的 0.9×(≈2700px/s),
  目标 = 2700/5000 ≈ 0.54,并非 600/5000=0.12 —— 灵敏度是目标映射的分母,不是闭路值。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

逻辑仿真(tsx 直跑 follower,模拟 toFollowerConfig 不含 bodyMax 的配置):

| 检查 | 输入 | 输出 | 判定 |
|---|---|---|---|
| 默认灵敏度 600 | 3000px/s 快速接近 | 峰值 0.962 | ✓ 满缩 |
| bodyMax 缺省 | 稳态偏移 | body/head ≈ 0.389(= 0.35/0.9) | ✓ 走默认联动 |
| Object.assign 实时改灵敏度 5000 | 同上 | 峰值 0.493(< 0.7×0.962) | ✓ 实时生效 |
| Object.assign 实时改 pupilMax 0.5 | 同上 | 峰值 0.481 | ✓ 实时生效 |

待用户真机:面板拖动「瞳孔灵敏度/瞳孔收缩」即时看到反应变化并持久化重启保留;「身体幅度」行已消失。

## 遗留 / 后续

- [ ] 真机确认默认手感(灵敏度 600px/s、幅度 100%)是否合适,按需调默认值
- [ ] 0029 文档"未加设置面板滑块"的遗留项已由本步解决,后续若有其它手感字段(attack/release)
      可同法平铺进面板
