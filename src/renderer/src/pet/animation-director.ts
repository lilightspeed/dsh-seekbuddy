import type { AnimationChannel, Live2dRuntime } from './live2d/runtime.ts'

/**
 * 动画导演(doc/09)—— 集中仲裁"该不该播",与 SDK 零耦合(只依赖 Live2dRuntime 接口)。
 *
 * 职责:
 * - 同通道互斥:每通道最多一个 active 动画;跨通道(未来 action + expression)并存;
 * - 优先级仲裁:新请求 priority > 当前动画才允许打断,否则幂等忽略;
 * - 生命周期:starting → playing ⇄ frozen(hold) → ending,自然结束/打断均回调 onEnd;
 * - Gate 状态门控:锁定通道 = 立即停止 + 拒绝新请求(如 thinking 锁表情);
 * - autoBlink 接管:动画播放期间按 spec.autoBlink 关/开自动眨眼(0037g 续摸坑由导演统一保证)。
 *
 * 物理互斥(同通道 start 前 stop)由 runtime 兜底,见 Live2dRuntime.playMotion。
 */

/** 动画描述符:一个逻辑动画的全部声明(元数据 + 仲裁参数 + 素材)。 */
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
  /** 播放模式:oneshot 播完自动复位 / hold 按住冻结松开继续 / persistent 常驻待机表情。 */
  mode?: 'oneshot' | 'hold' | 'persistent'
  /** hold 模式的冻结时刻(秒,素材曲线上的"保持点",如摸头闭眼 0.45s)。 */
  holdAt?: number
  /** 兜底播放时长(ms);素材无自然结束信号时由导演兜底 stop。 */
  durationMs?: number
  /** 播放期间是否允许自动眨眼;默认 true,摸头/sad 设 false(motion 接管眼睛)。 */
  autoBlink?: boolean
  /** 未来:该动画要独占的其他通道(如"惊吓"全身动画要盖掉表情)。 */
  blocksChannels?: AnimationChannel[]
}

/** 动画结束/被打断的事件载荷。 */
export interface AnimationEndEvent {
  channel: AnimationChannel
  id: string
  /** finished = 素材自然播完(或兜底超时);interrupted = 被更高优先级/状态切换打断。 */
  reason: 'finished' | 'interrupted'
}

/** 动画导演接口(纯逻辑,便于测试注入)。 */
export interface AnimationDirector {
  /** 请求播放一个动画;是否生效由仲裁规则决定(幂等/打断/忽略)。 */
  request(spec: AnimationSpec): void
  /** hold 模式:按住/松开。按住时由 tick 在 holdAt 处自动冻结,松开立即继续。 */
  setHold(channel: AnimationChannel, holding: boolean): void
  /** 每帧推进:检测自然结束、hold 冻结、兜底超时(基于 runtime 的 elapsed 绝对时间,无需帧间隔)。 */
  tick(): void
  /** 状态门控:锁定 = 立即停止该通道动画 + 拒绝新请求;解锁恢复。 */
  setGate(channel: AnimationChannel, locked: boolean): void
  /** 指定动画是否正在播放(animator 判断交互状态用)。 */
  isActive(id: string): boolean
  /** 强制停止某通道动画(触发 interrupted 回调)。 */
  stopChannel(channel: AnimationChannel): void
  /** 订阅动画结束/打断;返回取消订阅函数。 */
  onEnd(listener: (e: AnimationEndEvent) => void): () => void
  dispose(): void
}

/** 活跃条目:正在播放(含异步加载中)的动画。 */
interface ActiveEntry {
  spec: AnimationSpec
  /** hold 模式已冻结(定格在保持帧)。 */
  frozen: boolean
}

/** 创建动画导演(runtime 未就绪/加载失败等异常由导演自愈:条目随 isChannelActive=false 清理)。 */
export function createAnimationDirector(runtime: Live2dRuntime): AnimationDirector {
  /** 每通道当前活跃动画(同通道最多一个)。 */
  const active = new Map<AnimationChannel, ActiveEntry>()
  /** 被锁定的通道:拒绝新请求,锁定瞬间停止已有动画。 */
  const gates = new Set<AnimationChannel>()
  /** hold 按住状态(每通道;仅 mode=hold 的动画有意义)。 */
  const holdState = new Map<AnimationChannel, boolean>()
  /** 结束/打断监听器。 */
  const listeners = new Set<(e: AnimationEndEvent) => void>()

  function emit(e: AnimationEndEvent): void {
    for (const listener of listeners) listener(e)
  }

  /** 停止某通道动画(若有):触发 interrupted 回调,恢复自动眨眼。 */
  function stopChannel(channel: AnimationChannel): void {
    const entry = active.get(channel)
    if (!entry) return
    active.delete(channel)
    holdState.delete(channel)
    runtime.stopChannel(channel)
    runtime.setAutoBlink(true)
    emit({ channel, id: entry.spec.id, reason: 'interrupted' })
  }

  function request(spec: AnimationSpec): void {
    // 1. Gate:所在通道被锁(如 thinking 锁表情)→ 忽略
    if (gates.has(spec.channel)) return
    const cur = active.get(spec.channel)

    // 2. 同 id 已在播:幂等忽略;restartOnRepeat 则确保在播(已自然结束则重播)
    if (cur?.spec.id === spec.id) {
      if (spec.restartOnRepeat && !runtime.isChannelActive(spec.channel)) {
        // 动画已自然结束但导演还没来得及清理 → 直接重播
        active.delete(spec.channel)
        holdState.delete(spec.channel)
        start(spec)
      }
      return
    }

    // 3. 同通道有别的动画:优先级不足 → 忽略
    if (cur && (spec.priority ?? 0) <= (cur.spec.priority ?? 0)) return
    // 5. 独占声明(未来):先停被 block 的通道
    for (const blocked of spec.blocksChannels ?? []) stopChannel(blocked)
    // 4. 打断当前动画(interrupted)
    if (cur) stopChannel(spec.channel)

    start(spec)
  }

  /** 开始播放:登记 active + 按 spec 接管眨眼 + runtime 播放(物理互斥由 runtime 兜底)。 */
  function start(spec: AnimationSpec): void {
    active.set(spec.channel, { spec, frozen: false })
    runtime.setAutoBlink(spec.autoBlink ?? true)
    runtime.playMotion(spec.id, spec.channel)
  }

  return {
    request,

    setHold(channel: AnimationChannel, holding: boolean): void {
      const entry = active.get(channel)
      if (!entry) return
      if (holding) {
        // 按住:记录状态,由 tick 在 holdAt 处冻结
        holdState.set(channel, true)
      } else {
        // 松开/移出:立即解除冻结继续播放
        holdState.set(channel, false)
        entry.frozen = false
        runtime.setMotionPaused?.(false)
      }
    },

    tick(): void {
      for (const [channel, entry] of [...active]) {
        // 素材自然播完(或加载失败):runtime 侧已清 currentMotion
        if (!runtime.isChannelActive(channel)) {
          active.delete(channel)
          holdState.delete(channel)
          runtime.setAutoBlink(true)
          emit({ channel, id: entry.spec.id, reason: 'finished' })
          continue
        }
        const elapsed = runtime.getMotionElapsed?.(channel) ?? -1
        // hold 模式:按住且已到保持点 → 冻结定格
        if (
          entry.spec.mode === 'hold' &&
          holdState.get(channel) === true &&
          !entry.frozen &&
          (entry.spec.holdAt ?? 0) > 0 &&
          elapsed >= (entry.spec.holdAt ?? 0)
        ) {
          entry.frozen = true
          runtime.setMotionPaused?.(true)
          continue
        }
        // 兜底时长:动画异常未自然结束时强制停止(冻结期间不计时)
        if (!entry.frozen && entry.spec.durationMs && elapsed >= entry.spec.durationMs / 1000) {
          stopChannel(channel)
        }
      }
    },

    setGate(channel: AnimationChannel, locked: boolean): void {
      if (locked) {
        gates.add(channel)
        stopChannel(channel)
      } else {
        gates.delete(channel)
      }
    },

    isActive(id: string): boolean {
      for (const entry of active.values()) {
        if (entry.spec.id === id) return true
      }
      return false
    },

    stopChannel,

    onEnd(listener: (e: AnimationEndEvent) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose(): void {
      for (const channel of [...active.keys()]) stopChannel(channel)
      listeners.clear()
    },
  }
}
