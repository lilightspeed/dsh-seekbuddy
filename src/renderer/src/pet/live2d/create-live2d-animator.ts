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
   * 摸头反馈(点击触发):idle(未工作)时点击头部点击区 → 播放 pat-head 表情一遍
   * 后自然结束自动复位,期间再次点击续摸(重置计时);状态离开 idle 立即停止。
   * 与瞳孔收缩(0029,快速接近受惊)互补:接近时缩瞳,点击头部时摸头享受。
   * #stage 是 drag 区域会吞掉 renderer 鼠标事件(0016),故叠一个 no-drag 透明
   * 矩形点击区(#pet-head-hit)捕获点击;**矩形 = 命中网格包围盒,与触发区域一致**
   * (0037:HitAreaHead 是 4 顶点矩形,包围盒即网格本身);无 hitarea 回退估算矩形。
   */
  /** 头部点击区边长(px;素材导出 HitAreas 时由运行时按 hitarea 包围盒覆盖)。 */
  const PAT_HIT_SIZE = 104
  /** 头部相对模型中心锚点(anchor,窗口 positionX/Y)的向上偏移(窗口高度比例;仅 HitAreas 缺失时回退)。 */
  const PAT_HEAD_OFFSET_RATIO = 0.18
  /** 一次摸头播放时长(ms,兜底):动画 3.83s 自然结束后运行时自动复位,此值仅兜底。 */
  const PAT_PLAY_MS = 4000
  /** 按住摸头(0037l):按下后动画播到闭眼保持点(秒)冻结定格,松开/移出再继续。
   *  素材曲线:0~0.33s 闭眼,0.33~1.20s 保持(闭眼+微笑+泛红),1.20s 起睁眼复位。
   *  取 0.45s = 闭眼完全到位后立刻冻结,留足保持窗口。 */
  const PAT_HOLD_TIME = 0.45
  const PAT_MOTION = 'pat-head'
  /** 摸头表情是否在播放。 */
  let patActive = false
  /** 本次摸头已播放时长(ms);再次点击重置。 */
  let patPlayMs = 0
  /** 按住模式(0037l):按下且命中判定区域为 true;松开或移出区域解除。 */
  let holdActive = false
  /** 已冻结:动画已定格在闭眼保持帧(松开/移出后解除)。 */
  let holdFrozen = false

  /**
   * 按住摸头期间的头部灵敏度(0037m/0037n):true = 按"摸头力度"增益放大
   * (patStrength 0..2:幅度 ×(1+0.5s)、跟手 ×(1+0.4s);0 = 不放大,1 = 默认
   * 1.5×/1.4×,2 = 2.0×/1.8×),false = 恢复 petSettings 基准。
   * 基于基准重新计算,设置面板调整不受影响。
   */
  function applyPatShake(enabled: boolean): void {
    const base = toFollowerConfig(petSettings)
    const s = petSettings.patStrength
    Object.assign(
      followerConfig,
      enabled
        ? {
            ...base,
            headMax: base.headMax * (1 + s * 0.5),
            smoothing: { ...base.smoothing, head: base.smoothing.head * (1 + s * 0.4) },
          }
        : base,
    )
  }
  /** 头部点击区:no-drag 透明矩形(与命中区域一致),点击触发摸头。 */
  const hitEl = document.createElement('div')
  hitEl.id = 'pet-head-hit'
  hitEl.style.cssText =
    `position: fixed; z-index: 2; width: ${PAT_HIT_SIZE}px; height: ${PAT_HIT_SIZE}px;` +
    'border-radius: 6px; pointer-events: auto; -webkit-app-region: no-drag;' +
    'background: transparent;'
  document.body.appendChild(hitEl)

  /** 点击判定网格可视化(0037):SVG polygon 画命中网格轮廓,设置面板开关控制(默认隐藏)。
   *  注意:svg 是替换元素,position:fixed + inset:0 不会拉伸尺寸,必须显式给宽高,
   *  否则默认 300×150 画布会把屏幕坐标的网格裁掉(0037j)。 */
  const meshSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  meshSvg.setAttribute(
    'style',
    'position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 3; pointer-events: none; display: none;',
  )
  const meshPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  meshPoly.setAttribute('fill', 'rgba(77, 107, 254, 0.18)')
  meshPoly.setAttribute('stroke', '#4d6bfe')
  meshPoly.setAttribute('stroke-width', '1.5')
  meshPoly.setAttribute('stroke-dasharray', '4 3')
  meshSvg.appendChild(meshPoly)
  document.body.appendChild(meshSvg)

  /** 每帧更新网格可视化:优先画命中网格多边形,无网格回退估算矩形(与点击区一致)。 */
  function updateMeshOverlay(): void {
    if (!petSettings.showHitMesh) return
    const pts = runtime.getHeadMeshPoints?.()
    if (pts && pts.length >= 3) {
      meshPoly.setAttribute('points', pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
    } else {
      const h = headAnchor()
      meshPoly.setAttribute(
        'points',
        `${h.x},${h.y} ${h.x + h.width},${h.y} ${h.x + h.width},${h.y + h.height} ${h.x},${h.y + h.height}`,
      )
    }
  }

  /**
   * 头部点击区(左上角 + 尺寸):优先取运行时按 model3.json HitAreas 算出的精确
   * 包围盒(与命中网格一致);素材未导出时回退"模型中心锚点上方偏移"估算。
   */
  function headAnchor(): { x: number; y: number; width: number; height: number } {
    const hit = runtime.getHeadPoint?.()
    if (hit) return hit
    const a = anchor()
    return {
      x: a.x - PAT_HIT_SIZE / 2,
      y: a.y - window.innerHeight * PAT_HEAD_OFFSET_RATIO - PAT_HIT_SIZE / 2,
      width: PAT_HIT_SIZE,
      height: PAT_HIT_SIZE,
    }
  }

  /**
   * 按下摸头(0037l):idle + 命中判定区域 → 播放摸头并进入按住模式。
   * 动画播到闭眼保持点后由 tick 冻结(定格闭眼),松开或鼠标移出判定区域才继续。
   * 播放中重复按下:playMotion 幂等(同 motion 忽略);动画结束后再按会重播。
   * **每次触发都关眨眼**(0037:动画结束后复位会恢复眨眼,续摸/重播若不重关,
   * 眨眼会覆盖 motion 的闭眼)。
   */
  function onPatDown(x: number, y: number): void {
    if (state !== 'idle') return
    // 命中判定:无 hitarea(undefined)回落为 overlay 区域即命中
    if (runtime.hitTestPoint && runtime.hitTestPoint(x, y) === false) return
    holdActive = true
    holdFrozen = false
    // 按住期间调高头部灵敏度(0037m):按下即生效,松开恢复
    applyPatShake(true)
    if (!patActive) patActive = true
    runtime.setAutoBlink(false)
    runtime.playMotion(PAT_MOTION)
    patPlayMs = 0
  }

  /** 松开鼠标或移出判定区域:解除冻结,动画从保持帧继续播放到自然结束复位。 */
  function releasePatHold(): void {
    if (!holdActive) return
    holdActive = false
    holdFrozen = false
    // 松开即恢复常规灵敏度(0037m)
    applyPatShake(false)
    runtime.setMotionPaused?.(false)
  }

  /** 按住期间指针移动:移出判定区域 → 解除冻结继续播放。 */
  function onPatPointerMove(e: PointerEvent): void {
    if (!holdActive) return
    if (runtime.hitTestPoint && runtime.hitTestPoint(e.clientX, e.clientY) === false) releasePatHold()
  }

  // pointer capture:按住期间指针事件(含移出区域/窗口外松开)全部路由到 hitEl,
  // 保证"松开"事件不漏;移出窗口也不怕——capture 会把 pointerup 送回 hitEl。
  hitEl.addEventListener('pointerdown', (e) => {
    hitEl.setPointerCapture(e.pointerId)
    onPatDown(e.clientX, e.clientY)
  })
  hitEl.addEventListener('pointermove', onPatPointerMove)
  hitEl.addEventListener('pointerup', () => releasePatHold())

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
    // 摸头只在 idle 生效:状态离开 idle(工作/瞬时反馈态)立即淡出摸头表情
    if (next !== 'idle' && patActive) {
      patActive = false
      holdActive = false
      holdFrozen = false
      applyPatShake(false)
      runtime.stopMotion()
    }
    patPlayMs = 0
    runtime.setAutoBlink(next !== 'thinking')
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
      showHitMesh: Boolean(settings.showHitMesh),
      patStrength: clamp(settings.patStrength, 0, 2),
    }
    // 外层独立变量供 onCursor 闭包读取(增益计算):必须同步更新,否则滑块调了不生效(0035)
    dragStrength = petSettings.dragStrength
    // 网格可视化开关(0037):立即显示/隐藏
    meshSvg.style.display = petSettings.showHitMesh ? 'block' : 'none'
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
      // 按住摸头(0037l):动画播到闭眼保持点 → 冻结定格;松开/移出由事件解除
      if (holdActive && !holdFrozen) {
        const elapsed = runtime.getMotionElapsed?.() ?? -1
        if (elapsed >= PAT_HOLD_TIME) {
          holdFrozen = true
          runtime.setMotionPaused?.(true)
        }
      }
      // 摸头播放计时:播满一轮淡出停止;再次点击(triggerPat)会重置计时续摸。
      // 冻结(闭眼保持)期间暂停计时——定格时不计入播放时长。
      if (patActive && !holdFrozen) {
        patPlayMs += deltaSeconds * 1000
        if (patPlayMs >= PAT_PLAY_MS) {
          patActive = false
          runtime.stopMotion()
          runtime.setAutoBlink(true)
        }
      }
      // 头部点击区跟随宠物位置(hitarea 精确位置或估算;窗口/位置/大小变化实时适配)
      // 头部点击区跟随宠物位置(hitarea 精确位置或估算;窗口/位置/大小变化实时适配)
      const h = headAnchor()
      hitEl.style.left = `${h.x}px`
      hitEl.style.top = `${h.y}px`
      hitEl.style.width = `${h.width}px`
      hitEl.style.height = `${h.height}px`
      // 点击判定网格可视化(设置面板开关,0037)
      updateMeshOverlay()
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
      hitEl.remove()
      meshSvg.remove()
      runtime.dispose()
    },
  }
}
