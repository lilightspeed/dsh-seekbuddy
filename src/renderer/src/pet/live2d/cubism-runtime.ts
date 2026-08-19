import { CubismModelSettingJson } from '@live2d/framework/cubismmodelsettingjson'
import { CubismBreath, BreathParameterData } from '@live2d/framework/effect/cubismbreath'
import { CubismEyeBlink } from '@live2d/framework/effect/cubismeyeblink'
import type { CubismIdHandle } from '@live2d/framework/id/cubismid'
import { CubismFramework, LogLevel, Option } from '@live2d/framework/live2dcubismframework'
import { CubismMatrix44 } from '@live2d/framework/math/cubismmatrix44'
import { CubismViewMatrix } from '@live2d/framework/math/cubismviewmatrix'
import type { CubismModel } from '@live2d/framework/model/cubismmodel'
import { CubismUserModel } from '@live2d/framework/model/cubismusermodel'
import { CubismBreathUpdater } from '@live2d/framework/motion/cubismbreathupdater'
import { CubismEyeBlinkUpdater } from '@live2d/framework/motion/cubismeyeblinkupdater'
import { CubismMotion } from '@live2d/framework/motion/cubismmotion'
import { CubismMotionQueueManager } from '@live2d/framework/motion/cubismmotionqueuemanager'
import { CubismPhysicsUpdater } from '@live2d/framework/motion/cubismphysicsupdater'
import { CubismUpdateScheduler } from '@live2d/framework/motion/cubismupdatescheduler'
import { CubismPhysics } from '@live2d/framework/physics/cubismphysics'
import { CubismWebGLOffscreenManager } from '@live2d/framework/rendering/cubismoffscreenmanager'
import { PARAM_HEAD, PARAM_EYE, PARAM_BODY, PARAM_MANUAL, PARAM_EXPRESSION, PARAM_DRAG, PARAM_BACK_HAIR, PARAM_HAIR_SWAY, type ViewLook } from './parameters.ts'
import type { Live2dAppearance, Live2dRuntime, AnimationChannel } from './runtime.ts'

/**
 * Cubism SDK for Web 5-r.5 的 Live2dRuntime 实现 —— 独立 WebGL2 canvas 自绘(doc/08 §4 结论)。
 *
 * 职责(全部在本类内,外部零 SDK 依赖):
 * - 自建 canvas 挂进宿主(#stage),随窗口 resize / devicePixelRatio 同步;
 * - 异步加载 model3.json → moc → physics → 纹理,构建 UpdateScheduler(物理 + 呼吸);
 * - 每帧:写视角跟随参数(含瞳孔收缩 0..1)→ scheduler 跑物理(后发随头部角度自动摆动)→ model.update → 渲染;
 * - 视角跟随参数用归一化 -1..1 输入(瞳孔通道 0..1),内部按参数实际 min/max/default 映射(见 setViewLook)。
 * - motion 播放按通道(doc/09):每通道独立 CubismMotionQueueManager,start 前先停同通道
 *   旧动画(物理互斥,杜绝两条动画并行重叠);素材配置由构造注入(animation-registry 单点)。
 *
 * 许可与版本见 vendor/live2d/README.md;接入流程见 runtime.ts 顶部注释。
 */

/** 着色器静态根(publicDir=assets,文件在 assets/pet/live2d/shaders/)。 */
const SHADER_PATH = '/pet/live2d/shaders/'

/**
 * motion 素材配置由构造注入(animation-registry 单点配置,0037s)——本类只按
 * 逻辑名查 file/loop,不持有业务元数据(priority/channel 等归 registry/director)。
 * 素材以 `Expression_*.motion3.json` 命名(动画时间轴导出的"表情动作")。
 * `loop`:素材 json 的 Meta.Loop 虽为 true,但摸头曲线首尾不一致(EyeLSmile
 * 0s=0 / 3.833s=1),循环点处表情闪没重来(V2 correctEndPoint 只能平滑不能消除,
 * 0037 实测)—— 强制非循环,播一遍自然结束 + 运行时自动平滑复位,最干净。
 */
/** motion 基础 URL(publicDir=assets)。 */
const MOTION_BASE_URL = '/pet/live2d/'
/**
 * motion 起始淡入时长(秒)。素材 json 未写 FadeInTime 时 SDK 默认 1.0s ——
 * 表情渐入太慢会看起来"点了没反应"(加上眨眼被接管,模型近乎静止),这里压到 0.15s。
 */
const MOTION_FADE_IN_SECONDS = 0.15
/**
 * 表情动作涉及的表情参数(停止后需平滑复位回待机基准)。
 * 摸头动画曲线:EyeForm / EyeLOpen/ROpen / EyeLSmile/RSmile / BrowLAngle/RAngle / BrowLY/RY / Cheek;
 * 含 ParamTear(后续 sad 素材用)与嘴部(不涉及但复位无害)。SDK 的 fadeOut 拉向"当前值"
 * (每帧 save 快照已含 motion 值),无法回归待机 → 停止后由运行时指数平滑拉回模型默认值(0037)。
 */
const EXPRESSION_PARAM_IDS = [
  'ParamEyeForm',
  'ParamEyeLOpen',
  'ParamEyeROpen',
  'ParamEyeLSmile',
  'ParamEyeRSmile',
  'ParamBrowLAngle',
  'ParamBrowRAngle',
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamCheek',
  'ParamTear',
  /** sad 表情(0037r)驱动嘴部;摸头不涉及但复位无害。 */
  'ParamMouthOpenY',
] as const
/** 表情复位平滑速度(1/s):≈0.3s 内基本回归待机。 */
const EXPRESSION_RESET_SPEED = 10

/** model3.json 的 HitAreas 条目(运行时自行解析;SDK 的 CubismModelSettingJson 只暴露 Id/Name)。 */
interface ModelHitArea {
  /** Id:新格式引用画布区域,旧格式引用 moc3 里的触碰检测网格(drawable)。 */
  id: string
  name: string
  /** 画布归一化坐标(0..1,原点左上);旧格式(仅 Id/Name)为 undefined。 */
  x?: number
  y?: number
  width?: number
  height?: number
}

/** 从 model3.json buffer 提取 HitAreas(兼容新旧格式;解析失败/无定义返回空数组)。 */
function parseHitAreas(settingBuf: ArrayBuffer): ModelHitArea[] {
  try {
    const json = JSON.parse(new TextDecoder().decode(settingBuf)) as {
      HitAreas?: { Id?: string; Name?: string; X?: number; Y?: number; Width?: number; Height?: number }[]
    }
    return (json.HitAreas ?? []).map((h) => {
      // exactOptionalPropertyTypes:可选属性不能赋显式 undefined,条件写入
      const area: ModelHitArea = { id: h.Id ?? '', name: h.Name ?? '' }
      if (typeof h.X === 'number') area.x = h.X
      if (typeof h.Y === 'number') area.y = h.Y
      if (typeof h.Width === 'number') area.width = h.Width
      if (typeof h.Height === 'number') area.height = h.Height
      return area
    })
  } catch {
    return []
  }
}

/** 屏幕空间的多边形点包含测试(射线法)。 */
function pointInPolygon(x: number, y: number, pts: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i]
    const pj = pts[j]
    if (!pi || !pj) continue
    if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside
  }
  return inside
}

/**
 * 顶点 → 凸包环绕序(Andrew 单调链,0037k):moc3 drawable 顶点数组的顺序不保证
 * 是环绕序,原样连线会自交成沙漏(polygon 显示 + 射线法判定都错)。
 * 凸包输出保证连线不自交;≤3 点或退化(共线)时原样返回(调用方有 ≥3 点兜底)。
 */
function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length <= 3) return points
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: { x: number; y: number }[] = []
  for (const p of pts) {
    while (lower.length >= 2) {
      const b = lower[lower.length - 1]
      const a = lower[lower.length - 2]
      if (!a || !b || cross(a, b, p) > 0) break
      lower.pop()
    }
    lower.push(p)
  }
  const upper: { x: number; y: number }[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    if (!p) continue
    while (upper.length >= 2) {
      const b = upper[upper.length - 1]
      const a = upper[upper.length - 2]
      if (!a || !b || cross(a, b, p) > 0) break
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** 头部 hitarea 命中网格(屏幕坐标,每次按当前帧变形顶点重算)。 */
interface HeadMesh {
  points: { x: number; y: number }[]
  /** 包围盒(HitAreaHead 是 4 顶点矩形,包围盒即网格本身;overlay 定位用)。 */
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * 未拖动时恢复"角度驱动头发"(0036)。
 *
 * 素材 physics3.json 的 Setting1-4 以 ParamAngleX/Y 为输入驱动后发/前发(输出
 * BackHairUp/Down/Swing、HairSwayX/Y),但 Setting5/6(拖动)在末尾以 Type=Angle +
 * Weight=100(绝对赋值)输出同一批头发参数 —— 无拖动时 ParamDrag=0,输出≈0,
 * 把角度驱动的头发摆动整体清零(视线跟随鼠标时头发纹丝不动)。
 *
 * 解法:SDK 的 CubismPhysics._currentRigOutputs 保留每个 setting 各自的粒子输出
 * (raw,未被后续 setting 覆盖)。物理演算后在代码层按"同帧后写覆盖"规则重放
 * 前 HAIR_VIEW_SETTING_COUNT 个 setting(角度),再按 dragBlend 与拖动输出混合:
 * 拖动窗口时由 ParamDragX/Y 物理控制,窗口未拖动时由 ParamAngleX/Y 物理控制。
 */
const HAIR_VIEW_SETTING_COUNT = 4
/** 拖动归一化模(|x|+|y|,0..2)达到该值视为"拖动中"(dragBlend 上升)。 */
const DRAG_BLEND_DEADZONE = 0.03
/** dragBlend 上升速度(1/s):开始拖动时快速切入拖动物理。 */
const DRAG_BLEND_ATTACK = 15
/** dragBlend 回落速度(1/s):停止拖动后缓慢回到角度驱动,保留物理余韵。 */
const DRAG_BLEND_RELEASE = 2

/**
 * CubismPhysics 私有成员的最小结构声明(vendor/live2d 5-r.5,仅读取,不修改)。
 * 升级 SDK 时需核对:settings.baseOutputIndex / outputs.angleScale / _currentRigOutputs。
 */
interface SdkPhysicsRigOutput {
  /** CubismId 实例(getString() 返回参数名)。 */
  destination: { id: { getString(): string } }
  angleScale: number
  weight: number
}
interface SdkPhysicsRig {
  settings: { baseOutputIndex: number; outputCount: number }[]
  outputs: SdkPhysicsRigOutput[]
}
interface SdkPhysicsState {
  _physicsRig: SdkPhysicsRig
  _currentRigOutputs: { outputs: number[] }[]
}

let s_frameworkStarted = false

/** CubismFramework 全局初始化(整个应用只需一次,幂等)。 */
function ensureFrameworkStarted(): void {
  if (s_frameworkStarted) return
  const option = new Option()
  option.logFunction = (message: string): void => {
    console.log(`[live2d/core] ${message}`)
  }
  option.loggingLevel = LogLevel.LogLevel_Warning
  CubismFramework.startUp(option)
  CubismFramework.initialize()
  s_frameworkStarted = true
}

/**
 * 暴露 protected 成员的极简子类(官方惯例:使用时子类化 CubismUserModel)。
 * 仅暴露 physics,其余 protected 成员(pose/blink/breath 等)暂未用到。
 */
class DsPetUserModel extends CubismUserModel {
  get physicsHandle(): CubismPhysics | null {
    return this._physics
  }
}

/** 视角跟随参数在模型中的索引缓存(-1 = 模型里不存在该参数)。 */
interface ParamIndexSet {
  headX: number
  headY: number
  headZ: number
  eyeX: number
  eyeY: number
  bodyX: number
  /** 瞳孔收缩(0..1,0029)。 */
  pupil: number
  /** 拖动物理反馈:左右 / 上下拖动宠物(0032,physics3.json 的输入)。 */
  dragX: number
  dragY: number
  /** 头发参数(物理输出,0036):未拖动时由角度物理重放恢复写入。 */
  hairUp: number
  hairDown: number
  hairSwing: number
  hairSwayX: number
  hairSwayY: number
}

export interface CubismRuntimeOptions {
  /** 承载 canvas 的宿主元素(通常为 #stage)。 */
  host: HTMLElement
  /** model3.json 的 publicDir 相对 URL(如 /pet/live2d/ds-pet.model3.json)。 */
  modelUrl: string
  /** 初始外观(位置/大小);之后由 setAppearance 实时调整(0017)。 */
  appearance: Live2dAppearance
  /** motion 逻辑名 → 素材文件/循环配置;由 animation-registry 派生注入(0037s 单点配置)。 */
  motions?: Record<string, { file: string; loop: boolean }>
}

/** 创建 Cubism 运行时;WebGL2 不可用时返回 null(调用方回落占位动画)。 */
export function createCubismRuntime(options: CubismRuntimeOptions): Live2dRuntime | null {
  ensureFrameworkStarted()

  const canvas = document.createElement('canvas')
  // 不拦截任何指针事件:视角跟随走主进程光标轮询,后续点击热区再单独接。
  canvas.style.pointerEvents = 'none'
  // 关键(0037p):canvas 必须显式铺满宿主 CSS 尺寸。canvas 是替换元素,`inset: 0`
  // 不会拉伸它,默认 CSS 尺寸 = 属性宽高(物理像素 = CSS × dpr)——dpr≠1 时画布
  // 会按 dpr 倍显示(模型放大 + 偏移),且 modelPointToScreen 用 clientWidth 会得到
  // 物理像素坐标系,命中网格/点击区与窗口 CSS 坐标错位。width/height 100% 让
  // 显示尺寸 = 宿主(CSS),渲染与坐标换算全部回到窗口 CSS 坐标系。
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    console.error('[live2d] WebGL2 上下文创建失败(Chromium 必须支持 WebGL2)')
    return null
  }
  options.host.appendChild(canvas)

  return new CubismRuntime(canvas, gl, options.host, { ...options.appearance }, options.motions ?? {})
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch 失败 ${response.status}: ${url}`)
  return response.arrayBuffer()
}

/**
 * 从 motion3.json buffer 提取"曲线驱动的参数 id 集"(0037u)。
 * 新动画接管时用它判断哪些复位参数可以交给曲线、哪些仍需继续复位;
 * 解析失败返回空集(保守:空集 = 不驱动任何参数 → 复位全部保留)。
 */
function parseMotionParamIds(buf: ArrayBuffer): Set<string> {
  try {
    const json = JSON.parse(new TextDecoder().decode(buf)) as {
      Curves?: { Target?: string; Id?: string }[]
    }
    const ids = new Set<string>()
    for (const curve of json.Curves ?? []) {
      if (curve.Target === 'Parameter' && curve.Id) ids.add(curve.Id)
    }
    return ids
  } catch {
    return new Set()
  }
}

/** 按官方示例的方式加载 PNG 纹理(预乘 alpha + mipmap)。 */
function loadPngTexture(gl: WebGL2RenderingContext, url: string): Promise<WebGLTexture> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const tex = gl.createTexture()
      if (!tex) {
        reject(new Error(`createTexture 失败:${url}`))
        return
      }
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.bindTexture(gl.TEXTURE_2D, null)
      resolve(tex)
    }
    img.onerror = () => reject(new Error(`纹理加载失败:${url}`))
    img.src = url
  })
}

/** 外观合法化:位置 0..1(模型中心不出屏),缩放 0.2..3。 */
function clampAppearance(a: Live2dAppearance): Live2dAppearance {
  return {
    positionX: Math.min(1, Math.max(0, a.positionX)),
    positionY: Math.min(1, Math.max(0, a.positionY)),
    scale: Math.min(3, Math.max(0.2, a.scale)),
  }
}

class CubismRuntime implements Live2dRuntime {
  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private readonly host: HTMLElement
  private readonly frameBuffer: WebGLFramebuffer | null

  private appearance: Live2dAppearance
  private userModel: DsPetUserModel | null = null
  private scheduler: CubismUpdateScheduler | null = null
  private breath: CubismBreath | null = null
  private eyeBlink: CubismEyeBlink | null = null
  private autoBlink = true
  private pendingLook: ViewLook | null = null
  /** 拖动物理反馈输入(0032):由 setDrag 暂存,update() 在 load/save 之间写入。 */
  private pendingDrag: { x: number; y: number } | null = null
  /**
   * 拖动混合权重(0036):1 = 头发由拖动物理(Setting5/6)输出驱动,
   * 0 = 由角度物理(Setting1-4)输出驱动。attack 快、release 慢,停止拖动后
   * 缓慢回落以保留拖动余韵。
   */
  private dragBlend = 0
  /** motion 播放队列(按通道,0037s):每通道独立队列,同通道物理互斥。 */
  private readonly motionQueues = new Map<AnimationChannel, CubismMotionQueueManager>()
  /** motion 播放用的累计时间(秒,单调递增,作为 doUpdateMotion 的 userTimeSeconds)。 */
  private motionTime = 0
  /** 各通道当前 motion 开始播放时的全局时间(0037l,计算已播时长用)。 */
  private readonly motionStartTimes = new Map<AnimationChannel, number>()
  /** motion 暂停(0037l):暂停时不推进 motionTime 也不驱动曲线,动画定格当前帧。 */
  private motionPaused = false
  /** 已解析的 motion 缓存(逻辑名 → 实例;null 表示解析失败,不再重试)。 */
  private readonly motionCache = new Map<string, CubismMotion | null>()
  /** 各通道当前正在播放(或正在异步加载)的 motion 逻辑名;无 = 该通道空闲。 */
  private readonly currentMotion = new Map<AnimationChannel, string>()
  /** motion 素材配置(逻辑名 → file/loop),构造注入(0037s)。 */
  private readonly motions: Record<string, { file: string; loop: boolean }>
  /**
   * 表情复位进行中:停止 motion 后把表情参数指数平滑拉回模型默认(待机基准)。
   * 带 id 便于"新动画 start 时只保留其曲线不驱动的参数继续复位"(0037u:避免
   * 新动画曲线覆盖不到的残留参数卡住 → 两个表情叠加)。
   */
  private expressionReset: { params: { id: string; index: number }[] } | null = null
  /** 各 motion 曲线驱动的参数 id 集(解析自 motion3.json Curves;null = 未知/解析失败)。 */
  private readonly motionParamIds = new Map<string, Set<string>>()
  /** model3.json 声明的 HitAreas(素材未导出则为空)。 */
  private hitAreas: ModelHitArea[] = []
  private ready = false
  private disposed = false
  private viewMatrix = new CubismViewMatrix()
  private paramIndex: ParamIndexSet = {
    headX: -1,
    headY: -1,
    headZ: -1,
    eyeX: -1,
    eyeY: -1,
    bodyX: -1,
    pupil: -1,
    dragX: -1,
    dragY: -1,
    hairUp: -1,
    hairDown: -1,
    hairSwing: -1,
    hairSwayX: -1,
    hairSwayY: -1,
  }

  private readonly onResize = (): void => this.resize()

  constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    host: HTMLElement,
    appearance: Live2dAppearance,
    motions: Record<string, { file: string; loop: boolean }>,
  ) {
    this.canvas = canvas
    this.gl = gl
    this.host = host
    this.appearance = clampAppearance(appearance)
    this.motions = motions
    this.frameBuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    this.resize()
    window.addEventListener('resize', this.onResize)
  }

  /** canvas 尺寸/DPR 与视图矩阵随窗口同步。 */
  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(this.host.clientWidth * dpr))
    const h = Math.max(1, Math.round(this.host.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight)
    this.rebuildView()
  }

  /** 按外观(位置/大小)重建视图矩阵:模型画布中心在原点(Y 向上),缩放到 scale 倍后平移到目标点。 */
  private rebuildView(): void {
    const ratio = this.canvas.width / Math.max(1, this.canvas.height)
    const view = new CubismViewMatrix()
    view.setScreenRect(-ratio, ratio, -1, 1)
    view.loadIdentity()
    view.scale(this.appearance.scale, this.appearance.scale)
    const tx = (2 * this.appearance.positionX - 1) * ratio
    const ty = 1 - 2 * this.appearance.positionY
    view.translateRelative(tx, ty)
    this.viewMatrix = view
  }

  setAppearance(appearance: Live2dAppearance): void {
    if (this.disposed) return
    this.appearance = clampAppearance(appearance)
    this.rebuildView()
  }

  /**
   * 构建渲染用投影矩阵(与 update() 渲染路径完全一致):
   * projection(适配) × viewMatrix(位置/缩放) × modelMatrix(画布→NDC)。
   * 同时用于坐标反查(如 HitArea → 屏幕),保证与画出来的位置一致。
   */
  private buildProjectionMatrix(): CubismMatrix44 {
    const userModel = this.userModel
    const model = userModel?.getModel()
    if (!userModel || !model) return new CubismMatrix44()
    const { width, height } = this.canvas
    const projection = new CubismMatrix44()
    const modelMatrix = userModel.getModelMatrix()
    if (model.getCanvasWidth() > 1.0 && width < height) {
      // 横长模型 + 竖窗:按模型宽度适配
      modelMatrix.setWidth(2.0)
      projection.scale(1.0, width / height)
    } else {
      projection.scale(height / width, 1.0)
    }
    projection.multiplyByMatrix(this.viewMatrix)
    projection.multiplyByMatrix(modelMatrix)
    return projection
  }

  /** 模型画布坐标(原点在画布中心,像素单位) → 窗口 CSS px(NDC → 屏幕)。
   *  用宿主(窗口)CSS 尺寸换算,不用 canvas.clientWidth —— #stage canvas 是
   *  position:absolute + inset:0,对替换元素 inset:0 不拉伸(CSS 规范),canvas
   *  CSS 尺寸跟随其属性宽高(物理像素 = CSS × dpr)。dpr≠1 时两者不一致,用
   *  canvas.clientWidth 会把命中网格/点击区整体偏移 dpr 倍(0037p 实测:按住
   *  摸头的"不偏移点"落在可见方框边缘)。 */
  private modelPointToScreen(cx: number, cy: number): { x: number; y: number } {
    const projection = this.buildProjectionMatrix()
    // 投影矩阵无旋转(仅 scale+translate),transformX/Y 只取对角+平移即完整变换
    const nx = projection.transformX(cx)
    const ny = projection.transformY(cy)
    return {
      x: ((nx + 1) / 2) * this.host.clientWidth,
      y: ((1 - ny) / 2) * this.host.clientHeight,
    }
  }

  /**
   * 计算 HitArea 的屏幕命中网格(0037/0037r)。
   * 匹配 Name/Id 含关键字(head/body)的 HitArea,优先取 Id 引用的 moc3 触碰检测
   * 网格(drawable,旧格式,最贴合轮廓);无网格则用矩形坐标(新格式)生成四角。
   * **每次调用按当前帧顶点重算**(不缓存):网格挂在变形器上,顶点随参数变化
   * (0037 实测),缓存会与渲染错位 → 触发区域对不上模型。
   */
  private computeHitMesh(keyword: 'head' | 'body'): HeadMesh | null {
    const model = this.userModel?.getModel()
    if (!model) return null
    const hit = this.hitAreas.find(
      (h) => h.name.toLowerCase().includes(keyword) || h.id.toLowerCase().includes(keyword),
    )
    if (!hit) return null

    // 1) 旧格式:Id 引用触碰检测网格(drawable)—— 顶点多边形(最贴合)
    if (hit.id) {
      const drawableIndex = model.getDrawableIndex(this.id(hit.id))
      if (drawableIndex >= 0) {
        const positions = model.getDrawableVertexPositions(drawableIndex)
        const points: { x: number; y: number }[] = []
        for (let i = 0; i < positions.length; i += 2) {
          const px = positions[i] ?? 0
          const py = positions[i + 1] ?? 0
          points.push(this.modelPointToScreen(px, py))
        }
        if (points.length >= 3) return this.makeHeadMesh(points)
      }
    }

    // 2) 新格式:矩形坐标(画布归一化 → 屏幕四角)
    if (typeof hit.x === 'number' && typeof hit.y === 'number') {
      const canvasW = model.getCanvasWidth()
      const canvasH = model.getCanvasHeight()
      if (canvasW > 0 && canvasH > 0) {
        const w = hit.width ?? 0
        const h = hit.height ?? 0
        const points = [
          this.modelPointToScreen((hit.x - 0.5) * canvasW, (0.5 - hit.y) * canvasH),
          this.modelPointToScreen((hit.x + w - 0.5) * canvasW, (0.5 - hit.y) * canvasH),
          this.modelPointToScreen((hit.x + w - 0.5) * canvasW, (0.5 - (hit.y + h)) * canvasH),
          this.modelPointToScreen((hit.x - 0.5) * canvasW, (0.5 - (hit.y + h)) * canvasH),
        ]
        return this.makeHeadMesh(points)
      }
    }

    return null
  }

  /** 头部 hitarea 命中网格(0037)。 */
  private computeHeadMesh(): HeadMesh | null {
    return this.computeHitMesh('head')
  }

  /** 顶点列表 → 命中网格(包围盒;HitAreaHead 是 4 顶点矩形,包围盒即网格本身)。
   *  顶点按凸包环绕序排列(0037k):drawable 顶点原始顺序可能交叉,直接连线会
   *  自交成沙漏,凸包保证连线为方形轮廓且射线法判定可靠。 */
  private makeHeadMesh(points: { x: number; y: number }[]): HeadMesh {
    const hull = convexHull(points)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of hull) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    return {
      points: hull,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    }
  }

  /** 头部 hitarea 的屏幕包围盒(点击区 overlay 定位用,与命中区域一致);无 hitarea 返回 null。 */
  getHeadPoint(): { x: number; y: number; width: number; height: number } | null {
    const mesh = this.computeHeadMesh()
    return mesh ? { ...mesh.bounds } : null
  }

  /** 头部 hitarea 网格的屏幕顶点(显示点击判定网格,0037);无 hitarea 返回 null。 */
  getHeadMeshPoints(): { x: number; y: number }[] | null {
    const mesh = this.computeHeadMesh()
    return mesh ? mesh.points : null
  }

  /** 身体 hitarea 的屏幕包围盒(身体点击区定位,0037r);无 hitarea 返回 null。 */
  getBodyPoint(): { x: number; y: number; width: number; height: number } | null {
    const mesh = this.computeHitMesh('body')
    return mesh ? { ...mesh.bounds } : null
  }

  /** 身体 hitarea 网格的屏幕顶点(显示点击判定网格,0037r);无 hitarea 返回 null。 */
  getBodyMeshPoints(): { x: number; y: number }[] | null {
    const mesh = this.computeHitMesh('body')
    return mesh ? mesh.points : null
  }

  /** 屏幕坐标是否命中身体 hitarea 网格(点击身体触发 sad,0037r);无 hitarea 返回 undefined。 */
  hitTestBodyPoint(x: number, y: number): boolean | undefined {
    const mesh = this.computeHitMesh('body')
    if (!mesh) return undefined
    return pointInPolygon(x, y, mesh.points)
  }

  /** 屏幕坐标是否命中头部 hitarea 网格(点击摸头精确判定);无 hitarea 返回 undefined 由调用方回落。 */
  hitTestPoint(x: number, y: number): boolean | undefined {
    const mesh = this.computeHeadMesh()
    if (!mesh) return undefined
    return pointInPolygon(x, y, mesh.points)
  }

  loadModel(url: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.loadModelInternal(url)
  }

  private async loadModelInternal(url: string): Promise<void> {
    const base = url.slice(0, url.lastIndexOf('/') + 1)

    // model3.json
    const settingBuf = await fetchArrayBuffer(url)
    const setting = new CubismModelSettingJson(settingBuf, settingBuf.byteLength)
    this.hitAreas = parseHitAreas(settingBuf)

    // moc(打开一致性校验,与官方示例一致;moc3 版本 6 由 Core 06.00.0001 支持)
    const mocName = setting.getModelFileName()
    if (!mocName) throw new Error(`model3.json 未指定 Moc 文件:${url}`)
    const userModel = new DsPetUserModel()
    this.userModel = userModel
    const mocBuf = await fetchArrayBuffer(base + mocName)
    userModel.loadModel(mocBuf, true)
    if (userModel.getModel() == null) throw new Error(`CubismModel 创建失败(可能 moc3 版本不被 Core 支持):${mocName}`)

    // physics(后发摆动) → PhysicsUpdater 进调度器
    this.scheduler = new CubismUpdateScheduler()
    const physicsName = setting.getPhysicsFileName()
    let hasPhysics = false
    if (physicsName) {
      const physBuf = await fetchArrayBuffer(base + physicsName)
      userModel.loadPhysics(physBuf, physBuf.byteLength)
      const physics = userModel.physicsHandle
      if (physics) {
        hasPhysics = true
        this.scheduler.addUpdatableList(new CubismPhysicsUpdater(physics))
      }
    }

    // 呼吸:只驱动模型自带的 ParamBreath(不碰头部角度,避免与视角跟随打架)。
    // CubismBreath 用 addParameterValueById = 当前值 + (offset + peak·sin(2πt/cycle)),
    // 当前值(基准)是模型默认值 0.5 —— 所以 offset 必须为 0,最终才得到 0.5±0.5 = 0..1 的干净摆动
    // (若 offset=0.5 会变成 1.0+0.5·sin,上半截被 clamp 削顶,表现为"一直涨满偶尔泄气")。
    this.breath = CubismBreath.create()
    this.breath.setParameters([
      new BreathParameterData(CubismFramework.getIdManager().getId(PARAM_MANUAL.breath), 0, 0.5, 3.2, 1),
    ])
    this.scheduler.addUpdatableList(new CubismBreathUpdater(this.breath))

    // 眨眼:model3.json 的 EyeBlink 组为空(README §3.4),这里显式注入参数 ID 绕过。
    // updater 的 motionUpdated 回调返回 true 时跳过眨眼 —— 用它做 setAutoBlink 门控。
    this.eyeBlink = CubismEyeBlink.create()
    this.eyeBlink.setParameterIds([
      CubismFramework.getIdManager().getId(PARAM_EXPRESSION.eyeLOpen),
      CubismFramework.getIdManager().getId(PARAM_EXPRESSION.eyeROpen),
    ])
    this.eyeBlink.setBlinkingInterval(3.5)
    this.scheduler.addUpdatableList(new CubismEyeBlinkUpdater(() => !this.autoBlink, this.eyeBlink))
    this.scheduler.sortUpdatableList()

    // 渲染器:独立 GL 上下文 + 着色器(着色器文件由 loadShaders 异步拉取,先画后到)
    userModel.createRenderer(this.canvas.width, this.canvas.height)
    const renderer = userModel.getRenderer()
    renderer.startUp(this.gl)
    renderer.loadShaders(SHADER_PATH)
    renderer.setIsPremultipliedAlpha(true)

    // 纹理
    const texCount = setting.getTextureCount()
    for (let i = 0; i < texCount; i++) {
      const name = setting.getTextureFileName(i)
      if (!name) continue
      const tex = await loadPngTexture(this.gl, base + name)
      renderer.bindTexture(i, tex)
    }

    userModel.setRenderTargetSize(this.canvas.width, this.canvas.height)

    // 视角跟随参数索引缓存
    const model = userModel.getModel()
    this.paramIndex = {
      headX: model.getParameterIndex(this.id(PARAM_HEAD.x)),
      headY: model.getParameterIndex(this.id(PARAM_HEAD.y)),
      headZ: model.getParameterIndex(this.id(PARAM_HEAD.z)),
      eyeX: model.getParameterIndex(this.id(PARAM_EYE.x)),
      eyeY: model.getParameterIndex(this.id(PARAM_EYE.y)),
      bodyX: model.getParameterIndex(this.id(PARAM_BODY.x)),
      pupil: model.getParameterIndex(this.id(PARAM_MANUAL.pupilSize)),
      dragX: model.getParameterIndex(this.id(PARAM_DRAG.x)),
      dragY: model.getParameterIndex(this.id(PARAM_DRAG.y)),
      hairUp: model.getParameterIndex(this.id(PARAM_BACK_HAIR.up)),
      hairDown: model.getParameterIndex(this.id(PARAM_BACK_HAIR.down)),
      hairSwing: model.getParameterIndex(this.id(PARAM_BACK_HAIR.swing)),
      hairSwayX: model.getParameterIndex(this.id(PARAM_HAIR_SWAY.x)),
      hairSwayY: model.getParameterIndex(this.id(PARAM_HAIR_SWAY.y)),
    }

    this.ready = true
    console.info(
      `[live2d] 模型就绪:${url} | 参数数:${model.getParameterCount()} | 物理:${hasPhysics} | 纹理:${texCount} | 眨眼:on | 呼吸:on`,
    )
  }

  private id(name: string): CubismIdHandle {
    return CubismFramework.getIdManager().getId(name)
  }

  /** 归一化 -1..1 → 参数实际值(以参数 min/max/default 为准)。 */
  private setParam(model: CubismModel, index: number, norm: number): void {
    if (index < 0) return
    const min = model.getParameterMinimumValue(index)
    const max = model.getParameterMaximumValue(index)
    const def = model.getParameterDefaultValue(index)
    if (max <= min) {
      model.setParameterValueByIndex(index, def)
      return
    }
    const value = norm >= 0 ? def + norm * (max - def) : def + norm * (def - min)
    model.setParameterValueByIndex(index, value)
  }

  setViewLook(look: ViewLook): void {
    if (this.disposed) return
    // 只暂存,由 update() 在 loadParameters 之后、saveParameters 之前写入(0019 呼吸修复)。
    this.pendingLook = { ...look }
  }

  setDrag(drag: { x: number; y: number }): void {
    if (this.disposed) return
    // 与 setViewLook 同节奏:物理演算(调度器)在 saveParameters 之后读取输入参数,
    // 这里暂存、update() 在 load/save 之间写入,保证每帧读到的是本帧的拖动值。
    this.pendingDrag = { x: drag.x, y: drag.y }
  }

  private applyDrag(model: CubismModel, drag: { x: number; y: number }): void {
    this.setParam(model, this.paramIndex.dragX, drag.x)
    this.setParam(model, this.paramIndex.dragY, drag.y)
  }

  /**
   * 把鼠标跟随的 headY 增量叠加回 ParamAngleY。
   *
   * 素材 physics3.json 的 PhysicsSetting5 以 ParamDragY 为输入、ParamAngleY 为输出
   * (Scale 30,Weight 100):物理演算在 saveParameters 之后按"直接赋值"覆盖 ParamAngleY,
   * 会抹掉视角跟随刚写入的 headY(上下转头)。这里在物理演算之后再按 headY 的
   * "相对默认值增量"加算回去 —— 拖动点头(物理)与鼠标上下转头(跟随)共存:
   * 最终 ParamAngleY = 物理拖动输出 + headY 增量。
   */
  private addViewHeadYDelta(model: CubismModel, norm: number): void {
    const index = this.paramIndex.headY
    if (index < 0) return
    const min = model.getParameterMinimumValue(index)
    const max = model.getParameterMaximumValue(index)
    const def = model.getParameterDefaultValue(index)
    if (max <= min) return
    // 与 setParam 同映射:norm>=0 → def + norm·(max-def),否则 def + norm·(def-min);
    // 这里只取"相对默认值的增量",加在物理输出之上。
    const delta = norm >= 0 ? norm * (max - def) : norm * (def - min)
    model.addParameterValueByIndex(index, delta)
  }

  private applyViewLook(model: CubismModel, look: ViewLook): void {
    this.setParam(model, this.paramIndex.headX, look.headX)
    // headY(上下转头)也要写入:物理 Setting2/4 以 ParamAngleY 为输入驱动头发,
    // 输入快照需要看到上下转头(0036)。物理 Setting5 会在 saveParameters 之后
    // 绝对覆盖 ParamAngleY(拖动点头),由 update() 在物理演算后 addViewHeadYDelta 加回增量。
    this.setParam(model, this.paramIndex.headY, look.headY)
    this.setParam(model, this.paramIndex.headZ, look.headZ)
    this.setParam(model, this.paramIndex.eyeX, look.eyeX)
    this.setParam(model, this.paramIndex.eyeY, look.eyeY)
    this.setParam(model, this.paramIndex.bodyX, look.bodyX)
    // 瞳孔收缩:ParamPupilSize 已从 moc3 核实 min=0 / default=0 / max=1(0029),
    // 归一化 0..1 经 setParam 线性映射 → 0=正常,1=缩到最小;与视角方向无关,单独写
    this.setParam(model, this.paramIndex.pupil, look.pupilContract)
  }

  /**
   * 拖动混合权重:按本帧拖动输入强度平滑 —— 开始拖动快速上升(切入拖动物理),
   * 停止拖动缓慢回落(角度驱动接管,同时保留物理余韵)。
   */
  private updateDragBlend(deltaSeconds: number): void {
    if (!this.pendingDrag) return
    const mag = Math.abs(this.pendingDrag.x) + Math.abs(this.pendingDrag.y)
    const target = mag >= DRAG_BLEND_DEADZONE ? 1 : 0
    const speed = target > this.dragBlend ? DRAG_BLEND_ATTACK : DRAG_BLEND_RELEASE
    const k = 1 - Math.exp(-speed * deltaSeconds)
    this.dragBlend += (target - this.dragBlend) * k
  }

  /**
   * 物理演算后,把"角度驱动的头发输出"重放回参数(0036)。
   *
   * SDK 物理按 JSON 顺序逐 setting 绝对赋值,Setting5/6(拖动)在末尾把 Setting1-4
   * (角度)写好的后发/前发参数清零(无拖动时输出≈0)。SDK 内部 `_currentRigOutputs`
   * 保留每个 setting 各自的粒子输出(raw,未被后续覆盖):这里按"同帧后写覆盖"规则
   * 重放前 HAIR_VIEW_SETTING_COUNT 个 setting 对头发参数的输出(乘 angleScale 并
   * clamp 到参数范围),再按 dragBlend 与当前值(拖动输出)混合。
   *
   * 依赖 SDK 私有结构,见 SdkPhysicsState;素材重导若改变 Setting 顺序(角度应在
   * 拖动之前)或输出类型(非 Angle 需用 translationScale)需同步本方法。
   */
  private restoreHairFromAnglePhysics(model: CubismModel): void {
    const physics = this.userModel?.physicsHandle
    if (!physics) return
    const state = physics as unknown as SdkPhysicsState
    const rig = state._physicsRig
    const rigOutputs = state._currentRigOutputs
    if (!rig || !rigOutputs || rigOutputs.length < HAIR_VIEW_SETTING_COUNT) return

    const blend = this.dragBlend
    for (let s = 0; s < HAIR_VIEW_SETTING_COUNT; s++) {
      const setting = rig.settings[s]
      const settingOutputs = rigOutputs[s]?.outputs
      if (!setting || !settingOutputs) continue
      for (let j = 0; j < setting.outputCount; j++) {
        const out = rig.outputs[setting.baseOutputIndex + j]
        if (!out) continue
        // destination.id 是 CubismId 实例,必须 getString() 取参数名(否则 switch 永不匹配)
        const index = this.hairIndexByParamId(out.destination.id.getString())
        if (index < 0) continue
        // raw = 该 setting 的粒子输出(未乘 Scale);素材输出均为 Type=Angle → angleScale。
        // 当前素材 Weight=100(绝对赋值),低权重混合不重放(需自行按 weight 混合)。
        const raw = settingOutputs[j] ?? 0
        const min = model.getParameterMinimumValue(index)
        const max = model.getParameterMaximumValue(index)
        const restored = Math.min(max, Math.max(min, raw * out.angleScale))
        if (blend > 0) {
          const current = model.getParameterValueByIndex(index)
          model.setParameterValueByIndex(index, current * blend + restored * (1 - blend))
        } else {
          model.setParameterValueByIndex(index, restored)
        }
      }
    }
  }

  /** 参数 ID → 头发参数索引(-1 = 非头发参数 / 模型不存在)。 */
  private hairIndexByParamId(id: string): number {
    switch (id) {
      case PARAM_BACK_HAIR.up:
        return this.paramIndex.hairUp
      case PARAM_BACK_HAIR.down:
        return this.paramIndex.hairDown
      case PARAM_BACK_HAIR.swing:
        return this.paramIndex.hairSwing
      case PARAM_HAIR_SWAY.x:
        return this.paramIndex.hairSwayX
      case PARAM_HAIR_SWAY.y:
        return this.paramIndex.hairSwayY
      default:
        return -1
    }
  }

  update(deltaSeconds: number): void {
    if (!this.ready || this.disposed) return
    const userModel = this.userModel
    const model = userModel?.getModel()
    if (!userModel || !model) return
    if (this.gl.isContextLost()) return

    // 官方示例的 load/save 节奏(0019):呼吸等"加算型"更新器(CubismBreath 用
    // addParameterValueById = current + value)若跨帧累加,会被参数 clamp 钉死在极值。
    // 每帧先恢复基准、写入跟随参数、再保存基准,调度器效果只生效一帧、下帧重算。
    model.loadParameters()
    // motion 曲线(摸头等表情动作)写参数:SDK 内部不做 load/save,只按当前值
    // setParameterValueByIndex(见 CubismMotion.doUpdateParameters),因此在这里
    // (load 之后、视角跟随之前)更新只覆盖有曲线的表情参数,不碰头部/眼珠视角参数;
    // 写完后进入 save 快照,物理/渲染正常走。眨眼由 autoBlink=false 让位(motion 接管眼睛)。
    // 暂停(0037l)时冻结时间与曲线驱动:按住摸头时动画定格在闭眼保持帧,松开后继续。
    // 多通道(0037s):每通道独立队列,共享同一 motionTime 基准(各通道起点记在 motionStartTimes)。
    if (!this.motionPaused) {
      this.motionTime += deltaSeconds
      for (const queue of this.motionQueues.values()) {
        queue.doUpdateMotion(model, this.motionTime)
      }
    }
    // 非循环动画播完(队列清空)自动复位表情,无需等 stopChannel(0037):
    // 摸头动画自然结束 → 表情停在结尾值 → 平滑拉回待机,避免残留
    for (const channel of [...this.currentMotion.keys()]) {
      const queue = this.motionQueues.get(channel)
      if (queue?.isFinished()) {
        this.currentMotion.delete(channel)
        this.motionStartTimes.delete(channel)
        this.beginExpressionReset()
      }
    }
    // 表情复位:停止 motion 后每帧把表情参数指数拉回模型默认(待机基准)。
    // 不能依赖 SDK fadeOut——它拉向"当前值",而当前值快照已含 motion 表情 → 残留。
    if (this.expressionReset) {
      let done = true
      for (const { index } of this.expressionReset.params) {
        const def = model.getParameterDefaultValue(index)
        const cur = model.getParameterValueByIndex(index)
        const next = cur + (def - cur) * (1 - Math.exp(-EXPRESSION_RESET_SPEED * deltaSeconds))
        model.setParameterValueByIndex(index, next)
        if (Math.abs(next - def) > 0.02) done = false
      }
      if (done) this.expressionReset = null
    }
    if (this.pendingLook) this.applyViewLook(model, this.pendingLook)
    // 拖动物理反馈输入(0032):物理演算读参数当前值做归一化,先写再 save,每帧生效
    if (this.pendingDrag) this.applyDrag(model, this.pendingDrag)
    model.saveParameters()

    // 调度器:物理(后发随头部角度摆动)+ 眨眼 + 呼吸(在基准上一次性加算)
    this.scheduler?.onLateUpdate(model, deltaSeconds)
    // 拖动混合权重:拖动中 → 1(头发由拖动物理输出),停止 → 0(角度物理接管)
    this.updateDragBlend(deltaSeconds)
    // 未拖动时,把被拖动 Setting5/6 清零的角度驱动头发输出重放回来(0036)
    this.restoreHairFromAnglePhysics(model)
    // 物理输出 ParamDragY→ParamAngleY 会覆盖视角跟随的 headY(上下转头),
    // 这里把 headY 增量叠加回去:拖动点头(物理)与鼠标转头(跟随)共存。
    if (this.pendingLook) this.addViewHeadYDelta(model, this.pendingLook.headY)
    // 核心更新:参数 → 网格
    model.update()

    // 渲染(独立 canvas,背景透明)
    const gl = this.gl
    const offscreen = CubismWebGLOffscreenManager.getInstance()
    offscreen.beginFrameProcess(gl)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    const { width, height } = this.canvas
    const projection = this.buildProjectionMatrix()

    const renderer = userModel.getRenderer()
    renderer.setMvpMatrix(projection)
    // 默认帧缓冲绑定可能为 null(webgl 默认绑定),框架按 lastFbo 语义处理
    renderer.setRenderState(this.frameBuffer as WebGLFramebuffer, [0, 0, width, height])
    renderer.drawModel(SHADER_PATH)

    offscreen.endFrameProcess(gl)
    offscreen.releaseStaleRenderTextures(gl)
  }

  setAutoBlink(on: boolean): void {
    this.autoBlink = on
    console.debug(`[live2d] setAutoBlink(${on})`)
  }

  /**
   * 播放一个表情动作(motion3,按逻辑名查注入的素材配置,0037s)。
   * channel 指定通道:同通道 start 前先停旧动画(物理互斥,杜绝并行重叠)。
   * 异步加载与解析,结果缓存;同一 channel 同一 motion 已在播时忽略重复调用。
   */
  playMotion(name: string, channel: AnimationChannel): void {
    if (this.disposed || !this.ready) {
      console.warn(`[live2d] playMotion("${name}") 跳过:运行时未就绪`)
      return
    }
    // 同步登记:异步加载期间 isChannelActive 即返回 true,幂等检查同时生效
    if (this.currentMotion.get(channel) === name) return
    this.currentMotion.set(channel, name)
    void this.startMotion(name, channel)
  }

  private async startMotion(name: string, channel: AnimationChannel): Promise<void> {
    const config = this.motions[name]
    if (!config) {
      console.warn(`[live2d] playMotion("${name}") 未知 motion 名(未在 registry 注册)`)
      this.currentMotion.delete(channel)
      return
    }

    let motion = this.motionCache.get(name)
    let paramIds = this.motionParamIds.get(name)
    if (motion === undefined || paramIds === undefined) {
      try {
        const buf = await fetchArrayBuffer(MOTION_BASE_URL + config.file)
        // SDK 5-r.5 的 CubismMotion.create 不读 json 的 Loop 字段(见 SDK 源码,
        // create 内 _loop 赋值被注释),按素材配置显式 setLoop。
        const instance = CubismMotion.create(buf, buf.byteLength)
        instance.setLoop(config.loop)
        // 素材未写 FadeInTime 时 SDK 默认 1.0s,表情渐入太慢(看起来没反应),压短
        instance.setFadeInTime(MOTION_FADE_IN_SECONDS)
        // 关键:不 setEffectIds 时 _eyeBlinkParameterIds/_lipSyncParameterIds 为 null,
        // doUpdateParameters 首帧就抛 null.length TypeError → 动画器 tick 崩溃、模型
        // 定格"完全静止"(0037 实测)。本模型 EyeBlink/LipSync 组为空,传空数组即可。
        instance.setEffectIds([], [])
        motion = instance
        // 曲线驱动的参数 id 集(0037u):新动画接管时只保留其曲线"不覆盖"的复位参数
        paramIds = parseMotionParamIds(buf)
      } catch (error) {
        console.error(`[live2d] motion 加载失败:${config.file}`, error)
        motion = null
        paramIds = new Set()
      }
      this.motionCache.set(name, motion)
      this.motionParamIds.set(name, paramIds)
    }
    if (!motion || this.disposed) {
      if (!motion) this.currentMotion.delete(channel)
      return
    }
    // 加载期间被 stopChannel / 换了新动画 → 放弃本次 start(避免过期动画抢播)
    if (this.currentMotion.get(channel) !== name) return

    // 物理互斥(doc/09 §3.5):同通道 start 前先停旧动画 —— 即使绕过仲裁层直接
    // 调用,同一通道也不可能两条动画并行(0037s 修"两个动画重叠"的直接手段)。
    const queue = this.getMotionQueue(channel)
    queue.stopAllMotions()
    queue.startMotion(motion, false)
    // 新动画接管:上一动画被打断后的复位若整体取消,其曲线"不覆盖"的参数会残留
    // (如 sad 不驱动摸头的闭眼/微笑 → 两个表情叠加,0037u)——只保留新动画不驱动
    // 的参数继续复位,新动画驱动的参数交给曲线;记录起点(已播时长 = motionTime - start)。
    this.expressionReset = this.keepUncoveredReset(this.expressionReset, paramIds)
    this.motionStartTimes.set(channel, this.motionTime)
    this.motionPaused = false
    console.info(`[live2d] playMotion("${name}") 开始(channel=${channel})`)
  }

  /**
   * 缩减进行中的复位(0037u):只保留新动画曲线"不驱动"的参数继续拉回默认。
   * 新动画驱动的参数由曲线接管(避免复位与曲线每帧打架);无剩余参数返回 null。
   */
  private keepUncoveredReset(
    reset: { params: { id: string; index: number }[] } | null,
    driven: Set<string>,
  ): { params: { id: string; index: number }[] } | null {
    if (!reset) return null
    const params = reset.params.filter((p) => !driven.has(p.id))
    return params.length > 0 ? { params } : null
  }

  /** 按通道懒创建 motion 队列(0037s)。 */
  private getMotionQueue(channel: AnimationChannel): CubismMotionQueueManager {
    let queue = this.motionQueues.get(channel)
    if (!queue) {
      queue = new CubismMotionQueueManager()
      this.motionQueues.set(channel, queue)
    }
    return queue
  }

  /**
   * 开始表情复位:把表情参数指数平滑拉回模型默认(待机基准)。
   * 收集 EXPRESSION_PARAM_IDS 中模型存在的参数(id + 索引);模型未就绪则跳过。
   */
  private beginExpressionReset(): void {
    const model = this.userModel?.getModel()
    if (!model) return
    // 复位 = 摸头结束 = idle:恢复自动眨眼(motion 不再接管眼睛)
    this.setAutoBlink(true)
    const params: { id: string; index: number }[] = []
    for (const id of EXPRESSION_PARAM_IDS) {
      const index = model.getParameterIndex(this.id(id))
      if (index >= 0) params.push({ id, index })
    }
    if (params.length > 0) this.expressionReset = { params }
  }

  /**
   * 停止某通道当前动画:立即清队列(不再写参数),并开始把表情参数指数平滑拉回
   * 模型默认值(待机基准)。SDK fadeOut 拉向"当前值"而非默认值,会残留摸头表情,
   * 故弃用,由运行时自行复位(0037)。非循环动画播完也会自动复位(见 update())。
   */
  stopChannel(channel: AnimationChannel): void {
    const queue = this.motionQueues.get(channel)
    const hadMotion = this.currentMotion.has(channel) || queue !== undefined
    this.currentMotion.delete(channel)
    this.motionStartTimes.delete(channel)
    this.motionPaused = false
    queue?.stopAllMotions()
    if (hadMotion) this.beginExpressionReset()
  }

  /** 该通道当前是否有动画在播(含异步加载中);结束/复位中返回 false。 */
  isChannelActive(channel: AnimationChannel): boolean {
    return this.currentMotion.has(channel)
  }

  /** 暂停/恢复 motion 时间推进(0037l):暂停期间动画定格当前帧,恢复后从冻结处继续。 */
  setMotionPaused(paused: boolean): void {
    this.motionPaused = paused
  }

  /** 某通道当前 motion 已播时长(秒,从本 motion 起点计);无播放中的 motion 返回 -1。 */
  getMotionElapsed(channel: AnimationChannel): number {
    const start = this.motionStartTimes.get(channel)
    return this.currentMotion.has(channel) && start !== undefined ? this.motionTime - start : -1
  }

  playExpression(name: string): void {
    console.warn(`[live2d] playExpression("${name}") 未接入:尚未制作 exp3 素材`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    window.removeEventListener('resize', this.onResize)
    this.scheduler?.release()
    this.scheduler = null
    for (const queue of this.motionQueues.values()) queue.release()
    this.motionQueues.clear()
    this.motionCache.clear()
    this.motionParamIds.clear()
    this.currentMotion.clear()
    this.motionStartTimes.clear()
    this.motionPaused = false
    this.expressionReset = null
    if (this.breath) CubismBreath.delete(this.breath)
    this.breath = null
    if (this.eyeBlink) CubismEyeBlink.delete(this.eyeBlink)
    this.eyeBlink = null
    this.userModel?.release()
    this.userModel = null
    this.canvas.remove()
    console.info('[live2d] 运行时已释放')
  }
}
