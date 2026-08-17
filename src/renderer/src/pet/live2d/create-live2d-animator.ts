import type { PetState } from '../../fsm/pet-machine.ts'
import type { PetAnimator } from '../animator.ts'
import type { PetStage } from '../stage.ts'
import { createSpriteAnimator } from '../sprite-animator.ts'
import { DEFAULT_PET_CONFIG, type PetPetSettings } from '../../../../shared/pet-config.ts'
import { createCubismRuntime } from './cubism-runtime.ts'
import { getLive2dRuntime, type Live2dRuntime } from './runtime.ts'
import { createViewFollower, type ViewFollowerConfig } from './view-follower.ts'

export interface Live2dAnimatorOptions {
  /** model3.json 的 publicDir 相对 URL。默认 /pet/live2d/ds-pet.model3.json */
  modelUrl?: string
  /** Live2D canvas 的宿主元素;默认 #stage。 */
  host?: HTMLElement
  /** 初始宠物外观/手感(默认 DEFAULT_PET_CONFIG.pet;设置面板加载后经 applyPetSettings 覆盖)。 */
  initialPetSettings?: PetPetSettings
  /** 视角跟随锚点(角色头部中心,窗口 px);默认跟随宠物位置(由 petSettings 决定)。 */
  anchor?: () => { x: number; y: number }
  /** 是否跟随鼠标;默认 DSH 不工作(非 thinking)时跟随。 */
  shouldFollow?: (state: PetState) => boolean
  /** 初始跟随手感(applyPetSettings 会覆盖;测试注入用)。 */
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
  const initial = options.initialPetSettings ?? DEFAULT_PET_CONFIG.pet
  const runtime =
    options.runtime ??
    getLive2dRuntime() ??
    createCubismRuntime({
      host: options.host ?? document.querySelector<HTMLElement>('#stage') ?? document.body,
      modelUrl: options.modelUrl ?? DEFAULT_MODEL_URL,
      appearance: { positionX: initial.positionX, positionY: initial.positionY, scale: initial.scale },
    })
  if (!runtime) {
    console.warn('[live2d] 无法创建 Cubism 运行时(WebGL2 不可用),回落占位球宠')
    return createSpriteAnimator(stage)
  }
  return createLive2dAnimatorWithRuntime(runtime, options)
}

/** PetPetSettings → follower 配置(响应速度乘到各通道平滑速度)。 */
function toFollowerConfig(p: PetPetSettings): ViewFollowerConfig {
  return {
    deadZoneRadius: p.deadZone,
    distanceScale: p.distance,
    eyeMax: p.eyeAmplitude,
    headMax: p.headAmplitude,
    bodyMax: p.bodyAmplitude,
    smoothing: { eye: 12 * p.response, head: 6 * p.response, body: 3 * p.response },
    recenterSpeed: 5 * p.response,
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function createLive2dAnimatorWithRuntime(
  runtime: Live2dRuntime,
  options: Live2dAnimatorOptions,
): PetAnimator {
  const modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL
  const shouldFollow = options.shouldFollow ?? ((state: PetState) => state !== 'thinking')

  let petSettings: PetPetSettings = { ...(options.initialPetSettings ?? DEFAULT_PET_CONFIG.pet) }
  const followerConfig: ViewFollowerConfig = options.followerConfig
    ? { ...options.followerConfig }
    : toFollowerConfig(petSettings)
  const follower = createViewFollower(followerConfig)
  // 跟随锚点 = 宠物模型中心(随位置设置实时移动)
  const anchor = options.anchor ?? (() => ({ x: window.innerWidth * petSettings.positionX, y: window.innerHeight * petSettings.positionY }))

  let state: PetState = 'idle'
  let pointer: { x: number; y: number } | null = null
  let loaded = false
  let unsubscribeCursor: (() => void) | undefined

  /**
   * 写入当前光标(窗口局部坐标,原样透传)。
   * 不夹取到窗口边缘:窗口外鼠标的远近由 follower 的指数距离曲线持续影响视角(0017);
   * 0016 曾夹取到边缘,但那会抹掉窗口外距离信息。
   */
  function setPointer(x: number, y: number): void {
    pointer = { x, y }
  }

  // 主数据源:主进程光标轮询(拖拽区域吞 renderer 鼠标事件,0016)
  if (window.petApi?.onCursor) {
    unsubscribeCursor = window.petApi.onCursor((pos) => {
      setPointer(pos.x, pos.y)
    })
  }
  // 兜底:无 petApi 环境(如纯浏览器调试)仍走本地事件
  function onPointerMove(event: PointerEvent): void {
    setPointer(event.clientX, event.clientY)
  }
  window.addEventListener('pointermove', onPointerMove)

  function applyState(next: PetState): void {
    follower.setEnabled(shouldFollow(next))
    runtime.setAutoBlink(next !== 'thinking')
    // TODO(表情 / 动作里程碑):按 doc/08 §4 映射表播 motion3 / exp3(素材未制作)。
  }

  /** 应用宠物外观与跟随手感(设置面板实时调用,0017):就地更新 follower 配置 + 重建视图。 */
  function applyPetSettings(settings: PetPetSettings): void {
    petSettings = {
      positionX: clamp01(settings.positionX),
      positionY: clamp01(settings.positionY),
      scale: clamp(settings.scale, 0.2, 3),
      headAmplitude: clamp01(settings.headAmplitude),
      eyeAmplitude: clamp01(settings.eyeAmplitude),
      bodyAmplitude: clamp01(settings.bodyAmplitude),
      deadZone: clamp(settings.deadZone, 0, 100),
      distance: clamp(settings.distance, 20, 2000),
      response: clamp(settings.response, 0.2, 5),
    }
    // follower 闭包持有同一个 config 对象,就地覆盖即可实时生效
    Object.assign(followerConfig, toFollowerConfig(petSettings))
    runtime.setAppearance({ positionX: petSettings.positionX, positionY: petSettings.positionY, scale: petSettings.scale })
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
    applyPetSettings,
    dispose(): void {
      unsubscribeCursor?.()
      window.removeEventListener('pointermove', onPointerMove)
      runtime.dispose()
    },
  }
}
