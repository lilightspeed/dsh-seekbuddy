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
   * - durationMs: 4000 兜底(素材 3.83s 自然结束,此值仅防异常)
   * - priority 默认 0:可被 sad(1) 打断
   */
  'pat-head': {
    id: 'pat-head',
    channel: 'expression',
    file: 'Expression_pat_head.motion3.json',
    mode: 'hold',
    holdAt: 0.45,
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
