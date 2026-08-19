import type { AnimationSpec } from './animation-director.ts'

/**
 * 动画注册表 —— 全部动画的单点登记处(doc/09 §3.2)。
 * 新增动画只改这里(声明 channel/priority/mode 等仲裁参数),仲裁与播放代码零改动。
 * runtime 需要的 file/loop 映射由本表派生注入(见 MOTION_FILES)。
 */
/** 动画逻辑 id(新增动画在此扩展 union;索引访问带 noUncheckedIndexedAccess 下不返回 undefined)。 */
type AnimationId = 'pat-head' | 'sad' | 'working' | 'think-thinking' | 'think-dizzy' | 'think-exclaim'

/** 动画注册表 —— 全部动画的单点登记处(doc/09 §3.2),详见各条目注释。 */
export const ANIMATIONS: Record<AnimationId, AnimationSpec> = {
  /**
   * 摸头反馈(0037 系列):点击头部 HitAreaHead 触发。
   * - mode: hold —— 按住时动画冻结在闭眼保持帧(holdAt=0.45s),松开继续播完自然复位
   * - 闭眼过程按素材原速播放(0037w2):按下后动画从 0 以素材速度走完
   *   "开始→闭眼"(≈0.33s),到 holdAt 冻结——闭眼时长与素材关键帧一致
   * - holdUntil=1.2(0037x,素材 EyeLOpen 1.2s 起睁眼):动画处于 [0.45,1.2) 闭眼
   *   保持段时按下,直接冻结当前帧不重闭
   * - holdRewindTo=0.45 + holdRewindRate=1 + eyeOpenDoneAt=1.5 +
   *   holdRewindDurationMs=300(0037z/0037z2/0037z3/0037z4):已过 1.2s(眼睛已睁开)
   *   按下,动画**反向播放**倒回 0.45s 保持帧再冻结——表情连续变化(眼睛平滑闭上),
   *   替代瞬间 seek 跳变;倒带分段变速:消退段(>1.5s)快速倒带(耗时≈0.3s),倒带
   *   进入闭眼段(≤1.5s)自动降速 1x——闭眼过程始终素材原速,不受快速倒带影响
   * - durationMs: 4000 兜底(素材 3.83s 自然结束,此值仅防异常)
   * - priority 默认 0:可被 sad(1) 打断
   */
  'pat-head': {
    id: 'pat-head',
    channel: 'expression',
    file: 'Expression_pat_head.motion3.json',
    mode: 'hold',
    holdAt: 0.45,
    holdUntil: 1.2,
    holdRewindTo: 0.45,
    holdRewindRate: 1,
    eyeOpenDoneAt: 1.5,
    holdRewindDurationMs: 300,
    durationMs: 4000,
    autoBlink: false,
  },
  /**
   * sad 表情(0037r):点击身体 HitAreaBody 触发。
   * - priority 1 > 摸头 0:播放中点击身体自动打断摸头(doc/09 §3.3),不再手写 if/else
   * - durationMs: 3500 兜底(素材 2.03s 自然结束)
   */
  sad: {
    id: 'sad',
    channel: 'expression',
    file: 'Expression_sad.motion3.json',
    priority: 1,
    durationMs: 3500,
    autoBlink: false,
  },
  /**
   * 执行任务的动作(0038;0041 更名,素材名 Motion_think 沿袭旧命名):DSH 工作期间
   * **整个 turn**(turn/start → turn/end)常驻的姿态 —— 低头 + 右手抬起,表示"正在
   * 执行任务",而非"思考"(真正的思考是表情 think-thinking 的气泡贴纸)。
   * - channel: action —— 身体/姿态类动作,与表情(expression)互不干扰;
   *   素材同时驱动眉毛/眼睛/嘴部曲线,gate 只拦 expression 通道的请求,不拦运行时曲线写入
   * - 非循环(素材 Meta.Loop=true 但按 0037 教训统一强制非循环):播一遍后 **保持末尾姿态**
   *   (holdEnd,低头 + 抬手),由 runtime 捕获曲线末帧参数持续恢复,直到离开 thinking
   * - 不设 durationMs:hold-end 是常驻姿态,不能由导演兜底超时停止(离开 thinking 时 animator
   *   显式 stopChannel('action') 复位)
   * - autoBlink false:执行任务期间眼睛/眉毛由 motion 接管
   * - 0041:推理段开始不再停掉重建(仅被恍然大悟占用时才重建),保证整个运行期间常驻不抖动
   */
  working: {
    id: 'working',
    channel: 'action',
    file: 'Motion_think.motion3.json',
    priority: 1,
    holdEnd: true,
    autoBlink: false,
  },
  /**
   * 思考表情(0041):推理段进行中、**段时长 ∈ (0, 困惑阈值 B]** 期间显示 —— 头顶
   * 气泡"…"贴纸(素材 Expression_think_thinking,只驱动 ParamBubbleEllipsis 系列,
   * 纯贴纸/表情,不含低头抬手等姿态;真正的"思考"表现)。
   * - channel: expression —— 与 action 通道的执行任务姿态(working)并存互不干扰;
   *   段时长 > B 后由 tick 请求 think-dizzy(priority 1)自动顶替本贴纸
   * - loop: true —— 推理期间持续显示(气泡点点循环),段结束(onThinkingSegmentEnd)
   *   停 expression 通道并平滑复位(气泡参数已入 EXPRESSION_PARAM_IDS,不留残影)
   * - priority 0:低于 think-dizzy(1),困惑表情随时可顶替;同段内重复请求幂等忽略
   * - autoBlink false:不干扰执行任务姿态的眉眼接管
   */
  'think-thinking': {
    id: 'think-thinking',
    channel: 'expression',
    file: 'Expression_think_thinking.motion3.json',
    loop: true,
    priority: 0,
    autoBlink: false,
  },
  /**
   * 困惑表情(0039):**推理段**时长 > 阈值 B 时,该段期间**循环播放**,段结束停止。
   * - channel: expression —— 与 action 通道的执行任务姿态(working)并存,顶替
   *   思考表情(think-thinking,priority 0 < 本表 1),素材驱动的 ParamDizzy/
   *   IrisStyle/Blush/MouthOpenY/FormClose 与执行任务姿态参数不相交
   * - loop: true —— 长推理段持续晕眩感;ParamDizzy 曲线 0.1→0.9 循环点跳变由 V2
   *   correctEndPoint + loop fade-in 平滑(坑 4)
   * - 段结束(onThinkingSegmentEnd)时由 animator 停 expression 并平滑复位;
   *   一次 turn 可含多段,每段独立触发
   */
  'think-dizzy': {
    id: 'think-dizzy',
    channel: 'expression',
    file: 'Expression_think_dizzy1.motion3.json',
    loop: true,
    priority: 1,
    autoBlink: false,
  },
  /**
   * 恍然大悟表情(0039):**推理段**结束且段时长 ≥ 阈值 A 时**播放一次**;
   * 一次 turn 可含多段,每段结束各自判定(思考 → 工具调用 → 再思考…)。
   * - channel: action —— 段末思考姿态已 stop(复位),恍然大悟独占身体通道;
   *   驱动 ParamAngleY(摇头)/ParamSymbolExclamation(感叹号)/眼睛/嘴,与表情通道无关
   * - 非循环,素材 2.9s 自然结束自动复位;播完后若 turn 仍在 thinking 恢复思考姿态
   *   (onEnd 回调),段间余尾由下一段/turn 结束截断复位
   */
  'think-exclaim': {
    id: 'think-exclaim',
    channel: 'action',
    file: 'Expression_think_exclaim.motion3.json',
    priority: 1,
    durationMs: 3500,
    autoBlink: false,
  },
}

/** runtime 需要的 file/loop/holdEnd 映射(由 ANIMATIONS 派生,单点配置,0037s)。 */
export const MOTION_FILES: Record<string, { file: string; loop: boolean; holdEnd?: boolean }> = Object.fromEntries(
  Object.entries(ANIMATIONS).map(([id, spec]) => {
    const entry: { file: string; loop: boolean; holdEnd?: boolean } = { file: spec.file, loop: spec.loop ?? false }
    // exactOptionalPropertyTypes:可选属性不能赋显式 undefined,条件写入
    if (spec.holdEnd !== undefined) entry.holdEnd = spec.holdEnd
    return [id, entry]
  }),
)
