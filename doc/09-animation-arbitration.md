# 09 · 动画仲裁架构(Animation Director)

> **目标**:表情动画**同一时刻只播一个**(互斥);为后续**动作动画**(身体级:走路/跳跃/舞蹈等)预留可并存、可扩展的通道。
> **背景**:0037 系列接入摸头/sad 后,`CubismRuntime` 单一 motion 队列 + animator 手写互斥标志位,动画一多就会重叠。

## 1 问题现状

| # | 现状 | 后果 |
|---|---|---|
| 1 | `CubismRuntime` 只有一个 `CubismMotionQueueManager`,`playMotion('sad')` 在 'pat-head' 播放中时**往同一队列追加**第二条 motion | SDK 队列允许并行播,两条曲线同时驱动 `EyeLOpen`/`Cheek` 等同一批表情参数 → **动画重叠** |
| 2 | 动画元数据(`MOTION_FILES`:file/loop)埋在 runtime 内部 | 业务规则(谁能打断谁、幂等、按住冻结、复位)无处安放 |
| 3 | 仲裁逻辑散落在 `create-live2d-animator.ts` 的手写标志位(`patActive`/`holdActive`/`holdFrozen`/`patPlayMs`)与 `onPatDown`/`onBodyDown`/`applyState` 的 if/else 里 | 每加一个动画就要复制一套互斥代码,规则不一致,迟早互相踩 |

**根因一句话**:互斥规则不该由"调用方自觉"保证,也不该和 SDK 队列的并行语义裸奔 —— 需要一层**集中仲裁**,并由 runtime 在**物理上**保证同通道不并行。

## 2 设计总览:分层 + 通道

```
交互事件(摸头/sad/…)          状态机 PetState(idle/thinking/…)
        │                             │
        └──────────┬──────────────────┘
                   ▼
        ┌───────────────────────────┐
        │  AnimationDirector(新模块) │  ← 纯逻辑,无 SDK 依赖,可单测
        │  通道互斥 · 优先级仲裁      │
        │  打断/忽略 · 生命周期/复位  │
        │  Gate 状态门控            │
        └─────────────┬─────────────┘
                      ▼  playMotion(name, channel) / stopChannel / setMotionPaused
        ┌───────────────────────────┐
        │  Live2dRuntime(适配层接缝) │  ← 每通道独立 motion 队列
        │  只懂"播某个素材文件"       │     start 前先 stop 同通道(物理兜底)
        └───────────────────────────┘
```

- **Director 负责"该不该播"**(仲裁),**Runtime 负责"怎么播"**(素材、队列、参数复位)。两者职责互补,互斥在两层同时保证(见 §3.5)。
- Director 与 SDK 零耦合(只依赖 `Live2dRuntime` 接口),占位球宠/未来 Lottie 后端可共用同一套仲裁逻辑。

## 3 核心概念

### 3.1 通道 AnimationChannel

按"参数作用域"分通道,同通道互斥、跨通道并存:

| 通道 | 作用域 | 示例 | 规则 |
|---|---|---|---|
| `expression` | 脸部表情参数(眼/眉/嘴/腮红/眼泪) | 摸头、sad、开心 | **同一时刻最多一个** |
| `action`(预留) | 身体/位移类参数 | 走路、跳跃、舞蹈、挥手 | **同一时刻最多一个**;可与 expression 并存 |

> 为什么按参数作用域分而不是按"动画名"分:互斥的本质是**参数冲突**。摸头(sad)与走路(walk)参数不冲突 → 可并存;摸头与 sad 冲突 → 互斥。通道就是"冲突分组"。

### 3.2 动画描述符 AnimationSpec

```ts
export type AnimationChannel = 'expression' | 'action'

/** 动画注册表条目:一个逻辑动画的全部声明(元数据 + 仲裁参数 + 素材)。 */
export interface AnimationSpec {
  /** 逻辑 id,全局唯一,如 'pat-head' / 'sad' / 'walk'。 */
  id: string
  /** 所属通道:表情 vs 动作(未来)。 */
  channel: AnimationChannel
  /** 素材文件名(motion3.json,runtime 解析用)。 */
  file: string
  /** 是否循环;默认 false(素材曲线首尾对齐前一律非循环,见 0037)。 */
  loop?: boolean
  /** 优先级,默认 0;同通道内,新请求 priority > 当前正在播的才允许打断。 */
  priority?: number
  /** 同 id 重复请求:默认幂等忽略;true = 重置计时重播(续摸语义)。 */
  restartOnRepeat?: boolean
  /** 播放模式:one-shot 播完自动复位 / hold 按住冻结松开继续 / persistent 常驻待机表情。 */
  mode?: 'oneshot' | 'hold' | 'persistent'
  /** hold-end(0038,思考):非循环动画播完后**保持末尾姿态**,不复位不结束 —— 直到外部显式
   *  stopChannel。由 runtime 捕获曲线末帧参数持续恢复(防视角跟随/物理覆盖);导演因
   *  `isChannelActive` 持续为 true 而保留条目。**不要**同时设 durationMs(会兜底强停)。 */
  holdEnd?: boolean
  /** hold 模式的冻结时刻(秒,素材曲线上的"保持点",如摸头闭眼 0.45s)。 */
  holdAt?: number
  /** 兜底播放时长(ms);素材无自然结束信号时由 director 兜底 stop。 */
  durationMs?: number
  /** 播放期间是否允许自动眨眼;默认 true;摸头/sad 设 false(动画接管眼睛,0037g 坑由导演统一保证)。 */
  autoBlink?: boolean
  /** 未来:该动画要独占的其他通道(如"惊吓"全身动画要盖掉表情)。 */
  blocksChannels?: AnimationChannel[]
}
```

**单点配置**:现在的 `MOTION_FILES`(file/loop)并入 spec,`animation-registry.ts` 是唯一登记处 —— 新增动画只改这一处,仲裁/播放代码零改动。

### 3.3 仲裁规则(request)

`director.request(spec)` 的判定顺序(同通道内):

1. **Gate 检查**:所在通道被锁(如 thinking 状态锁 expression)→ 忽略(可选记 `pending`,解锁后补播,当前未实现)。
2. **同 id 已在播** → 幂等忽略;若 `restartOnRepeat: true` 且动画已自然结束(导演尚未清理)→ 立即重播(续摸语义)。
3. **同通道有别的动画**:
   - 新动画 `priority >` 当前 → **打断**:`stopChannel`(触发复位 + onEnd)→ 播新的。
   - 否则 → 忽略(可选排队,默认不排队)。
4. **跨通道** → 互不干扰,直接播(各通道独立队列)。
5. **blocksChannels**:播前先 stop 被 block 的通道(未来扩展)。

> 动画播放期间的自动眨眼由导演按 `spec.autoBlink` 接管:start 时关/开,结束(自然播完或被打断)统一恢复 true——0037g 的"续摸/重播不重关眨眼"坑在导演层根治,animator 不再手动调 `setAutoBlink`。

### 3.4 生命周期与 Gate

每通道一个生命周期,由 director 维护:

```
idle → starting → playing ⇄ frozen(hold 暂停) → ending(复位) → idle
```

- `starting`:等 runtime 异步解析素材;解析失败 → 直接回 idle。
- `playing`:每帧 tick 检查 `runtime.isChannelActive(channel)`,素材自然播完(队列空)→ `ending`。
- `frozen`:hold 模式按住冻结(`runtime.setMotionPaused(true)`),松开恢复。
- **hold-end 例外(0038)**:`holdEnd` 动画(思考)自然播完后 runtime 仍保持 `isChannelActive=true`
  (不清 currentMotion、不复位),姿态定格在曲线末帧 —— 生命周期停在 `playing`,直到 animator
  离开 thinking 显式 `stopChannel('action')` 才进 `ending` 复位。
- `ending`:`runtime.stopChannel(channel)` 内部做表情参数指数平滑复位(0037 已有的 `expressionReset` 机制保留在 runtime);完成后回调 `onEnd('finished' | 'interrupted')` → animator 借此恢复自动眨眼、清理交互状态。

**Gate(状态门控)**:`director.setGate(channel, locked)` —— 取代现在 `applyState` 里散落的 `next !== 'idle' → stopMotion()`。状态机 `play('thinking')` 时锁 expression 并 stop,回 idle 解锁。

### 3.5 两层互斥保证

| 层 | 机制 | 防什么 |
|---|---|---|
| 逻辑层(director) | 同通道最多一个 active spec;优先级仲裁 | 业务规则一致,不靠调用方自觉 |
| 物理层(runtime) | 每通道独立 `CubismMotionQueueManager`;`playMotion` 前先 `stopAllMotions()` 同通道 | 即使有人绕过 director 直接调 runtime,也**不可能并行** |

## 4 接口改造

### 4.1 `Live2dRuntime`(live2d/runtime.ts)

```ts
export interface Live2dRuntime {
  // …原有 loadModel/update/setViewLook/setDrag/setAppearance/setAutoBlink/getHeadPoint 等不变…

  /** 播动作:channel 指定通道(同通道 start 前强制 stop,物理互斥)。 */
  playMotion(name: string, channel: AnimationChannel): void
  /** 停止某通道当前动画(触发参数复位),取代旧 stopMotion()。 */
  stopChannel(channel: AnimationChannel): void
  /** 该通道当前是否有动画在播(结束/复位中返回 false)。 */
  isChannelActive(channel: AnimationChannel): boolean
  /** 暂停/恢复该通道 motion 时间推进(hold 模式用)。 */
  setMotionPaused?(paused: boolean): void
  /** 该通道当前动画已播秒数(hold 冻结时刻判定用)。 */
  getMotionElapsed?(channel: AnimationChannel): number
  /** 删除旧的单通道 playMotion(name)/stopMotion()。 */
}
```

### 4.2 `CubismRuntime`(live2d/cubism-runtime.ts)

- `motionQueue` → `Map<AnimationChannel, CubismMotionQueueManager>`;`currentMotionName` 同理按通道收窄。
- `playMotion(name, channel)`:查通道队列;**start 前 `stopAllMotions()` 同通道**(修掉重叠的直接手段)。
- `stopChannel(channel)`:stop + `beginExpressionReset()`(表情复位集合;未来动作通道可注入自己的复位参数集)。
- `update()` 里的"非循环播完自动复位"按通道轮询;`isFinished()` 判定后 `isChannelActive` 返回 false。
- `MOTION_FILES` 移出:构造选项接收 `motions: Record<string, { file: string; loop: boolean }>`(由 registry 注入)。

### 4.3 新模块 `animation-registry.ts`

```ts
/** 动画逻辑 id(新增动画扩展 union;索引访问不返回 undefined)。 */
type AnimationId = 'pat-head' | 'sad'

/** 全部动画的单点登记处(现在只有 expression;未来加 action)。 */
export const ANIMATIONS: Record<AnimationId, AnimationSpec> = {
  'pat-head': { id: 'pat-head', channel: 'expression', file: 'Expression_pat_head.motion3.json', mode: 'hold', holdAt: 0.45, durationMs: 4000, autoBlink: false },
  sad:       { id: 'sad', channel: 'expression', file: 'Expression_sad.motion3.json', priority: 1, durationMs: 3500, autoBlink: false },
  // 未来:walk: { id: 'walk', channel: 'action', file: 'Action_walk.motion3.json', loop: true },
}
```

> sad `priority: 1` > pat-head 默认 0 → 点击身体自动打断摸头,不再靠手写 if/else。

### 4.4 新模块 `animation-director.ts`(核心伪代码)

```ts
export function createAnimationDirector(runtime: Live2dRuntime) {
  /** 每通道当前活跃 spec(含进行中状态)。 */
  const active = new Map<AnimationChannel, ActiveEntry>()
  /** 每通道 gate 锁。 */
  const gates = new Set<AnimationChannel>()
  /** 监听器:onEnd(channel, id, reason) 供 animator 恢复眨眼/清理状态。 */
  const listeners = new Set<(e: { channel: AnimationChannel; id: string; reason: 'finished' | 'interrupted' }) => void>()

  function request(spec: AnimationSpec): void {
    const cur = active.get(spec.channel)
    if (gates.has(spec.channel)) return                        // 1. gate 锁
    if (cur?.spec.id === spec.id) {                            // 2. 同 id
      if (spec.restartOnRepeat && !runtime.isChannelActive(spec.channel)) start(spec)  // 已自然结束未清理 → 重播
      return                                                   //    幂等忽略
    }
    if (cur && (spec.priority ?? 0) <= (cur.spec.priority ?? 0)) return  // 3. 优先级不足 → 忽略
    for (const c of spec.blocksChannels ?? []) stopChannel(c)  // 5. 独占声明(未来)
    if (cur) stopChannel(spec.channel)                         //    打断旧的(含复位 + onEnd)
    start(spec)                                                // 4. 物理互斥由 runtime 兜底
  }

  function start(spec: AnimationSpec): void {
    active.set(spec.channel, { spec, frozen: false })
    runtime.setAutoBlink(spec.autoBlink ?? true)               // 动画接管/放行眨眼(0037g)
    runtime.playMotion(spec.id, spec.channel)
  }

  function setHold(channel: AnimationChannel, holding: boolean): void {
    const entry = active.get(channel); if (!entry) return
    if (holding) holdState.set(channel, true)                  // 按住:由 tick 到 holdAt 冻结
    else { holdState.set(channel, false); entry.frozen = false; runtime.setMotionPaused?.(false) }
  }

  function tick(): void {                                      // 无参:全部基于 elapsed 绝对时间
    for (const [channel, entry] of [...active]) {
      if (!runtime.isChannelActive(channel)) {                 // 素材自然播完(或加载失败)
        active.delete(channel); runtime.setAutoBlink(true); emit(channel, entry.spec.id, 'finished')
      } else if (entry.spec.mode === 'hold' && holdState.get(channel) && !entry.frozen &&
                 (entry.spec.holdAt ?? 0) > 0 && runtime.getMotionElapsed?.(channel) >= (entry.spec.holdAt ?? 0)) {
        runtime.setMotionPaused?.(true); entry.frozen = true   // 冻结到保持点
      } else if (!entry.frozen && entry.spec.durationMs && runtime.getMotionElapsed?.(channel) >= entry.spec.durationMs / 1000) {
        stopChannel(channel)                                   // 兜底时长到 → 停止复位(冻结期间不计时)
      }
    }
  }

  function stopChannel(channel: AnimationChannel, reason: 'interrupted' = 'interrupted'): void {
    const entry = active.get(channel); if (!entry) return
    active.delete(channel)
    runtime.stopChannel(channel)
    runtime.setAutoBlink(true)                                 // 结束统一恢复眨眼
    emit(channel, entry.spec.id, reason)
  }

  function setGate(channel: AnimationChannel, locked: boolean): void {
    locked ? gates.add(channel) : gates.delete(channel)
    if (locked) stopChannel(channel)                           // 锁 = 立即停
  }
}
```

## 5 与现状的映射(迁移路径)

| 现状 | 改造后 |
|---|---|
| `runtime.playMotion('pat-head')` + 手写 `patActive`/`patPlayMs`/`holdFrozen` | `director.request(ANIMATIONS['pat-head'])`;按住/松开 → `director.setHold('expression', on/off)`;是否正在摸头 → `director.isActive('pat-head')` |
| `runtime.playMotion('sad')` + 手写"打断摸头" | `director.request(ANIMATIONS['sad'])`,打断由优先级自动完成 |
| `applyState(next !== 'idle') → runtime.stopMotion()` | `director.setGate('expression', next !== 'idle')` |
| `MOTION_FILES`(runtime 内) | 并入 `ANIMATIONS`(registry 单点),runtime 构造时注入 `motions` 映射 |
| 表情复位 `expressionReset`(runtime 内) | 保留在 runtime(能力),由 `stopChannel` 触发(职责不变) |
| 摸头力度/锚点平滑(follower 层) | 留在 animator,只把"是否摸头中"改问 director |

落地顺序(每步独立可提交):

1. **runtime 接口 + cubism-runtime 改通道队列**(修掉重叠 bug,行为不变)。
2. **animation-registry.ts**:迁 `MOTION_FILES` + spec。
3. **animation-director.ts**:仲裁 + gate + 生命周期。
4. **create-live2d-animator.ts**:接入 director,删手写标志位。
5. `pnpm --filter @deepseek-ai/dsh-pet run typecheck` + 手动验证(见 §7)。

## 6 未来动作动画兼容性

- **新增动作** = registry 加一条 `channel: 'action'` 的 spec → 自动获得"同动作互斥 + 与表情并存",仲裁/播放代码零改动。
- **需要独占的表情的动作**(如"惊吓"全身动画):spec 加 `blocksChannels: ['expression']` → 仲裁规则 §3.3-5 自动 stop 表情通道。
- **涉及位移的动作**(如走路移动窗口):位移属于 animator/PetStage 层,由 director 的 `onStart`/`onEnd` 回调驱动,不进 runtime。
- 通道类型是 open union(`'expression' | 'action'`),未来要细分(如 `'ui'` 提示气泡动画)只需扩 union + registry 条目。

## 7 验收清单(落地后)

- [ ] 摸头播放中点击身体 → sad **立即接管**(不再两条表情同时动)
- [ ] sad 播放中再点身体 → 幂等(不重播、不闪烁)
- [ ] thinking 状态点击头部/身体 → 无反应;回 idle 后可正常触发
- [ ] 摸头按住冻结在闭眼帧,松开继续,播完表情平滑复位(无残留)
- [ ] `tsc --noEmit` 通过;占位球宠后端行为不变
