import { createMachine } from 'xstate'

/** 宠物语义状态(与动画后端无关,PetAnimator 只认这些名字)。 */
export type PetState = 'idle' | 'thinking' | 'happy' | 'sad' | 'talking'

/** 状态机事件:由 DSH 事件/用户操作映射而来。 */
export type PetMachineEvent =
  | { type: 'DSH_WORKING' }
  | { type: 'DSH_DONE' }
  | { type: 'DSH_ERROR' }
  | { type: 'TALK' }
  /** 任务被打断(用户停止/中断,DSH turn/end reason = aborted/interrupted):直接回待机,播愤怒表情。 */
  | { type: 'DSH_INTERRUPTED' }

/**
 * 状态机:只输出语义状态,不关心动画怎么播。
 * DSH 帧(turn/start → WORKING,turn/end → DONE,操作失败 → ERROR)与用户说话(TALK)。
 * happy/sad/talking 是瞬时态,延时自动回 idle。
 */
export const petMachine = createMachine({
  id: 'pet',
  initial: 'idle',
  states: {
    idle: {
      on: { DSH_WORKING: 'thinking', DSH_ERROR: 'sad', DSH_DONE: 'happy', TALK: 'talking' },
    },
    thinking: {
      on: {
        DSH_DONE: 'happy',
        DSH_ERROR: 'sad',
        TALK: 'talking',
        // 打断任务:不走 happy(庆祝)直接回 idle —— 愤怒表情作为 idle 期效果播放
        DSH_INTERRUPTED: 'idle',
      },
    },
    happy: {
      after: { 2500: { target: 'idle' } },
      on: { DSH_WORKING: 'thinking', DSH_ERROR: 'sad', TALK: 'talking', DSH_INTERRUPTED: 'idle' },
    },
    sad: {
      after: { 3500: { target: 'idle' } },
      on: { DSH_WORKING: 'thinking', DSH_DONE: 'happy', TALK: 'talking' },
    },
    talking: {
      after: { 3000: { target: 'idle' } },
      on: { DSH_WORKING: 'thinking', DSH_DONE: 'happy', DSH_ERROR: 'sad' },
    },
  },
})
