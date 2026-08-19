/**
 * 阶段 5:宠物配置 —— 纯类型 + 默认值(持久化于主进程 userData/config.json)。
 *
 * 本文件同时被 node tsconfig(main/preload)与 web tsconfig(renderer)编译,
 * 只能写纯 JS/TS,不许引用 Node 或 DOM 类型。读写逻辑在主进程 config.ts,
 * renderer 经 preload 白名单(getConfig / setConfig)访问。
 */

/** 外观设置:背景透明度与窗口缩放。 */
export interface PetAppearanceConfig {
  /** 背景透明度 0–1(0 = 背景画布完全透明,1 = 不透明)。 */
  opacity: number
  /** 窗口缩放倍率 0.6–1.6(1 = 默认 420×560)。 */
  scale: number
}

/** 宠物(Live2D)外观与视角跟随手感 —— 设置面板可调,实时生效并持久化(0017)。 */
export interface PetPetSettings {
  /** 模型中心水平位置(窗口比例 0..1)。 */
  positionX: number
  /** 模型中心垂直位置(窗口比例 0..1)。 */
  positionY: number
  /** 显示缩放倍率(0.2..3,1 = 默认适配)。 */
  scale: number
  /** 头部跟随幅度(归一化 0..1,1 = 用到参数满行程)。 */
  headAmplitude: number
  /** 眼珠跟随幅度(0..1)。 */
  eyeAmplitude: number
  /** 死区半径 px(鼠标距锚点小于该值不响应)。 */
  deadZone: number
  /** 距离灵敏度 px(距离曲线尺度;越大需要移得越远才达到同样幅度)。 */
  distance: number
  /** 跟手速度倍数(0.2..3,乘到各通道平滑速度)。 */
  response: number
  /** 瞳孔灵敏度(px/s):鼠标接近速度达到该值 → 瞳孔收缩到 pupilMax(0029/0030)。 */
  pupilSensitivity: number
  /** 瞳孔收缩最大幅度(0..1;1 = 参数满行程,即"缩到最小")。 */
  pupilMax: number
  /**
   * 拖动反馈强度(0..1,0033/0034):线性映射到增益 1..DRAG_MAX_MULTIPLIER ——
   * 0 = 基础灵敏度(0032 原效果,起点),1 = 增益上限(接近 Live2D 编辑器满行程反馈)。
   * 默认 1:升级后默认即为增强效果。
   */
  dragStrength: number
  /** 显示点击判定网格(摸头触发范围可视化,0037;默认关)。 */
  showHitMesh: boolean
  /**
   * 摸头力度(0037m/0037n/0037q,0..8,1 = 默认):按住摸头期间头部视线跟随的
   * X/Y 角度灵敏度增益 —— 0 = 不放大,1 = 幅度 ×1.5 + 跟手 ×1.4(默认),
   * 8 = 幅度 ×5.0(按住方框内任意位置头部转动≈满行程,0037q)。
   * 只影响按住期间,松开立即恢复。
   */
  patStrength: number
}

export interface PetConfig {
  /** DSH 运行实例基址(loopback 受信;默认 127.0.0.1:3080)。 */
  dsh: { baseUrl: string }
  appearance: PetAppearanceConfig
  /** 宠物(Live2D)外观与跟随手感。 */
  pet: PetPetSettings
  /** 语音(TTS)总开关 —— 阶段 6 语音接入后生效,现在只持久化。 */
  voice: { enabled: boolean }
  /** 开机自启(Windows LoginItem)。 */
  launchAtLogin: boolean
  /** 目标会话记忆(发消息的落点;重启后恢复,可被 selectSession 清空)。 */
  targetSessionId: string | null
}

export const DEFAULT_PET_CONFIG: PetConfig = {
  dsh: { baseUrl: 'http://127.0.0.1:3080' },
  appearance: { opacity: 1, scale: 1 },
  pet: {
    positionX: 0.5,
    positionY: 0.44,
    scale: 1,
    headAmplitude: 0.9,
    eyeAmplitude: 1,
    deadZone: 12,
    distance: 320,
    response: 1,
    pupilSensitivity: 600,
    pupilMax: 1,
    dragStrength: 1,
    showHitMesh: false,
    patStrength: 1,
  },
  voice: { enabled: true },
  launchAtLogin: false,
  targetSessionId: null,
}

/**
 * renderer → 主进程的**扁平**配置更新(0004 纪律:IPC 参数必须是可序列化标量,
 * 不用嵌套对象;preload 边界已做类型收敛,主进程再校验一遍)。
 * 宠物设置以 pet* 前缀平铺(见 PetPetSettings 各字段)。
 */
export interface PetConfigUpdate {
  dshBaseUrl?: string
  opacity?: number
  scale?: number
  voiceEnabled?: boolean
  launchAtLogin?: boolean
  petPositionX?: number
  petPositionY?: number
  petScale?: number
  petHeadAmplitude?: number
  petEyeAmplitude?: number
  petDeadZone?: number
  petDistance?: number
  petResponse?: number
  petPupilSensitivity?: number
  petPupilMax?: number
  /** 拖动反馈强度(0..1,0033)。 */
  petDragStrength?: number
  /** 显示点击判定网格(0037)。 */
  petShowHitMesh?: boolean
  /** 摸头力度(0037n/0037q,0..8)。 */
  petPatStrength?: number
}
