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
  /** 写视角跟随参数:归一化 -1..1,内部映射到参数实际 min/max 并 clamp。 */
  setViewLook(look: ViewLook): void
  /** 应用外观(位置/大小):重建视图矩阵,下一帧生效。 */
  setAppearance(appearance: Live2dAppearance): void
  /** 开关自动眨眼 / 呼吸(idle 开,thinking 关)。 */
  setAutoBlink(on: boolean): void
  /** 播动作(motion3;后续里程碑,未实现可忽略)。 */
  playMotion(name: string): void
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
