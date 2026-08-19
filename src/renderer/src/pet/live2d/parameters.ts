/**
 * ds-pet 模型参数 ID 契约。
 *
 * 与 assets/pet/live2d/ds-pet.cdi3.json 一一对应;模型改名 / 重导后必须同步本文件
 * (对照表见 assets/pet/live2d/README.md §2)。SDK 运行时按这些 ID 驱动参数。
 */

/** 视角跟随:头部角度(度)。 */
export const PARAM_HEAD = {
  x: 'ParamAngleX',
  y: 'ParamAngleY',
  z: 'ParamAngleZ',
} as const

/** 视角跟随:眼珠转动(归一化 -1..1)。 */
export const PARAM_EYE = {
  x: 'ParamEyeBallX',
  y: 'ParamEyeBallY',
} as const

/** 视角跟随:身体旋转(可选联动,度)。 */
export const PARAM_BODY = {
  x: 'ParamBodyAngleX',
  y: 'ParamBodyAngleY',
  z: 'ParamBodyAngleZ',
} as const

/**
 * 物理驱动:后发。由 physics3.json 自动写入;0036 起未拖动时由角度物理输出重放恢复
 * (拖动 Setting5/6 的绝对赋值会把它清零,见 cubism-runtime.ts restoreHairFromAnglePhysics)。
 */
export const PARAM_BACK_HAIR = {
  up: 'ParamBackHairUp',
  down: 'ParamBackHairDown',
  swing: 'ParamBackHairSwing',
} as const

/** 物理驱动:前发(由 physics3.json 自动写入;0036 起未拖动时同样由角度物理重放恢复)。 */
export const PARAM_HAIR_SWAY = {
  x: 'ParamHairSwayX',
  y: 'ParamHairSwayY',
} as const

/**
 * 拖动物理反馈(0032):PhysicsSetting5/6 的输入 —— 上下/左右拖动宠物。
 * 运行时按窗口拖动位移写入这两个参数,SDK 物理演算(Particle 延迟/惯性)自动输出
 * 尾巴、前发、后发等的摆动;停止拖动后参数回中,摆动经阻尼自然衰减。
 */
export const PARAM_DRAG = {
  x: 'ParamDragX',
  y: 'ParamDragY',
} as const

/** 手动 / 程序驱动参数。 */
export const PARAM_MANUAL = {
  tailSwing: 'ParamTailSwing',
  breath: 'ParamBreath',
  pupilSize: 'ParamPupilSize',
  hairFront: 'ParamHairFront',
  hairSide: 'ParamHairSide',
  cheek: 'ParamCheek',
  browLAngle: 'ParamBrowLAngle',
  browRAngle: 'ParamBrowRAngle',
  browLY: 'ParamBrowLY',
  browRY: 'ParamBrowRY',
} as const

/** 表情 / 说话参数(0037:motion 曲线用,含模型新增的 ParamEyeForm/ParamTear)。 */
export const PARAM_EXPRESSION = {
  eyeLOpen: 'ParamEyeLOpen',
  eyeROpen: 'ParamEyeROpen',
  eyeLSmile: 'ParamEyeLSmile',
  eyeRSmile: 'ParamEyeRSmile',
  eyeForm: 'ParamEyeForm',
  tear: 'ParamTear',
} as const

/**
 * 视角跟随每帧输出:全部为归一化 -1..1(与参数实际 min/max 解耦,
 * 由 Live2dRuntime 适配层映射到模型参数范围并 clamp)。
 */
export interface ViewLook {
  /** 头部偏转 X(左右)。 */
  headX: number
  /** 头部偏转 Y(上下)。 */
  headY: number
  /** 头部倾斜 Z。 */
  headZ: number
  /** 眼珠 X(左右)。 */
  eyeX: number
  /** 眼珠 Y(上下)。 */
  eyeY: number
  /** 身体旋转 X(左右,可选联动)。 */
  bodyX: number
  /**
   * 瞳孔收缩(0..1;0 = 正常,1 = 缩到最小)—— 本结构里唯一 0..1 通道,其余均为 -1..1。
   * 由 follower 的"鼠标快速接近"检测驱动(0029):空闲(跟随启用)时鼠标快速靠近
   * 宠物即收缩,接近停止后经 release 平滑回落。
   */
  pupilContract: number
}
