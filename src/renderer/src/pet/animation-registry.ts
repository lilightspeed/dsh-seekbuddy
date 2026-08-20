import type { AnimationSpec } from './animation-director.ts'

/**
 * 动画注册表 —— 全部动画的单点登记处(doc/09 §3.2)。
 * 新增动画只改这里(声明 channel/priority/mode 等仲裁参数),仲裁与播放代码零改动。
 * runtime 需要的 file/loop 映射由本表派生注入(见 MOTION_FILES)。
 */
/** 动画逻辑 id(新增动画在此扩展 union;索引访问带 noUncheckedIndexedAccess 下不返回 undefined)。 */
type AnimationId =
  | 'pat-head'
  | 'sad'
  | 'angry'
  | 'working'
  | 'think-thinking'
  | 'think-dizzy'
  | 'think-exclaim'
  | 'sleep-motion'
  | 'sleep-expression'

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
   * 愤怒表情(打断任务):任务被打断(用户停止/中断,DSH turn/end reason =
   * aborted/interrupted)后播放一次 —— "为什么要打断我"。
   * - channel: expression —— 脸部表情,与 action 通道的执行任务姿态互不干扰
   *   (进入愤怒前 animator 已随离开 thinking 停掉 action,不会叠加)
   * - 非循环,素材 3s 自然结束自动平滑复位;ParamAngry 已入 EXPRESSION_PARAM_IDS
   * - priority 1:可打断摸头(0);与 sad(1) 同优先级不互抢,播完为止
   * - autoBlink false:愤怒期间眉毛/眼睛由 motion 接管
   */
  angry: {
    id: 'angry',
    channel: 'expression',
    file: 'Expression_angry.motion3.json',
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
   * - loop: true —— 推理期间持续显示(点点走路循环),段结束(onThinkingSegmentEnd)
   *   停 expression 通道并平滑复位(气泡参数已入 EXPRESSION_PARAM_IDS,不留残影)
   * - hardLoopRestart(0050):素材是"点点走路"序列动画(.__→.._→...→_..→__.→___,
   *   曲线首尾 0→1.0 恰为相邻状态),V2 循环的 correctEndPoint 会在循环点把曲线值
   *   从终点扫回起点、**途经中间态(0.5 = 全亮 ...)**,每圈闪出中间帧;硬重启直接
   *   `___`→`.__` 跳变,中间态永不出现
   * - priority 0:低于 think-dizzy(1),困惑表情随时可顶替;同段内重复请求幂等忽略
   * - autoBlink false:不干扰执行任务姿态的眉眼接管
   */
  'think-thinking': {
    id: 'think-thinking',
    channel: 'expression',
    file: 'Expression_think_thinking.motion3.json',
    loop: true,
    priority: 0,
    hardLoopRestart: true,
    autoBlink: false,
  },
  /**
   * 困惑表情(0039):**推理段**时长 > 阈值 B 时,该段期间**循环播放**,段结束停止。
   * - channel: expression —— 与 action 通道的执行任务姿态(working)并存,顶替
   *   思考表情(think-thinking,priority 0 < 本表 1),素材驱动的 ParamDizzy/
   *   IrisStyle/Blush/MouthOpenY/FormClose 与执行任务姿态参数不相交
   * - loop: true —— 长推理段持续晕眩感。ParamDizzy 曲线 0.1→0.9 循环点跳变本来靠 loop
   *   fade-in 平滑(坑 4),但淡入已全局禁用(0047,由用户在 Live2D 里做渐变)——若循环点
   *   跳变太突兀,应让素材作者在编辑器里对齐曲线首尾/画好淡入淡出,不要依赖运行时补。
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
   * 恍然大悟表情(0039/0044/0046):**推理段**结束且段时长 ≥ 阈值 A 时**播放一次**;
   * 一次 turn 可含多段,每段结束各自判定(思考 → 工具调用 → 再思考…)。
   * - channel: expression(0046,原 action)——它是**表情**,不该抢占/替换 action 通道的
   *   执行任务姿态(working)。播放时 action 通道的 working(低头+抬手)继续常驻,恍然大悟
   *   叠加其上:面部参数(眼睛/嘴/感叹号)覆盖,ParamAngleY 点头增量与 working 的低头
   *   **叠加**(runtime 按通道对角度参数做加算,见 cubism-runtime update)。
   * - 非循环,素材 2.9s 自然结束自动复位;播放结束回到 working 常驻姿态(不再需要
   *   animator 重新 request working —— working 从未被 stop)
   * - files(0044):两套相似素材(Expression_think_exclaim / Exclaim1),每次播放随机选一
   */
  'think-exclaim': {
    id: 'think-exclaim',
    channel: 'expression',
    file: 'Expression_think_exclaim.motion3.json',
    files: ['Expression_think_exclaim.motion3.json', 'Expression_think_exclaim1.motion3.json'],
    priority: 1,
    durationMs: 3500,
    autoBlink: false,
  },
  /**
   * 睡眠动作(0058):目标会话空闲达到阈值后播一遍"入睡"——低头 + 闭眼 + 闭嘴
   * (素材 4.867s,曲线首尾不一致:ParamAngleY 0→-26、ParamEyeLOpen/ROpen 1→0,
   * 按 0037 教训强制非循环)。
   * - channel: action —— 身体/姿态类,与表情通道(睡眠 Zzz)并存互不干扰
   * - holdEnd: true —— 播完后**停留在尾帧**(低头闭眼入睡姿态),由 runtime 捕获
   *   曲线末帧参数持续恢复;直到睡眠被唤醒(exitSleep → stopChannel('action'))
   *   才平滑复位回待机(ParamAngleY/EyeLOpen/ROpen/MouthFormClose 均已在
   *   EXPRESSION_PARAM_IDS 复位清单,见 cubism-runtime.ts)
   * - 不设 durationMs:hold-end 常驻姿态不能由导演兜底超时停止(唤醒时显式 stop)
   * - autoBlink false:闭眼由 motion 尾帧接管,睡眠期间不允许眨眼 updater 干扰
   */
  'sleep-motion': {
    id: 'sleep-motion',
    channel: 'action',
    file: 'Motion_sleep.motion3.json',
    priority: 1,
    holdEnd: true,
    autoBlink: false,
  },
  /**
   * 睡眠表情(0058):入睡动作播完停留尾帧后,**循环播放**头顶 Zzz 贴纸,直到睡眠
   * 被唤醒(停止条件满足:切到运行中的会话 / 拖动宠物窗口)。
   * - channel: expression —— 脸部/贴纸表情,与 action 通道的入睡姿态并存;
   *   驱动 ParamSymbolZzz(0=隐藏/1=完整,已在 EXPRESSION_PARAM_IDS 复位清单)
   * - loop: true —— 睡眠期间持续"Zzz 一明一暗"呼吸闪烁
   * - hardLoopRestart(0058 修正,0050 坑):曲线首尾不一致(3.233s=1 → 0s=0),
   *   V2 的 correctEndPoint 会在循环点把终点值线性扫回起点、**途经中间态 0.5**
   *   (半透明 Zzz),每圈循环点闪出中间帧 —— 用户实测可见。硬重启直接 1→0 跳变,
   *   与素材曲线内部已有的 1→0 渐隐段(1.078→2.156s)衔接,中间态永不出现
   * - 不设 durationMs:循环动画无自然结束,睡眠被唤醒时 stopChannel('expression')
   *   显式停止并平滑复位(Zzz 贴纸隐藏)
   * - autoBlink false:睡眠期间眼睛由入睡动作尾帧接管
   */
  'sleep-expression': {
    id: 'sleep-expression',
    channel: 'expression',
    file: 'Expression_sleep.motion3.json',
    loop: true,
    priority: 1,
    hardLoopRestart: true,
    autoBlink: false,
  },
}

/** runtime 需要的 file/loop/holdEnd/files/hardLoopRestart 映射(由 ANIMATIONS 派生,单点配置,0037s)。 */
export const MOTION_FILES: Record<
  string,
  { file: string; loop: boolean; holdEnd?: boolean; files?: string[]; hardLoopRestart?: boolean }
> = Object.fromEntries(
  Object.entries(ANIMATIONS).map(([id, spec]) => {
    const entry: { file: string; loop: boolean; holdEnd?: boolean; files?: string[]; hardLoopRestart?: boolean } = {
      file: spec.file,
      loop: spec.loop ?? false,
    }
    // exactOptionalPropertyTypes:可选属性不能赋显式 undefined,条件写入
    if (spec.holdEnd !== undefined) entry.holdEnd = spec.holdEnd
    if (spec.files !== undefined) entry.files = [...spec.files]
    if (spec.hardLoopRestart !== undefined) entry.hardLoopRestart = spec.hardLoopRestart
    return [id, entry]
  }),
)
