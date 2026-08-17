import type { PetState } from '../../fsm/pet-machine.ts'
import type { PetAnimator } from '../animator.ts'
import type { PetStage } from '../stage.ts'
import { createSpriteAnimator } from '../sprite-animator.ts'
import { createCubismRuntime } from './cubism-runtime.ts'
import { getLive2dRuntime, type Live2dRuntime } from './runtime.ts'
import { createViewFollower, type ViewFollowerConfig } from './view-follower.ts'

export interface Live2dAnimatorOptions {
  /** model3.json 的 publicDir 相对 URL。默认 /pet/live2d/ds-pet.model3.json */
  modelUrl?: string
  /** Live2D canvas 的宿主元素;默认 #stage。 */
  host?: HTMLElement
  /** 模型中心在窗口中的竖直比例(0=顶,1=底);默认 0.44(与角色层锚点一致)。 */
  anchorRatioY?: number
  /** 视角跟随锚点(角色头部中心,窗口 px);默认与模型位置一致(窗口下方偏中)。 */
  anchor?: () => { x: number; y: number }
  /** 是否跟随鼠标;默认 DSH 不工作(非 thinking)时跟随。 */
  shouldFollow?: (state: PetState) => boolean
  /** 跟随手感参数。 */
  followerConfig?: ViewFollowerConfig
  /** 注入运行时(测试用);缺省用注册的默认运行时,再退回自动创建 Cubism 运行时。 */
  runtime?: Live2dRuntime
}

const DEFAULT_MODEL_URL = '/pet/live2d/ds-pet.model3.json'

/**
 * 创建动画后端:优先 Live2D(自动创建 Cubism SDK 运行时),创建失败时回落占位球宠 ——
 * 状态机 / 事件 / UI 零改动(doc/08 §4)。SDK 接入细节见 cubism-runtime.ts。
 */
export function createLive2dAnimator(stage: PetStage, options: Live2dAnimatorOptions = {}): PetAnimator {
  const runtime =
    options.runtime ??
    getLive2dRuntime() ??
    createCubismRuntime({
      host: options.host ?? document.querySelector<HTMLElement>('#stage') ?? document.body,
      modelUrl: options.modelUrl ?? DEFAULT_MODEL_URL,
      anchorRatioY: options.anchorRatioY ?? 0.44,
    })
  if (!runtime) {
    console.warn('[live2d] 无法创建 Cubism 运行时(WebGL2 不可用),回落占位球宠')
    return createSpriteAnimator(stage)
  }
  return createLive2dAnimatorWithRuntime(runtime, options)
}

function createLive2dAnimatorWithRuntime(
  runtime: Live2dRuntime,
  options: Live2dAnimatorOptions,
): PetAnimator {
  const modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL
  const anchor = options.anchor ?? (() => ({ x: window.innerWidth / 2, y: window.innerHeight * 0.44 }))
  const shouldFollow = options.shouldFollow ?? ((state: PetState) => state !== 'thinking')

  const follower = createViewFollower(options.followerConfig)
  let state: PetState = 'idle'
  let pointer: { x: number; y: number } | null = null
  let loaded = false

  function onPointerMove(event: PointerEvent): void {
    pointer = { x: event.clientX, y: event.clientY }
  }

  function applyState(next: PetState): void {
    follower.setEnabled(shouldFollow(next))
    runtime.setAutoBlink(next !== 'thinking')
    // TODO(表情 / 动作里程碑):按 doc/08 §4 映射表播 motion3 / exp3(素材未制作)。
  }

  void runtime.loadModel(modelUrl).then(
    () => {
      loaded = true
      console.info(`[live2d] 动画器启用 Live2D:${modelUrl}`)
      applyState(state)
    },
    (error: unknown) => {
      console.error(`[live2d] 模型加载失败:${modelUrl}`, error)
    },
  )

  window.addEventListener('pointermove', onPointerMove)

  return {
    play(next: PetState): void {
      state = next
      if (loaded) applyState(next)
    },
    tick(deltaSeconds: number): void {
      if (pointer) follower.update(deltaSeconds, pointer, anchor())
      runtime.setViewLook(follower.look())
      runtime.update(deltaSeconds)
    },
    dispose(): void {
      window.removeEventListener('pointermove', onPointerMove)
      runtime.dispose()
    },
  }
}
