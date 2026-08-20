import type { PetState } from '../../fsm/pet-machine.ts'
import type { PetAnimator } from '../animator.ts'
import type { PetStage } from '../stage.ts'
import { createSpriteAnimator } from '../sprite-animator.ts'
import { createAnimationDirector, type AnimationDirector } from '../animation-director.ts'
import { ANIMATIONS, MOTION_FILES } from '../animation-registry.ts'
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
      motions: MOTION_FILES,
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
    smoothing: { eye: 12 * p.response, head: 6 * p.response },
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
   * 0039 推理段计时:当前推理段开始时刻(performance.now,ms;0 = 不在段中)。
   * 由 onThinkingSegmentStart/End(DSH 事件流 reasoning 块)驱动 —— 一次 turn
   * 可含多次推理段,恍然大悟/困惑按**段时长**触发,而非整个任务时长。
   */
  let segmentStartedAt = 0
  /** 思考表情阈值 A(秒,设置面板可调):思考时长 ≥ A → 结束播放"恍然大悟"。 */
  let thinkExclaimAfterSec = DEFAULT_PET_CONFIG.pet.thinkExclaimAfterSec
  /** 思考表情阈值 B(秒,设置面板可调):思考时长 > B → 期间循环"困惑"。 */
  let thinkDizzyAfterSec = DEFAULT_PET_CONFIG.pet.thinkDizzyAfterSec
  /**
   * 阈值归一(0039):设置里 A/B 可任意填,按 min/max 归一保证"A=较短(恍然大悟)、
   * B=较长(困惑)"的语义不因填反而破坏(填反时两个阈值互换角色)。
   */
  function thinkThresholds(): { a: number; b: number } {
    return {
      a: Math.min(thinkExclaimAfterSec, thinkDizzyAfterSec),
      b: Math.max(thinkExclaimAfterSec, thinkDizzyAfterSec),
    }
  }

  /**
   * 睡眠功能(0058):目标会话空闲(状态机 idle)累计达到阈值后,宠物入睡 ——
   * 序列:禁用鼠标视线跟随 → 播入睡动作(Motion_sleep,holdEnd 停留尾帧:低头
   * 闭眼)→ 循环播放 Zzz 表情(Expression_sleep)直到唤醒。停止条件二选一:
   * (a) 状态离开 idle(切到正在运行的会话 / 目标 turn-start 等 → thinking 等);
   * (b) 用户拖动宠物窗口(主进程 33ms 推 dragDx/dragDy ≥ 阈值)。
   * 睡眠中摸头/点身体**不**唤醒(需求 4);摸头保留"视线跟随"交互 —— 睡着时
   * 被摸头,头仍随鼠标转(patStrength 增益 + 锚点切换照常),松开恢复禁用(需求 5)。
   * 只算目标空闲:状态机已按目标会话过滤非目标活动(0046),idle 计时天然是
   * "当前选中目标"的待机时长,其他并行会话不影响。
   */
  /** 入睡阈值(秒,设置面板可调):目标空闲达到该时长后触发睡眠。 */
  let sleepAfterSec = DEFAULT_PET_CONFIG.pet.sleepAfterSec
  /** idle 累计时长(秒):仅 state==='idle' 时递增,离开 idle / 睡眠结束归零。 */
  let idleElapsed = 0
  /** 是否处于睡眠状态(入睡动作 + Zzz 循环播放中)。 */
  let sleeping = false
  /** 睡眠序列阶段:进入睡眠 → 播入睡动作(到尾帧)→ 循环 Zzz 表情。 */
  let sleepPhase: 'waiting' | 'motion' | 'expression' = 'waiting'
  /** 进入睡眠的时刻(performance.now,ms):motion 阶段兜底(加载失败等异常)计时用。 */
  let sleepStartedAt = 0
  /**
   * Motion_sleep 素材时长(秒):入睡动作播到该秒即到尾帧,切换循环 Zzz 表情。
   * 与 animation-registry 的 'sleep-motion' 素材配套,换素材需同步。
   */
  const SLEEP_MOTION_DURATION = 4.867
  /**
   * 睡眠唤醒的拖动位移阈值(px):主进程 33ms 采样窗口位置增量,静止恒为 0;
   * 单次采样位移 ≥ 该值视为"拖动窗口",唤醒睡眠。3px 容忍极慢拖动/系统微移。
   */
  const DRAG_WAKE_PX = 3
  /** motion 阶段兜底超时(ms):入睡动作素材加载失败/被异常打断(elapsed 恒 -1)时,
   *  到点直接切 Zzz 循环,避免卡在"没动作也没表情"的空档。 */
  const SLEEP_MOTION_FALLBACK_MS = 6000

  /**
   * 动画导演(doc/09):集中仲裁表情/动作动画 —— 同通道互斥、优先级打断、hold 冻结、
   * 兜底超时、自然结束检测、眨眼接管。animator 只发 request,不再手写互斥标志位。
   */
  const director: AnimationDirector = createAnimationDirector(runtime)

  /**
   * 视线跟随开关统一入口(0058):睡眠中默认禁用(睡觉不随鼠标转头),但**摸头
   * 期间恢复启用** —— "睡着时仍可被摸头":头随鼠标转(patStrength 增益 + 锚点
   * 切换照常由 tick 按 holdActive 驱动),摸完松开回到禁用。其余情况沿原有
   * shouldFollow(thinking 时关闭)。
   */
  function updateFollow(): void {
    follower.setEnabled(shouldFollow(state) && (!sleeping || holdActive))
  }

  /**
   * 进入睡眠(0058):目标空闲达到阈值。严格按需求顺序执行:
   * 1. 禁用鼠标视线跟随(updateFollow:sleeping=true 且未摸头 → 关闭);
   * 2. 播入睡动作 Motion_sleep(action 通道,holdEnd:播完停留尾帧);
   * 3. 动作到尾帧后由 tick 切阶段循环播放 Zzz 表情(Expression_sleep)。
   * 进入前先停掉摸头/难过等余尾动画(打断会触发导演 interrupted 回调,顺手清
   * holdActive),保证入睡动作从干净状态开始。
   */
  function enterSleep(): void {
    if (sleeping || !loaded) return
    sleeping = true
    sleepPhase = 'motion'
    sleepStartedAt = performance.now()
    holdActive = false
    director.stopChannel('expression')
    director.stopChannel('action')
    director.request(ANIMATIONS['sleep-motion'])
    updateFollow()
    console.info(`[live2d] 进入睡眠(目标空闲 ${Math.round(idleElapsed)}s 达到阈值 ${sleepAfterSec}s)`)
  }

  /**
   * 退出睡眠(唤醒,0058):停止条件满足 —— (a) 状态离开 idle(切到正在运行的
   * 会话 → thinking,或任何非 idle 语义状态);(b) 拖动宠物窗口。停掉入睡动作
   * 与 Zzz 循环,表情参数平滑复位回待机(低头回正/睁眼/Zzz 隐藏,参数均在
   * EXPRESSION_PARAM_IDS 复位清单);恢复视线跟随;待机计时重新开始。
   */
  function exitSleep(): void {
    if (!sleeping) return
    sleeping = false
    sleepPhase = 'waiting'
    holdActive = false
    director.stopChannel('action')
    director.stopChannel('expression')
    idleElapsed = 0
    updateFollow()
    console.info('[live2d] 退出睡眠')
  }

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
  /**
   * 按住模式(0037l):按下且命中判定区域为 true;松开或移出区域解除。
   * 动画冻结/兜底/续摸等生命周期统一由 AnimationDirector 管理(0037s,doc/09),
   * 此处只保留"是否按住"这一交互状态(驱动 follower 力度增益与锚点切换,0037o)。
   */
  let holdActive = false
  /**
   * 按住摸头力度增益(0037o):当前生效的增益系数,0 = 不放大,patStrength = 满增益。
   * **平滑过渡而非瞬间赋值**——headMax 突变会让 follower 目标值跳变,按下瞬间
   * 头部甩出去(0037o 修复);tick 每帧指数趋近 holdActive ? patStrength : 0。
   */
  const PAT_SHAKE_SPEED = 6
  let patShakeLevel = 0
  /**
   * 按住摸头锚点(0037o):按住期间视线跟随以"头部判定区域中心"为参照——鼠标按在
   * 方框正中心时目标≈0(不偏移),按在四周时头部轻柔朝鼠标方向转;松开平滑回
   * 模型中心。锚点同样指数平滑,避免按下瞬间目标跳变。
   */
  const PAT_ANCHOR_SMOOTH = 10
  let followAnchor: { x: number; y: number } | null = null
  /** 头部点击区:no-drag 透明矩形(与命中区域一致),点击触发摸头。 */
  const hitEl = document.createElement('div')
  hitEl.id = 'pet-head-hit'
  hitEl.style.cssText =
    `position: fixed; z-index: 2; width: ${PAT_HIT_SIZE}px; height: ${PAT_HIT_SIZE}px;` +
    'border-radius: 6px; pointer-events: auto; -webkit-app-region: no-drag;' +
    'background: transparent;'
  document.body.appendChild(hitEl)

  /**
   * 身体点击区(0037r):no-drag 透明矩形,覆盖 HitAreaBody 包围盒;点击触发 sad
   * 表情。z-index 1 低于头部(2)——头部区域优先命中,两区不重叠时互不影响。
   */
  const bodyHitEl = document.createElement('div')
  bodyHitEl.id = 'pet-body-hit'
  bodyHitEl.style.cssText =
    'position: fixed; z-index: 1; pointer-events: auto; -webkit-app-region: no-drag;' +
    'background: transparent; display: none;'
  document.body.appendChild(bodyHitEl)

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
  /** 身体命中网格(0037r):绿色区分头部;无 HitAreaBody 时隐藏。 */
  const meshBodyPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  meshBodyPoly.setAttribute('fill', 'rgba(0, 199, 106, 0.16)')
  meshBodyPoly.setAttribute('stroke', '#00c76a')
  meshBodyPoly.setAttribute('stroke-width', '1.5')
  meshBodyPoly.setAttribute('stroke-dasharray', '4 3')
  meshSvg.appendChild(meshBodyPoly)
  document.body.appendChild(meshSvg)

  /** 每帧更新网格可视化:头部蓝色 + 身体绿色;无命中网格回退估算矩形(与点击区一致)。 */
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
    const bodyPts = runtime.getBodyMeshPoints?.()
    if (bodyPts && bodyPts.length >= 3) {
      meshBodyPoly.setAttribute('points', bodyPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
      meshBodyPoly.setAttribute('display', '')
    } else {
      meshBodyPoly.setAttribute('display', 'none')
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
   * 播放中重复按下:导演幂等忽略(续摸);动画结束后再按会重播。
   * 动画的冻结(到 holdAt 定格闭眼)/眨眼接管/兜底计时全部由导演管理,此处只发请求。
   * 0058:睡眠中摸头 —— 不播摸头动画、不终止睡眠(需求 4),只保留"视线跟随"
   * 交互(需求 5):holdActive=true 驱动 tick 的摸头增益/锚点切换,updateFollow
   * 在睡眠中恢复视线跟随;松开/移出由 releasePatHold 回到禁用。
   */
  function onPatDown(x: number, y: number): void {
    if (state !== 'idle') return
    // 命中判定:无 hitarea(undefined)回落为 overlay 区域即命中
    if (runtime.hitTestPoint && runtime.hitTestPoint(x, y) === false) return
    holdActive = true
    if (sleeping) {
      updateFollow()
      return
    }
    director.request(ANIMATIONS['pat-head'])
    director.setHold('expression', true)
    // 力度增益由 tick 每帧平滑爬升(0037o),不在按下瞬间跳变
  }

  /** 松开鼠标或移出判定区域:解除冻结,动画从保持帧继续播放到自然结束复位。
   *  力度增益由 tick 每帧平滑回落(0037o),不在松开瞬间跳变。
   *  0058:睡眠摸头松开 —— 视线跟随回到睡眠禁用状态(睡眠不终止)。 */
  function releasePatHold(): void {
    if (!holdActive) return
    holdActive = false
    if (sleeping) {
      updateFollow()
      return
    }
    director.setHold('expression', false)
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
   * 摸头动画结束/被打断(自然播完、sad 接管、离开 idle):清理按住状态。
   * 力度增益与按住锚点由 tick 按 holdActive=false 指数平滑回落(0037o),不瞬间跳变。
   * 0046:恍然大悟现在在 expression 通道播放,与 action 通道的 working(执行任务姿态)
   * 并存 —— 它自然播完后 working 从未被 stop,无需在这里恢复(原"播放后 request working"
   * 的 action 通道独占逻辑已移除)。
   */
  director.onEnd((e) => {
    if (e.id === 'pat-head') {
      holdActive = false
      // 0058:睡眠中摸头被中断(如入睡动作接管 expression 通道)→ 视线跟随回睡眠禁用
      if (sleeping) updateFollow()
    }
  })

  /**
   * 身体点击区(0037r):HitAreaBody 包围盒;素材未导出(旧素材)返回 null → 隐藏。
   * 不提供估算回退:身体区域形状依赖素材,没有 hitarea 就不该有身体交互。
   */
  function bodyAnchor(): { x: number; y: number; width: number; height: number } | null {
    return runtime.getBodyPoint?.() ?? null
  }

  /**
   * 点击身体(0037r):idle + 命中 HitAreaBody → 播放 sad 表情一遍(非循环,
   * 自然结束自动平滑复位)。播放中重复点击幂等忽略;sad priority 1 > 摸头 0,
   * 会自动打断进行中的摸头(导演仲裁),按住状态由 onEnd 回调清理。
   * 0058:睡眠中点身体 —— 不播难过表情、不终止睡眠(需求 4:点击热区不终止睡眠)。
   */
  function onBodyDown(x: number, y: number): void {
    if (state !== 'idle') return
    if (sleeping) return
    // 命中判定:无 hitarea(undefined)回落为 overlay 区域即命中
    if (runtime.hitTestBodyPoint && runtime.hitTestBodyPoint(x, y) === false) return
    director.request(ANIMATIONS['sad'])
  }
  bodyHitEl.addEventListener('pointerdown', (e) => onBodyDown(e.clientX, e.clientY))

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
      // 0058 停止条件(b):睡眠中用户拖动宠物窗口 → 唤醒。主进程 33ms 采样
      // 窗口位置增量(dragDx/dragDy,静止恒 0),单次采样位移 ≥ 阈值即视为拖动;
      // 窗口缩放(边缘拖拽)同样移动窗口位置,一并唤醒(用户动了窗口)。
      if (sleeping && (Math.abs(pos.dragDx ?? 0) >= DRAG_WAKE_PX || Math.abs(pos.dragDy ?? 0) >= DRAG_WAKE_PX)) {
        exitSleep()
      }
      // 0056d:窗口缩放期间置零拖动反馈(拖左/上边时窗口位置会跟着变,若不屏蔽
      // 会当"拖动宠物"驱动物理,叠加在缩放位移上显得乱跳)—— 缩放只移动窗口,
      // 不是拖宠物,拖动物理留到缩放结束后再用
      if (document.body.classList.contains('pet-resizing')) {
        dragTarget = { x: 0, y: 0 }
        return
      }
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

  function applyState(prev: PetState | null, next: PetState): void {
    // 0058:视线跟随统一入口(睡眠中默认禁用、摸头期间恢复),替代原 shouldFollow 直调
    updateFollow()
    // 表情通道门控:idle 与 thinking 放开(思考期间播放思考表情叠加:困惑循环,0039),
    // 其余瞬时态(happy/sad/talking)锁定 —— 进入即停掉进行中的表情并拒绝新请求
    director.setGate('expression', next !== 'idle' && next !== 'thinking')
    // 状态级眨眼控制(thinking 关);动画期间的眨眼由导演按 spec.autoBlink 接管,二者互不冲突
    runtime.setAutoBlink(next !== 'thinking')
    if (next === 'thinking') {
      // 进入 thinking(整个 turn):清掉摸头/难过表情与上一轮恍然大悟余尾(否则同优先级
      // 会挡住执行任务姿态的请求),播放执行任务的动作(低头 + 抬手,holdEnd 保持末尾姿态)。
      // 视角跟随已在 thinking 时关闭(shouldFollow),拖拽反馈(setDrag)照常生效。
      // 注意:思考表情(气泡/困惑/恍然大悟)不在这里判定 —— 它们按"推理段"触发
      // (onThinkingSegmentStart/End),一次 turn 可含多段(0039/0041)。
      director.stopChannel('expression')
      director.stopChannel('action')
      director.request(ANIMATIONS['working'])
    } else if (prev === 'thinking') {
      // 离开 thinking(turn 结束):气泡/困惑/恍然大悟表情停止;执行任务姿态(working)停止。
      // 0046:恍然大悟在 expression 通道,这里一并 stop,不再判断 isActive('think-exclaim')。
      director.stopChannel('expression')
      director.stopChannel('action')
    } else {
      // 常规状态切换:action 通道无动画时为空操作(离开 thinking 的 stop 在上一分支处理)
      director.stopChannel('action')
    }
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
      patStrength: clamp(settings.patStrength, 0, 8),
      thinkExclaimAfterSec: clamp(settings.thinkExclaimAfterSec, 0, 600),
      thinkDizzyAfterSec: clamp(settings.thinkDizzyAfterSec, 0, 600),
      sleepAfterSec: clamp(settings.sleepAfterSec, 10, 86400),
    }
    // 外层独立变量供 applyState/tick 闭包读取(思考表情阈值,0039):必须同步更新
    thinkExclaimAfterSec = petSettings.thinkExclaimAfterSec
    thinkDizzyAfterSec = petSettings.thinkDizzyAfterSec
    // 外层独立变量供 tick 闭包读取(入睡阈值,0058):必须同步更新,否则改了不生效
    sleepAfterSec = petSettings.sleepAfterSec
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
      applyState(null, state)
    },
    (error: unknown) => {
      console.error(`[live2d] 模型加载失败:${modelUrl}`, error)
    },
  )

  return {
    play(next: PetState): void {
      const prev = state
      state = next
      // 0058 停止条件(a):状态离开 idle(切到正在运行的会话 → thinking,或任意
      // 非 idle 语义状态)→ 唤醒;回到 idle → 待机计时重新开始(新一轮空闲)
      if (next !== 'idle') exitSleep()
      else idleElapsed = 0
      if (loaded) applyState(prev, next)
    },
    tick(deltaSeconds: number): void {
      // 0058 睡眠推进:
      // - 睡眠中(motion 阶段):入睡动作播到尾帧(Motion_sleep 素材 4.867s)→
      //   切换循环 Zzz 表情(expression 阶段,直到唤醒才停);素材加载失败/被
      //   异常打断(elapsed 恒 -1)超过兜底时长也切,避免卡在"没动作也没表情"。
      // - 待机(非睡眠):累计 idle 时长,达到阈值触发睡眠。状态机已按目标会话
      //   过滤非目标活动(0046),idle 时长即"当前选中目标"的待机时长,其他
      //   并行会话的运行/结束不影响此计时。
      if (sleeping) {
        if (sleepPhase === 'motion') {
          const elapsed = runtime.getMotionElapsed?.('action') ?? -1
          if (
            elapsed >= SLEEP_MOTION_DURATION ||
            (elapsed < 0 && performance.now() - sleepStartedAt > SLEEP_MOTION_FALLBACK_MS)
          ) {
            sleepPhase = 'expression'
            director.request(ANIMATIONS['sleep-expression'])
          }
        }
      } else if (state === 'idle') {
        idleElapsed += deltaSeconds
        if (idleElapsed >= sleepAfterSec) enterSleep()
      }
      // 按住摸头力度增益平滑(0037o):按下缓升、松开缓降——headMax 突变会让
      // follower 目标值跳变,按下瞬间头部甩出去;指数趋近避免跳变。
      const shakeGoal = holdActive ? petSettings.patStrength : 0
      patShakeLevel += (shakeGoal - patShakeLevel) * (1 - Math.exp(-PAT_SHAKE_SPEED * deltaSeconds))
      if (Math.abs(patShakeLevel - shakeGoal) < 0.005) patShakeLevel = shakeGoal
      const shakeBase = toFollowerConfig(petSettings)
      followerConfig.headMax = shakeBase.headMax * (1 + patShakeLevel * 0.5)
      followerConfig.smoothing = { ...shakeBase.smoothing, head: shakeBase.smoothing.head * (1 + patShakeLevel * 0.4) }

      // 按住摸头锚点(0037o):按住 → 平滑移到头部判定区域中心(中心按下不偏移),
      // 松开 → 平滑回模型中心;同样指数趋近避免目标跳变。
      const headBox = headAnchor()
      const anchorGoal = holdActive
        ? { x: headBox.x + headBox.width / 2, y: headBox.y + headBox.height / 2 }
        : anchor()
      if (!followAnchor) followAnchor = { ...anchorGoal }
      followAnchor.x += (anchorGoal.x - followAnchor.x) * (1 - Math.exp(-PAT_ANCHOR_SMOOTH * deltaSeconds))
      followAnchor.y += (anchorGoal.y - followAnchor.y) * (1 - Math.exp(-PAT_ANCHOR_SMOOTH * deltaSeconds))

      // 0056d:窗口缩放期间冻结视线跟随 —— 光标在窗口边缘(抓取点),宠物随窗口
      // 比例位移本身就是"移动";若继续跟踪光标,边缘相对锚点的距离随缩放变化,
      // 头部会来回摆动,叠加在位移上显得乱跳。缩放期间保持当前视线,结束后
      // 由 follower 的平滑指数趋近自然过渡到新目标。
      if (pointer && !document.body.classList.contains('pet-resizing')) {
        follower.update(deltaSeconds, pointer, followAnchor)
      }
      // 头部点击区跟随宠物位置(hitarea 精确位置或估算;窗口/位置/大小变化实时适配)
      const h = headAnchor()
      hitEl.style.left = `${h.x}px`
      hitEl.style.top = `${h.y}px`
      hitEl.style.width = `${h.width}px`
      hitEl.style.height = `${h.height}px`
      // 身体点击区跟随 HitAreaBody(0037r);素材未导出则隐藏
      const b = bodyAnchor()
      if (b) {
        bodyHitEl.style.display = 'block'
        bodyHitEl.style.left = `${b.x}px`
        bodyHitEl.style.top = `${b.y}px`
        bodyHitEl.style.width = `${b.width}px`
        bodyHitEl.style.height = `${b.height}px`
      } else {
        bodyHitEl.style.display = 'none'
      }
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
      // 导演推进:hold 冻结判定/兜底超时/自然结束检测(在 update 之后读最新 elapsed)
      director.tick()
      // 0039/0041 推理段超过阈值 B → 困惑表情(循环)顶替思考气泡贴纸,直到该段结束。
      // 重复请求由导演幂等忽略(同 id 在播);段结束(onThinkingSegmentEnd)时门控停止并复位。
      if (segmentStartedAt > 0 && state === 'thinking') {
        const elapsedSec = (performance.now() - segmentStartedAt) / 1000
        if (elapsedSec > thinkThresholds().b) director.request(ANIMATIONS['think-dizzy'])
      }
    },
    applyPetSettings,
    /**
     * 0039/0041 推理段开始(DSH 事件流 reasoning 块进入,一次 turn 可含多段):
     * 复位段计时;播放思考表情(气泡贴纸,段时长 0~困惑阈值 B 期间显示,超 B 由
     * tick 顶替为困惑);执行任务的动作(working)整个运行期间**常驻** —— 仅当
     * action 通道被其他动画(恍然大悟余尾)占用时才停掉重建,已是执行任务姿态
     * 则不动(避免每个推理段开头 0.5s 重播抖动:低头→抬头→低头)。
     */
    onThinkingSegmentStart(): void {
      segmentStartedAt = performance.now()
      director.stopChannel('expression')
      if (state === 'thinking' && !director.isActive('working')) {
        director.stopChannel('action')
        director.request(ANIMATIONS['working'])
      }
      if (state === 'thinking') director.request(ANIMATIONS['think-thinking'])
    },
    /**
     * 0039 推理段结束:按段时长判定 —— ≥ 阈值 A 播放"恍然大悟"一次(expression 通道,
     * 0046 起不再 stop action 通道的 working —— 恍然大悟叠加在执行任务姿态上,不冲突);
     * < A 保持执行任务姿态。气泡/困惑(expression)已在段末停止并复位。
     */
    onThinkingSegmentEnd(): void {
      if (segmentStartedAt <= 0) return
      const elapsedSec = (performance.now() - segmentStartedAt) / 1000
      segmentStartedAt = 0
      director.stopChannel('expression')
      if (elapsedSec >= thinkThresholds().a) {
        director.request(ANIMATIONS['think-exclaim'])
      }
    },
    /**
     * 任务被打断(用户停止/中断):播放愤怒表情一次(expression 通道)。
     * 调用时机:main.ts 已先发 DSH_INTERRUPTED —— 状态机离开 thinking 回 idle,
     * applyState 已停掉执行任务姿态并放开表情门控,这里请求即可生效;
     * 非循环素材播完自然结束自动平滑复位(ParamAngry 等已入 EXPRESSION_PARAM_IDS)。
     */
    playInterrupted(): void {
      director.request(ANIMATIONS['angry'])
    },
    dispose(): void {
      unsubscribeCursor?.()
      window.removeEventListener('pointermove', onPointerMove)
      director.dispose()
      hitEl.remove()
      bodyHitEl.remove()
      meshSvg.remove()
      runtime.dispose()
    },
  }
}
