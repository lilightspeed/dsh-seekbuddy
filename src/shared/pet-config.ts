/**
 * 阶段 5:宠物配置 —— 纯类型 + 默认值(持久化于主进程 userData/config.json)。
 *
 * 本文件同时被 node tsconfig(main/preload)与 web tsconfig(renderer)编译,
 * 只能写纯 JS/TS,不许引用 Node 或 DOM 类型。读写逻辑在主进程 config.ts,
 * renderer 经 preload 白名单(getConfig / setConfig)访问。
 */

/** 外观设置:窗口透明度与缩放。 */
export interface PetAppearanceConfig {
  /** 窗口透明度 0.3–1(1 = 不透明)。 */
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
  /** 身体跟随幅度(0..1)。 */
  bodyAmplitude: number
  /** 死区半径 px(鼠标距锚点小于该值不响应)。 */
  deadZone: number
  /** 距离灵敏度 px(距离曲线尺度;越大需要移得越远才达到同样幅度)。 */
  distance: number
  /** 跟手速度倍数(0.2..3,乘到各通道平滑速度)。 */
  response: number
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
    bodyAmplitude: 0.35,
    deadZone: 12,
    distance: 320,
    response: 1,
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
  petBodyAmplitude?: number
  petDeadZone?: number
  petDistance?: number
  petResponse?: number
}
