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
import { PARAM_HEAD, PARAM_EYE, PARAM_BODY, PARAM_MANUAL, PARAM_EXPRESSION, PARAM_DRAG, type ViewLook } from './parameters.ts'
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

  private applyViewLook(model: CubismModel, look: ViewLook): void {
    this.setParam(model, this.paramIndex.headX, look.headX)
    this.setParam(model, this.paramIndex.headY, look.headY)
    this.setParam(model, this.paramIndex.headZ, look.headZ)
    this.setParam(model, this.paramIndex.eyeX, look.eyeX)
    this.setParam(model, this.paramIndex.eyeY, look.eyeY)
    this.setParam(model, this.paramIndex.bodyX, look.bodyX)
    // 瞳孔收缩:ParamPupilSize 已从 moc3 核实 min=0 / default=0 / max=1(0029),
    // 归一化 0..1 经 setParam 线性映射 → 0=正常,1=缩到最小;与视角方向无关,单独写
    this.setParam(model, this.paramIndex.pupil, look.pupilContract)
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
