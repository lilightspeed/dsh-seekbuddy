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

/** PetPetSettings → follower 配置(响应速度乘到各通道平滑速度;0030 起身体幅度不再可调,走默认)。 */
function toFollowerConfig(p: PetPetSettings): ViewFollowerConfig {
  return {
    deadZoneRadius: p.deadZone,
    distanceScale: p.distance,
    eyeMax: p.eyeAmplitude,
    headMax: p.headAmplitude,
    smoothing: { eye: 12 * p.response, head: 6 * p.response, body: 3 * p.response },
    recenterSpeed: 5 * p.response,
    pupilSensitivity: p.pupilSensitivity,
    pupilMax: p.pupilMax,
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
   * 拖动物理反馈(0032/0034):主进程 33ms 推送窗口位置增量(px),按窗口尺寸归一化后
   * 作为 ParamDragX/Y 的目标值;每帧指数平滑(拖动中跟手、停止后回中),由
   * physics3.json 演算尾巴/头发的惯性摆动。位移达到窗口宽/高的一半视为基础满行程。
   *
   * 强度刻度(0034):设置值 0..1 线性映射到增益 1..DRAG_MAX_MULTIPLIER ——
   * 0% = 基础灵敏度(0032 原效果),100% = 增益上限(快速拖动即让参数接近满行程,
   * 达到 Live2D 编辑器/导出预览里的反馈强度)。
   */
  const DRAG_FULL_TRAVEL = 0.5
  /**
   * 100% 强度时的增益上限(倍):1 = 0032 原效果;10 = 中等速度拖动(≥ ~21px/采样,
   * 约 640px/s)即饱和到参数满行程(窗口半宽 210px / 10),反馈强度达到编辑器最大效果。
   */
  const DRAG_MAX_MULTIPLIER = 10
  /** 拖动目标平滑速度(1/s):越大越跟手;回中同速,配合物理 delay 留出惯性余韵。 */
  const DRAG_SMOOTHING = 10
  /** 拖动反馈强度(设置面板 0..1,0033/0034):0 = 基础效果(0032),1 = 增益到 DRAG_MAX_MULTIPLIER。 */
  let dragStrength = options.initialPetSettings?.dragStrength ?? DEFAULT_PET_CONFIG.pet.dragStrength
  let dragTarget = { x: 0, y: 0 }
  let dragCurrent = { x: 0, y: 0 }

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
      // 拖动位移 → 基础归一化(±1 截断)→ 乘强度增益;无拖动时主进程推 0 → 目标回中。
      // 增益 = 1 + 强度×(MAX−1):0% 保持 0032 原效果,100% 放大到 DRAG_MAX_MULTIPLIER。
      // Y 取反:屏幕坐标向下为正,而 ParamDragY 正向定义相反(同 ParamAngleY 的处理,0017)。
      const gain = 1 + dragStrength * (DRAG_MAX_MULTIPLIER - 1)
      dragTarget = {
        x: clamp(clamp((pos.dragDx ?? 0) / (window.innerWidth * DRAG_FULL_TRAVEL), -1, 1) * gain, -1, 1),
        y: clamp(clamp(-(pos.dragDy ?? 0) / (window.innerHeight * DRAG_FULL_TRAVEL), -1, 1) * gain, -1, 1),
      }
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
      deadZone: clamp(settings.deadZone, 0, 100),
      distance: clamp(settings.distance, 20, 2000),
      response: clamp(settings.response, 0.2, 5),
      pupilSensitivity: clamp(settings.pupilSensitivity, 200, 2000),
      pupilMax: clamp01(settings.pupilMax),
      dragStrength: clamp01(settings.dragStrength),
    }
    // 外层独立变量供 onCursor 闭包读取(增益计算):必须同步更新,否则滑块调了不生效(0035)
    dragStrength = petSettings.dragStrength
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
      // 拖动反馈:指数平滑趋近目标(停止拖动后目标为 0 → 参数回中,物理余韵自然衰减)
      const k = 1 - Math.exp(-DRAG_SMOOTHING * deltaSeconds)
      dragCurrent = {
        x: dragCurrent.x + (dragTarget.x - dragCurrent.x) * k,
        y: dragCurrent.y + (dragTarget.y - dragCurrent.y) * k,
      }
      runtime.setDrag(dragCurrent)
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
