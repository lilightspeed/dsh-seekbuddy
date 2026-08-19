import type { AnimationSpec } from './animation-director.ts'

/**
 * 动画注册表 —— 全部动画的单点登记处(doc/09 §3.2)。
 * 新增动画只改这里(声明 channel/priority/mode 等仲裁参数),仲裁与播放代码零改动。
 * runtime 需要的 file/loop 映射由本表派生注入(见 MOTION_FILES)。
 */
/** 动画逻辑 id(新增动画在此扩展 union;索引访问带 noUncheckedIndexedAccess 下不返回 undefined)。 */
type AnimationId = 'pat-head' | 'sad'

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
   *   holdRewindDurationMs=500(0037z/0037z2/0037z3):已过 1.2s(眼睛已睁开)按下,
   *   动画**反向播放**从当前帧倒回 0.45s 保持帧再冻结——表情连续变化(眼睛平滑
   *   闭上),替代瞬间 seek 跳变;倒带速度:睁眼过程(≤1.5s)固定 1x 细腻过渡,
   *   红晕消退段(>1.5s)动态加速,每次倒带耗时≈0.5s
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
    holdRewindDurationMs: 500,
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
}

/** runtime 需要的 file/loop 映射(由 ANIMATIONS 派生,单点配置,0037s)。 */
export const MOTION_FILES: Record<string, { file: string; loop: boolean }> = Object.fromEntries(
  Object.entries(ANIMATIONS).map(([id, spec]) => [id, { file: spec.file, loop: spec.loop ?? false }]),
)
