import type { PetApi } from '../../shared/pet-event.ts'

/** 0056 窗口边缘拖拽调整大小的 8 个方向(与主进程 RESIZE_EDGES 一致)。 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/**
 * 0056 窗口边缘拖拽调整大小:
 * 在窗口四边/四角铺 8 条**透明** `no-drag` 手柄(高于 #stage 的 drag 区域,
 * 与摸头点击区同一套机制 —— drag 区域不吞 no-drag 元素的鼠标事件)。
 *
 * 分工:renderer 只负责「按下 → pet:resize-start、松开/取消 → pet:resize-end」
 * 两个信号;尺寸计算全部在主进程已有的 33ms 光标轮询里做(锚定对侧边 setBounds),
 * 不做逐帧 IPC(规避"逐帧 setPosition 卡顿 + 参数转换崩溃"的教训,AGENTS.md)。
 *
 * 指针捕获:按下时 setPointerCapture,窗口被拉伸/指针移出窗口后松开事件仍路由
 * 到本手柄,resize-end 不漏发;窗口失焦(Alt-Tab 等打断捕获)由 blur 兜底收尾。
 */
export function createWindowResizeHandles(api: PetApi | undefined): () => void {
  if (!api) return () => {}
  const cleanup: (() => void)[] = []
  for (const edge of RESIZE_EDGES) {
    const el = document.createElement('div')
    el.className = `pet-resize-handle ${edge}`
    el.setAttribute('data-edge', edge)
    el.addEventListener('pointerdown', (e) => {
      // 按住期间指针事件(含移出窗口/窗口外松开)全部路由到本元素,松开不漏
      el.setPointerCapture(e.pointerId)
      void api.resizeStart(edge)
    })
    const end = (e: PointerEvent): void => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      void api.resizeEnd()
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    document.body.appendChild(el)
    cleanup.push(() => el.remove())
  }
  // 窗口失焦兜底:指针捕获可能被系统打断(Alt-Tab 等),确保 resize 状态不悬挂
  const onBlur = (): void => {
    void api.resizeEnd()
  }
  window.addEventListener('blur', onBlur)
  cleanup.push(() => window.removeEventListener('blur', onBlur))
  return () => {
    for (const dispose of cleanup) dispose()
  }
}
