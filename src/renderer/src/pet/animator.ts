import type { PetState } from '../fsm/pet-machine.ts'

/**
 * 动画后端接口 —— "换 Live2D/Lottie 的成本锚点"。
 * 状态机只调用 play(state);具体后端(精灵图/Lottie/Live2D)各自实现,
 * 切换后端时状态机、事件、UI 一行不改。
 */
export interface PetAnimator {
  /** 切到某个语义状态并开始播对应动画。 */
  play(state: PetState): void
  /** 每帧推进(占位动画用;贴图/Live2D 后端可忽略)。 */
  tick(deltaSeconds: number): void
  dispose(): void
}
