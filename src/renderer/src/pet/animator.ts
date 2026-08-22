import type { PetState } from '../fsm/pet-machine.ts'
import type { PetPetSettings } from '../../../shared/pet-config.ts'

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
  /**
   * 应用宠物外观与跟随手感(设置面板实时调整,0017)。
   * 可选:Live2D 后端实现;占位/贴图后端不实现(main.ts 用 ?. 调用)。
   */
  applyPetSettings?(settings: PetPetSettings): void
  /**
   * 0039:一次推理段开始(DSH 事件流的 reasoning 块进入;一次 turn 可含多段)。
   * Live2D 后端实现:按段计时,超阈值 B 循环"困惑"、段结束判定"恍然大悟"。
   */
  onThinkingSegmentStart?(): void
  /** 0039:推理段结束(非 reasoning 块/step-end/turn-end 收尾)。 */
  onThinkingSegmentEnd?(): void
  /**
   * 任务被打断(用户停止/中断,DSH turn/end reason = aborted/interrupted):
   * 播放"愤怒"表情一次。可选:占位后端不实现(main.ts 用 ?. 调用)。
   */
  playInterrupted?(): void
  /**
   * 0062 遗留(初版"窗口收缩"方案已弃用,当前无调用方,保留供程序化使用):
   * 宠物当前**屏幕包围盒**(窗口 CSS 坐标)。Live2D 后端由运行时可见 drawable
   * 顶点包围盒给出(含动画外延),占位球宠按球几何估算;模型未就绪返回 null。
   */
  getDisplayBounds?(): { x: number; y: number; width: number; height: number } | null
}
