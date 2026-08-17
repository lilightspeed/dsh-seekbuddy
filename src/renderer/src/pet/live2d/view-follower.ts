import type { ViewLook } from './parameters.ts'

/**
 * 视角跟随核心逻辑(纯计算,无 DOM / SDK 依赖):
 * 鼠标相对角色头部锚点的偏移 → 归一化目标值(-1..1)→ 按通道平滑。
 *
 * 与 Live2D 解耦:输出是归一化值,由 Live2dRuntime 适配层映射到参数实际 min/max。
 * 头部 / 眼珠 / 身体各有独立幅度上限与平滑速度,眼珠快、头慢、身体最慢,
 * 才有"眼睛先转、头随后、身体轻晃"的自然感。
 *
 * 距离映射(0017):t = 1 - exp(-(dist - deadZone) / distanceScale),指数趋近饱和 ——
 * 窗口内外鼠标的距离都持续影响幅度(线性截断会让"鼠标移出窗口后远近失效")。
 * Y 通道取反:屏幕坐标 y 向下,而 Live2D ParamAngleY 正向为抬头 —— 鼠标在上方应抬头。
 */

export interface ViewFollowerConfig {
  /** 鼠标距锚点小于该距离(px)不响应 —— 防抖,避免锚点附近抖动。 */
  deadZoneRadius: number
  /** 距离曲线尺度(px):值越小,同样距离产生的幅度越大。 */
  distanceScale: number
  /** 眼珠最大归一化幅度(0..1]。 */
  eyeMax: number
  /** 头部最大归一化幅度(0..1]。 */
  headMax: number
  /** 身体最大归一化幅度(0..1,0 = 不联动)。 */
  bodyMax: number
  /** 各通道平滑速度(1/s):越大跟得越快。 */
  smoothing: { eye: number; head: number; body: number }
  /** 跟随被禁用时回到中心的速度(1/s)。 */
  recenterSpeed: number
}

export const DEFAULT_FOLLOWER_CONFIG: ViewFollowerConfig = {
  deadZoneRadius: 12,
  distanceScale: 320,
  eyeMax: 1,
  headMax: 0.9,
  bodyMax: 0.35,
  smoothing: { eye: 12, head: 6, body: 3 },
  recenterSpeed: 5,
}

export interface ViewFollower {
  /** 是否允许跟随(如 DSH 工作时关闭 → 视线回中)。 */
  setEnabled(enabled: boolean): void
  /** 每帧推进:喂入鼠标位置与角色头部锚点(窗口 px)。 */
  update(deltaSeconds: number, pointer: { x: number; y: number }, anchor: { x: number; y: number }): void
  /** 当前平滑后的目标(归一化 -1..1)。 */
  look(): ViewLook
}

export function createViewFollower(config: ViewFollowerConfig = DEFAULT_FOLLOWER_CONFIG): ViewFollower {
  let enabled = true
  const current: ViewLook = { headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, bodyX: 0 }
  const target: ViewLook = { headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, bodyX: 0 }

  function computeTarget(pointer: { x: number; y: number }, anchor: { x: number; y: number }): void {
    const dx = pointer.x - anchor.x
    const dy = pointer.y - anchor.y
    const dist = Math.hypot(dx, dy)
    // 死区内(或恰好锚点)目标归零,防抖
    if (dist <= config.deadZoneRadius) {
      clearTarget()
      return
    }
    // 指数距离曲线:近处响应快,远处持续增长到饱和(不截断)
    const t = 1 - Math.exp(-(dist - config.deadZoneRadius) / config.distanceScale)
    // 单位向量方向,保证斜向偏移不超幅
    const nx = (dx / dist) * t
    // Y 取反:屏幕 y 向下,ParamAngleY 正向为抬头 → 鼠标在上方应抬头
    const ny = (-dy / dist) * t
    target.headX = nx * config.headMax
    target.headY = ny * config.headMax
    target.headZ = 0
    target.eyeX = nx * config.eyeMax
    target.eyeY = ny * config.eyeMax
    target.bodyX = nx * config.bodyMax
  }

  function clearTarget(): void {
    target.headX = 0
    target.headY = 0
    target.headZ = 0
    target.eyeX = 0
    target.eyeY = 0
    target.bodyX = 0
  }

  /** 指数趋近:帧率无关的平滑。 */
  function approach(value: number, goal: number, speed: number, dt: number): number {
    return value + (goal - value) * (1 - Math.exp(-speed * dt))
  }

  return {
    setEnabled(next: boolean): void {
      enabled = next
      if (!next) clearTarget()
    },
    update(deltaSeconds: number, pointer: { x: number; y: number }, anchor: { x: number; y: number }): void {
      if (enabled) computeTarget(pointer, anchor)
      // 禁用时目标已清零,用较快的回中速度收敛
      const eye = enabled ? config.smoothing.eye : config.recenterSpeed
      const head = enabled ? config.smoothing.head : config.recenterSpeed
      const body = enabled ? config.smoothing.body : config.recenterSpeed
      current.headX = approach(current.headX, target.headX, head, deltaSeconds)
      current.headY = approach(current.headY, target.headY, head, deltaSeconds)
      current.headZ = approach(current.headZ, target.headZ, head, deltaSeconds)
      current.eyeX = approach(current.eyeX, target.eyeX, eye, deltaSeconds)
      current.eyeY = approach(current.eyeY, target.eyeY, eye, deltaSeconds)
      current.bodyX = approach(current.bodyX, target.bodyX, body, deltaSeconds)
    },
    look(): ViewLook {
      return { ...current }
    },
  }
}
