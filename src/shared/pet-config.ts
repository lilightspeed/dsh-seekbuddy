/**
 * 阶段 5:宠物配置 —— 纯类型 + 默认值(持久化于主进程 userData/config.json)。
 *
 * 本文件同时被 node tsconfig(main/preload)与 web tsconfig(renderer)编译,
 * 只能写纯 JS/TS,不许引用 Node 或 DOM 类型。读写逻辑在主进程 config.ts,
 * renderer 经 preload 白名单(getConfig / setConfig)访问。
 */

/** 外观设置:背景透明度与窗口尺寸。 */
export interface PetAppearanceConfig {
  /** 背景透明度 0–1(0 = 背景画布完全透明,1 = 不透明)。 */
  opacity: number
  /**
   * 窗口尺寸 px(0056 起):由鼠标拖拽窗口边缘/四角调整,松手即持久化;
   * 不再有"窗口缩放"倍率设置。默认 420×560。
   */
  windowWidth: number
  windowHeight: number
  /**
   * 极简模式(0062):仅显示宠物 —— 仅隐藏全部非宠物组件(背景/气泡/输入条/按钮/
   * 面板/通知/审批/提问卡/缩放手柄),**不改动窗口大小**(宠物超出窗口部分被截断);
   * 所有动作逻辑保留。
   */
  petOnly: boolean
}

/** 窗口基准尺寸(px,0056):默认窗口大小;拖拽调整后持久化到 appearance.windowWidth/Height。 */
export const WINDOW_SIZE = { width: 420, height: 560 } as const
/** 窗口尺寸夹取范围(px,0056):主进程拖拽 setBounds 与配置读写共用。
 *  0062c:最低高度从 280 降到 120 —— 极简模式不改窗口大小,用户可能把窗口压到很矮
 *  (宠物截断即可),故放宽下限;宽度保持 200 防止卡片被压到不可用。 */
export const WINDOW_SIZE_MIN = { width: 200, height: 120 } as const
export const WINDOW_SIZE_MAX = { width: 1600, height: 1600 } as const

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
  /**
   * 思考表情阈值 A(秒,0039):一次**推理段**(DSH 事件流 reasoning 块,一次任务可含多段)
   * 时长 ≥ A 时,段结束播放"恍然大悟"(Expression_think_exclaim)一次;段太短则正常继续。
   */
  thinkExclaimAfterSec: number
  /**
   * 思考表情阈值 B(秒,0039,应 > A):推理段时长 > B 时,段期间循环播放
   * "困惑"(Expression_think_dizzy1),段结束再播放"恍然大悟"。
   * 运行时对 A/B 做 min/max 归一,顺序填反也不会破坏逻辑。
   */
  thinkDizzyAfterSec: number
  /**
   * 入睡阈值(秒,0058):目标会话空闲(宠物处于 idle 状态)累计达到该时长后
   * 触发睡眠 —— 只算当前选中"目标"的待机时长,其余并行会话的活动不影响计时
   * (状态机只跟踪目标会话,0046)。10..86400s,0/负值由 clamp 兜底到 10。
   */
  sleepAfterSec: number
  /**
   * 睡眠唤醒的拖动加速度阈值(px/s²,0059):睡眠中拖动窗口按**加速度**(速度变化率)
   * 判定是否"惊动"宠物 —— 轻轻移动(匀速/慢速)时加速度低于阈值,宠物不醒、
   * 拖动物理反馈照常生效;"突然拖动/快速拖动"加速度达到阈值才唤醒。500..20000。
   */
  wakeAccel: number
}

export interface PetConfig {
  /** DSH 运行实例基址(loopback 受信;默认 127.0.0.1:3080)。 */
  dsh: { baseUrl: string }
  appearance: PetAppearanceConfig
  /** 宠物(Live2D)外观与跟随手感。 */
  pet: PetPetSettings
  /** 开机自启(Windows LoginItem)。 */
  launchAtLogin: boolean
  /** 目标会话记忆(发消息的落点;重启后恢复,可被 selectSession 清空)。 */
  targetSessionId: string | null
}

export const DEFAULT_PET_CONFIG: PetConfig = {
  dsh: { baseUrl: 'http://127.0.0.1:3080' },
  appearance: { opacity: 1, windowWidth: WINDOW_SIZE.width, windowHeight: WINDOW_SIZE.height, petOnly: false },
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
    // 思考表情阈值(0039):按"推理段"计时 —— ≥5s 的段结束恍然大悟;>15s 的段期间循环困惑
    thinkExclaimAfterSec: 5,
    thinkDizzyAfterSec: 15,
    // 入睡阈值(0058):目标空闲 120s(2 分钟)后自动入睡
    sleepAfterSec: 120,
    // 唤醒加速度阈值(0059):速度变化率 ≥2500 px/s² 视为"惊动",唤醒睡眠
    wakeAccel: 2500,
  },
  launchAtLogin: false,
  targetSessionId: null,
}

/**
 * renderer → 主进程的**扁平**配置更新(0004 纪律:IPC 参数必须是可序列化标量,
 * 不用嵌套对象;preload 边界已做类型收敛,主进程再校验一遍)。
 * 宠物设置以 pet* 前缀平铺(见 PetPetSettings 各字段)。
 */
export interface PetConfigUpdate {
  /** 0062 极简模式开关(仅显示宠物;托盘/主页面按钮可切换,持久化,重启保持)。 */
  petOnly?: boolean
  dshBaseUrl?: string
  opacity?: number
  /** 0056:窗口尺寸 px(仅主进程 resize-end 写入;renderer 无设置入口)。 */
  windowWidth?: number
  windowHeight?: number
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
  /** 思考表情阈值 A(秒,0039):思考结束播放"恍然大悟"的最短时长。 */
  petThinkExclaimAfterSec?: number
  /** 思考表情阈值 B(秒,0039):思考期间循环"困惑"的最短时长。 */
  petThinkDizzyAfterSec?: number
  /** 入睡阈值(秒,0058):目标会话空闲达到该时长后触发睡眠。 */
  petSleepAfterSec?: number
  /** 睡眠唤醒的拖动加速度阈值(px/s²,0059):轻轻移动不醒,加速度达标才唤醒。 */
  petWakeAccel?: number
}
