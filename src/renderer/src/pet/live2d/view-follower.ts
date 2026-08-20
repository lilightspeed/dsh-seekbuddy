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
 *
 * 瞳孔收缩(0029):空闲(跟随启用)时,鼠标以足够快的速度**接近**宠物锚点
 * (径向接近速度 = 距离减小速率,正 = 接近)即驱动 ParamPupilSize 收缩
 * (0 = 正常,1 = 缩到最小)。径向速度排除了纯切向飞掠;接近停止/远离后经
 * release 平滑回落,形成"突然逼近 → 受惊缩瞳 → 缓缓复原"的自然反应。
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
  /** 各通道平滑速度(1/s):越大跟得越快。 */
  smoothing: { eye: number; head: number }
  /** 跟随被禁用时回到中心的速度(1/s)。 */
  recenterSpeed: number
  /** 瞳孔收缩:径向接近速度(px/s)达到该值 → 收缩到 pupilMax。 */
  pupilSensitivity?: number
  /** 瞳孔收缩最大幅度(0..1;1 = 参数满行程,即"缩到最小")。 */
  pupilMax?: number
  /** 瞳孔收缩起效速度(1/s):越大反应越快。 */
  pupilAttack?: number
  /** 瞳孔收缩回落速度(1/s):越小"惊吓"余韵越久。 */
  pupilRelease?: number
}

export const DEFAULT_FOLLOWER_CONFIG: Required<ViewFollowerConfig> = {
  deadZoneRadius: 12,
  distanceScale: 320,
  eyeMax: 1,
  headMax: 0.9,
  smoothing: { eye: 12, head: 6 },
  recenterSpeed: 5,
  pupilSensitivity: 600,
  pupilMax: 1,
  pupilAttack: 14,
  pupilRelease: 1.8,
}

/**
 * 接近速度低通滤波速率(1/s)。主进程 33ms 轮询光标 + renderer 60fps 帧推进,
 * 相邻两次光标样本之间隔着一帧(约 16.7ms),原始径向速度呈 30Hz 的
 * [0, 2×真实速度] 交替 —— 先低通再映射,输出收敛到接近真实接近速度(稳态约 0.9×),
 * 同时抑制光标抖动引起的瞬时尖峰。
 */
const PUPIL_SPEED_FILTER = 12

export interface ViewFollower {
  /** 是否允许跟随(如 DSH 工作时关闭 → 视线回中、瞳孔回落)。 */
  setEnabled(enabled: boolean): void
  /** 每帧推进:喂入鼠标位置与角色头部锚点(窗口 px)。 */
  update(deltaSeconds: number, pointer: { x: number; y: number }, anchor: { x: number; y: number }): void
  /** 当前平滑后的目标(视角通道 -1..1;瞳孔 0..1)。 */
  look(): ViewLook
}

export function createViewFollower(config: ViewFollowerConfig = DEFAULT_FOLLOWER_CONFIG): ViewFollower {
  let enabled = true
  const current: ViewLook = { headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, pupilContract: 0 }
  const target: ViewLook = { headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, pupilContract: 0 }

  /** 瞳孔状态:上一帧到锚点的距离(null = 无历史)、低通后的径向接近速度(px/s)、目标/当前收缩幅度。 */
  let prevDist: number | null = null
  let closingSpeed = 0
  let targetPupil = 0
  let currentPupil = 0

  /**
   * 运行时可调参数在使用时解析(设置面板用 Object.assign 就地覆盖同一 config 对象,
   * 实时生效;未提供字段回退 DEFAULT)。瞳孔/身体字段为可选,见 ViewFollowerConfig。
   */
  function resolve(key: keyof ViewFollowerConfig): number {
    return (config[key] as number | undefined) ?? (DEFAULT_FOLLOWER_CONFIG[key] as number)
  }

  function computeLookTarget(dist: number, dx: number, dy: number): void {
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
  }

  function clearTarget(): void {
    target.headX = 0
    target.headY = 0
    target.headZ = 0
    target.eyeX = 0
    target.eyeY = 0
  }

  /** 径向接近速度 → 收缩目标:低通滤波后按 sensitivity 归一化(0..pupilMax)。 */
  function updatePupilTarget(deltaSeconds: number, dist: number): void {
    // 正 = 接近(距离在减小);首帧无历史距离按 0
    let raw = 0
    if (prevDist !== null && deltaSeconds > 0) {
      raw = (prevDist - dist) / deltaSeconds
    }
    prevDist = dist
    closingSpeed += (raw - closingSpeed) * (1 - Math.exp(-PUPIL_SPEED_FILTER * deltaSeconds))
    targetPupil = Math.min(1, Math.max(0, closingSpeed / resolve('pupilSensitivity'))) * resolve('pupilMax')
  }

  /** 指数趋近:帧率无关的平滑。 */
  function approach(value: number, goal: number, speed: number, dt: number): number {
    return value + (goal - value) * (1 - Math.exp(-speed * dt))
  }

  return {
    setEnabled(next: boolean): void {
      enabled = next
      if (!next) {
        clearTarget()
        // 复位瞳孔速度状态:重启用时不因陈旧距离算出虚假接近速度
        prevDist = null
        closingSpeed = 0
        targetPupil = 0
      }
    },
    update(deltaSeconds: number, pointer: { x: number; y: number }, anchor: { x: number; y: number }): void {
      const dx = pointer.x - anchor.x
      const dy = pointer.y - anchor.y
      const dist = Math.hypot(dx, dy)

      if (!enabled) {
        // 禁用(如 DSH 工作中):瞳孔目标归零,经 release 平滑回落
        clearTarget()
        targetPupil = 0
      } else {
        // 先算接近速度:即使随后落入死区,接近阶段的"惊吓"也要在进入前起效
        updatePupilTarget(deltaSeconds, dist)
        // 死区(或恰好锚点)视角目标归零,防抖;瞳孔目标同时归零 →
        // 快速接近已把收缩"打进"currentPupil,停驻在宠物脸上时按 release 慢慢复原
        if (dist <= config.deadZoneRadius) {
          clearTarget()
          targetPupil = 0
        } else {
          computeLookTarget(dist, dx, dy)
        }
      }

      // 视角通道平滑(禁用时用较快的回中速度收敛)
      const eye = enabled ? config.smoothing.eye : config.recenterSpeed
      const head = enabled ? config.smoothing.head : config.recenterSpeed
      current.headX = approach(current.headX, target.headX, head, deltaSeconds)
      current.headY = approach(current.headY, target.headY, head, deltaSeconds)
      current.headZ = approach(current.headZ, target.headZ, head, deltaSeconds)
      current.eyeX = approach(current.eyeX, target.eyeX, eye, deltaSeconds)
      current.eyeY = approach(current.eyeY, target.eyeY, eye, deltaSeconds)

      // 瞳孔:不对称平滑 —— 起效快(attack),回落慢(release),形成"受惊缩瞳、缓缓复原"
      const pupilSpeed = targetPupil > currentPupil ? resolve('pupilAttack') : resolve('pupilRelease')
      currentPupil = approach(currentPupil, targetPupil, pupilSpeed, deltaSeconds)
    },
    look(): ViewLook {
      return { ...current, pupilContract: currentPupil }
    },
  }
}
