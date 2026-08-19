import type { ViewLook } from './parameters.ts'

/** 宠物外观:模型中心位置(窗口比例 0..1)与显示缩放;设置面板实时调整(0017)。 */
export interface Live2dAppearance {
  /** 模型中心水平位置(窗口比例 0..1)。 */
  positionX: number
  /** 模型中心垂直位置(窗口比例 0..1)。 */
  positionY: number
  /** 显示缩放倍率(1 = 默认适配)。 */
  scale: number
}

/**
 * 动画通道(0037s,doc/09):按"参数作用域"分组 —— 同通道互斥、跨通道并存。
 * - expression:脸部表情参数,同一时刻最多一个(摸头/sad)。
 * - action:身体/位移类参数(未来:走路/跳跃),同一时刻最多一个;可与 expression 并存。
 * 新增动画只扩 union + registry 条目,仲裁/播放代码零改动。
 */
export type AnimationChannel = 'expression' | 'action'

/**
 * Live2D 运行时适配层 —— 官方 Cubism SDK for Web 的唯一接缝(doc/08 §4)。
 *
 * 当前未 vendor SDK,默认无运行时注册;createLive2dAnimator 检测不到注册时
 * 回落占位球宠,应用行为零变化。
 *
 * 接入步骤(官方 SDK 到位后):
 * 1. 下载 Cubism SDK for Web(https://www.live2d.com/download/cubism-sdk/download-web/),
 *    锁定与 Editor/Core 匹配的版本(本模型 moc3 版本 = 6,见 assets/pet/live2d/README.md §3.1)。
 * 2. vendor framework 源码 + live2dcubismcore.min.js 进仓库(保留许可声明),见 doc/08 §6.3。
 * 3. 新建 live2d/cubism-runtime.ts 实现本接口:内部负责
 *    CubismFramework.initialize → CubismModel3Json → CubismMoc → CubismModel;
 *    自建 WebGL canvas 挂进 #stage,处理 resize / devicePixelRatio;物理演算在 update() 内执行
 *    (后发随头部转动自动摆动,零代码)。
 * 4. 在 main.ts 启动早期 import 该模块(模块加载时自行 registerLive2dRuntime),
 *    createLive2dAnimator 即自动启用 Live2D。
 */
export interface Live2dRuntime {
  /** 加载模型(model3.json 的 publicDir 相对 URL,如 /pet/live2d/ds-pet.model3.json)。 */
  loadModel(url: string): Promise<void>
  /** 每帧推进模型(SDK 物理演算在此执行)。 */
  update(deltaSeconds: number): void
  /** 写视角跟随参数:视角通道归一化 -1..1、瞳孔通道 0..1,内部映射到参数实际 min/max 并 clamp。 */
  setViewLook(look: ViewLook): void
  /**
   * 写拖动物理反馈输入:归一化 -1..1(窗口拖动位移比例),内部映射到 ParamDragX/Y
   * 实际 min/max 并 clamp。物理演算(physics3.json)据此输出尾巴/头发的惯性摆动(0032)。
   */
  setDrag(drag: { x: number; y: number }): void
  /** 应用外观(位置/大小):重建视图矩阵,下一帧生效。 */
  setAppearance(appearance: Live2dAppearance): void
  /** 开关自动眨眼 / 呼吸(idle 开,thinking 关)。 */
  setAutoBlink(on: boolean): void
  /**
   * 播动作(motion3;按逻辑名,运行时自行映射素材文件)。
   * channel 指定通道:同通道 start 前强制 stop 旧动画(物理互斥,见 doc/09 §3.5),
   * 跨通道(未来 action + expression)互不干扰。
   */
  playMotion(name: string, channel: AnimationChannel): void
  /** 停止某通道当前动画(参数平滑复位回归待机);该通道无动画时无操作。 */
  stopChannel(channel: AnimationChannel): void
  /** 该通道当前是否有动画在播(含异步加载中);结束/复位中返回 false。 */
  isChannelActive(channel: AnimationChannel): boolean
  /**
   * 暂停/恢复 motion 时间推进(0037l):暂停时不推进 motion 时钟也不驱动曲线,
   * 动画定格在当前帧;恢复后从冻结处继续播放。可选:占位/测试实现可不提供。
   */
  setMotionPaused?(paused: boolean): void
  /** 某通道当前 motion 已播放秒数(从本 motion 起点计);无播放中的 motion 返回 -1。 */
  getMotionElapsed?(channel: AnimationChannel): number
  /**
   * 把某通道当前 motion 的播放位置跳到指定秒数(0037v):
   * 按下摸头瞬间直接定格在"保持帧"(脸红闭眼),无需等动画自然播放到 holdAt。
   * motion 仍在异步加载时记录待生效目标,开始播放后立即应用。可选:占位/测试实现可不提供。
   */
  seekMotion?(channel: AnimationChannel, seconds: number): void
  /**
   * 设置某通道 motion 的播放倍速(0037w/0037z):>1 加速,1 原速(缺省),
   * **负数 = 反向播放**(每帧时间按 rate 倍倒退,曲线均匀倒回,0037z 用于
   * 已睁眼段按下时平滑倒带回保持帧,替代瞬间 seek 跳变)。播放期间可随时
   * 切换,不影响 entry startTime 与 elapsed 语义。可选:占位/测试实现可不提供。
   */
  setMotionRate?(channel: AnimationChannel, rate: number): void
  /**
   * 头部 hitarea 的屏幕包围盒(点击区 overlay 定位用,与命中区域一致;素材未导出
   * HitAreas 返回 null,调用方回退估算)。可选:占位/测试实现可不提供。
   */
  getHeadPoint?(): { x: number; y: number; width: number; height: number } | null
  /** 头部 hitarea 网格的屏幕顶点(显示点击判定网格用;无 hitarea 返回 null)。 */
  getHeadMeshPoints?(): { x: number; y: number }[] | null
  /**
   * 屏幕坐标是否命中头部 hitarea 网格(旧格式 Id 引用的触碰检测网格做点包含测试)。
   * 无 hitarea 返回 undefined(调用方回落为 overlay 圆内即命中)。
   */
  hitTestPoint?(x: number, y: number): boolean | undefined
  /** 身体 hitarea 的屏幕包围盒(点击区定位,0037r;素材未导出返回 null)。 */
  getBodyPoint?(): { x: number; y: number; width: number; height: number } | null
  /** 身体 hitarea 网格的屏幕顶点(显示点击判定网格用;无 hitarea 返回 null)。 */
  getBodyMeshPoints?(): { x: number; y: number }[] | null
  /** 屏幕坐标是否命中身体 hitarea 网格(点击身体触发 sad,0037r);无 hitarea 返回 undefined。 */
  hitTestBodyPoint?(x: number, y: number): boolean | undefined
  /** 切表情(exp3;后续里程碑,未实现可忽略)。 */
  playExpression(name: string): void
  /** 释放 canvas / WebGL 上下文 / 事件监听。 */
  dispose(): void
}

let registered: Live2dRuntime | undefined

/** 注册运行时(通常在 Live2D 适配模块加载时调用一次)。 */
export function registerLive2dRuntime(runtime: Live2dRuntime): void {
  registered = runtime
}

/** 读取已注册的运行时;未注册返回 undefined(调用方回落占位动画)。 */
export function getLive2dRuntime(): Live2dRuntime | undefined {
  return registered
}
