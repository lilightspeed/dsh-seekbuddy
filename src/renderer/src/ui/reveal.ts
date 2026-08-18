/**
 * 显示/隐藏过渡动画(WAAPI,无需依赖):淡入 + 轻微上移 + 缩放。
 *
 * 显示:移除 .hidden 后立即播放进入动画;隐藏:播放退出动画,结束后才挂 .hidden。
 * 快速连续点击时先取消未完成动画再播新的,状态不会叠加错乱。
 * opacity/transform 都是合成器属性,GPU 加速,展开过程不掉帧。
 */

const SHOW_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: 'translateY(-8px) scale(0.98)' },
  { opacity: 1, transform: 'translateY(0) scale(1)' },
]

const HIDE_KEYFRAMES: Keyframe[] = [
  { opacity: 1, transform: 'translateY(0) scale(1)' },
  { opacity: 0, transform: 'translateY(-8px) scale(0.98)' },
]

/** 显示:元素立即可见并播放滑入动画。 */
export function reveal(el: HTMLElement, duration = 180): void {
  if (!el.classList.contains('hidden')) return
  el.getAnimations().forEach((a) => a.cancel())
  el.classList.remove('hidden')
  el.animate(SHOW_KEYFRAMES, { duration, easing: 'cubic-bezier(0.22, 0.9, 0.32, 1)' })
}

/** 隐藏:播放滑出动画,结束后挂 .hidden(动画被取消也保证最终隐藏)。 */
export function conceal(el: HTMLElement, duration = 140): void {
  if (el.classList.contains('hidden')) return
  el.getAnimations().forEach((a) => a.cancel())
  const anim = el.animate(HIDE_KEYFRAMES, { duration, easing: 'ease-in' })
  anim.onfinish = () => el.classList.add('hidden')
  anim.oncancel = () => el.classList.add('hidden')
}
