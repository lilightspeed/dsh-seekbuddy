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
import { CubismPhysicsUpdater } from '@live2d/framework/motion/cubismphysicsupdater'
import { CubismUpdateScheduler } from '@live2d/framework/motion/cubismupdatescheduler'
import { CubismPhysics } from '@live2d/framework/physics/cubismphysics'
import { CubismWebGLOffscreenManager } from '@live2d/framework/rendering/cubismoffscreenmanager'
import { PARAM_HEAD, PARAM_EYE, PARAM_BODY, PARAM_MANUAL, PARAM_EXPRESSION, PARAM_DRAG, PARAM_BACK_HAIR, PARAM_HAIR_SWAY, type ViewLook } from './parameters.ts'
import type { Live2dAppearance, Live2dRuntime } from './runtime.ts'

/**
 * Cubism SDK for Web 5-r.5 的 Live2dRuntime 实现 —— 独立 WebGL2 canvas 自绘(doc/08 §4 结论)。
 *
 * 职责(全部在本类内,外部零 SDK 依赖):
 * - 自建 canvas 挂进宿主(#stage),随窗口 resize / devicePixelRatio 同步;
 * - 异步加载 model3.json → moc → physics → 纹理,构建 UpdateScheduler(物理 + 呼吸);
 * - 每帧:写视角跟随参数(含瞳孔收缩 0..1)→ scheduler 跑物理(后发随头部角度自动摆动)→ model.update → 渲染;
 * - 视角跟随参数用归一化 -1..1 输入(瞳孔通道 0..1),内部按参数实际 min/max/default 映射(见 setViewLook)。
 *
 * 许可与版本见 vendor/live2d/README.md;接入流程见 runtime.ts 顶部注释。
 */

/** 着色器静态根(publicDir=assets,文件在 assets/pet/live2d/shaders/)。 */
const SHADER_PATH = '/pet/live2d/shaders/'

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
}

/** 创建 Cubism 运行时;WebGL2 不可用时返回 null(调用方回落占位动画)。 */
export function createCubismRuntime(options: CubismRuntimeOptions): Live2dRuntime | null {
  ensureFrameworkStarted()

  const canvas = document.createElement('canvas')
  // 不拦截任何指针事件:视角跟随走主进程光标轮询,后续点击热区再单独接。
  canvas.style.pointerEvents = 'none'
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    console.error('[live2d] WebGL2 上下文创建失败(Chromium 必须支持 WebGL2)')
    return null
  }
  options.host.appendChild(canvas)

  return new CubismRuntime(canvas, gl, options.host, { ...options.appearance })
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch 失败 ${response.status}: ${url}`)
  return response.arrayBuffer()
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
  ) {
    this.canvas = canvas
    this.gl = gl
    this.host = host
    this.appearance = clampAppearance(appearance)
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

  loadModel(url: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.loadModelInternal(url)
  }

  private async loadModelInternal(url: string): Promise<void> {
    const base = url.slice(0, url.lastIndexOf('/') + 1)

    // model3.json
    const settingBuf = await fetchArrayBuffer(url)
    const setting = new CubismModelSettingJson(settingBuf, settingBuf.byteLength)

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

  playMotion(name: string): void {
    console.warn(`[live2d] playMotion("${name}") 未接入:尚未制作 motion3 素材`)
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
