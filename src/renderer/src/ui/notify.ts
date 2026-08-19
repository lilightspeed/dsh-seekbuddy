/**
 * 右上角操作通知队列(0042):液态玻璃小气泡,贴近设置按钮与窗口右缘。
 * - 新通知**从上方滑入队首**(队列顶部,淡入),最旧的通知从队尾**向下滑出消失** ——
 *   视觉上呈现"传送带"队列(新弹窗从上面下来,旧弹窗从下面消失);
 * - 纯展示:pointer-events: none,不拦截窗口拖拽与点击;
 * - 样式与 #bubble 同主题(玻璃渐变 + 模糊 + 品牌蓝辉光),CSS 见 index.html 的
 *   #notify-queue / .notify-toast(进出动画为 CSS keyframes,位移用 FLIP 过渡)。
 */

/** 每个弹窗的停留时长(ms,不含进出动画)。 */
const TOAST_STAY_MS = 2400

export interface NotifyQueue {
  /** 弹出一条通知;自动入队、短暂停留后从队尾滑出移除。 */
  show(text: string): void
}

export function createNotifyQueue(): NotifyQueue {
  const container = document.createElement('div')
  container.id = 'notify-queue'
  document.body.appendChild(container)

  /**
   * FLIP 平滑队列位移:新弹窗从队首挤入时,已有弹窗整体向下滑动一格(传送带推进)。
   * 只对"位移"做过渡 —— 进入/退出的淡入淡出由各自的 CSS 动画负责,互不干扰。
   */
  function shiftExisting(existing: HTMLElement[], prevTops: number[]): void {
    // 强制 reflow,让 prepend 后的新布局生效,再读新位置
    void container.offsetHeight
    existing.forEach((el, i) => {
      const delta = (prevTops[i] ?? 0) - el.getBoundingClientRect().top
      if (Math.abs(delta) < 0.5) return
      el.style.transform = `translateY(${delta}px)`
    })
    // 强制应用逆位后清除 → transition 把每个弹窗从旧位平滑滑到新位
    void container.offsetHeight
    for (const el of existing) el.style.transform = ''
  }

  function show(text: string): void {
    // 记录现有弹窗的旧位置(FLIP 起点)
    const existing = [...container.children] as HTMLElement[]
    const prevTops = existing.map((el) => el.getBoundingClientRect().top)

    // 新弹窗插到队首(最上方,自带"从上方滑入 + 淡入"动画)
    const toast = document.createElement('div')
    toast.className = 'notify-toast entering'
    toast.textContent = text
    container.prepend(toast)

    // 已有弹窗整体下移一格(传送带推进)
    shiftExisting(existing, prevTops)

    // 短暂停留后向下滑出消失(队尾 = 最旧,先到先走)
    setTimeout(() => {
      toast.classList.remove('entering')
      toast.classList.add('leaving')
      toast.addEventListener('animationend', () => toast.remove(), { once: true })
    }, TOAST_STAY_MS)
  }

  return { show }
}
