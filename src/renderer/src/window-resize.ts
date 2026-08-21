import type { PetApi } from '../../shared/pet-event.ts'

/** 0056 窗口边缘拖拽调整大小的 8 个方向(与主进程 RESIZE_EDGES 一致)。 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/**
 * 0056/0063 窗口边缘拖拽调整大小:
 * 在窗口四边/四角铺 8 条**透明** `no-drag` 手柄(高于 #stage 的 drag 区域,
 * 与摸头点击区同一套机制 —— drag 区域不吞 no-drag 元素的鼠标事件)。
 *
 * 分工(0057 起,0063 修正):
 * - **win32** 边缘最外约 5px 被系统非客户区命中测试吞掉 → **Electron 原生缩放**
 *   (创建即 resizable:true,见 main/index.ts;手柄收不到 pointerdown);
 * - **手柄圈内、5px 之外**的区域(角 24×24 / 边 8px 的其余部分)是普通客户区
 *   事件 → 本文件手柄注册 pointerdown → `pet:resize-start` → 主进程 0056 专用
 *   60Hz 锚定对侧边 setBounds 循环。此前该区域既非缩放也非拖动(no-drag 死区),
 *   "有概率拖不动"的来源(0063)。
 * - **非 win32**(resizable:false)全部边缘都走手柄 pointerdown → 主进程专用循环。
 *
 * 指针捕获(全部平台):按下时 setPointerCapture,窗口被拉伸/指针移出窗口后松开
 * 事件仍路由到本手柄,resize-end 不漏发;窗口失焦(Alt-Tab 等打断捕获)由 blur
 * 兜底收尾。原生边缘上的按下被系统吞掉,不会触发 pointerdown/capture,不影响
 * 原生缩放。
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
      document.body.classList.add('pet-resizing')
      void api.resizeStart(edge)
    })
    const end = (e: PointerEvent): void => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      document.body.classList.remove('pet-resizing')
      void api.resizeEnd()
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    document.body.appendChild(el)
    cleanup.push(() => el.remove())
  }
  return () => {
    for (const dispose of cleanup) dispose()
  }
}
