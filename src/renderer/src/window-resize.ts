import type { PetApi } from '../../shared/pet-event.ts'

/** 0056 窗口边缘拖拽调整大小的 8 个方向(与主进程 RESIZE_EDGES 一致)。 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/**
 * 0056/0057 窗口边缘拖拽调整大小:
 * 在窗口四边/四角铺 8 条**透明** `no-drag` 手柄(高于 #stage 的 drag 区域,
 * 与摸头点击区同一套机制 —— drag 区域不吞 no-drag 元素的鼠标事件)。
 *
 * 分工(0057 起):**win32 走 Electron 原生边缘缩放**(创建即 resizable:true,
 * 见 main/index.ts)—— 原生路径下边缘按下被系统非客户区命中测试(HTRIGHT)吞掉,
 * 本文件的手柄在 win32 上收不到 pointerdown,仅是 no-drag 屏蔽 + 光标样式;
 * 缩放手势的开始/结束改由主进程 will-resize/resized 推送(onResizeGesture)。
 * **非 win32** 保持 0056 分工:renderer 只负责「按下 → pet:resize-start、
 * 松开/取消 → pet:resize-end」两个信号;尺寸计算在主进程专用循环
 * (16ms/60Hz)里锚定对侧边 setBounds,不做逐帧 IPC(规避"逐帧 setPosition
 * 卡顿 + 参数转换崩溃"的教训,AGENTS.md)。
 *
 * 指针捕获:按下时 setPointerCapture,窗口被拉伸/指针移出窗口后松开事件仍路由
 * 到本手柄,resize-end 不漏发;窗口失焦(Alt-Tab 等打断捕获)由 blur 兜底收尾。
 */
export function createWindowResizeHandles(api: PetApi | undefined): () => void {
  if (!api) return () => {}
  const cleanup: (() => void)[] = []
  /**
   * 0056d:缩放期间把 #stage 的 `-webkit-app-region: drag` 临时改为 no-drag
   * (body.pet-resizing 类,见 index.html CSS)。原因:边缘拖拽时鼠标必然移入
   * #stage 的 drag 区域,Chromium 在拖动中持续对 drag 区域做命中测试 —— 光标
   * 一旦进入 drag 区域就向 OS 发 WM_NCLBUTTONDOWN(HTCAPTION),**原生窗口移动
   * 循环**接管窗口位置;它与我们的 setBounds 缩放(锚定对侧边)每帧互相覆盖
   * → 窗口位置来回跳,宠物(窗口比例定位)跟着**快速来回跳动**。
   * 缩放期间禁用 drag 区域即掐断原生移动,窗口位置只由 setBounds 决定。
   */
  const setResizing = (on: boolean): void => {
    document.body.classList.toggle('pet-resizing', on)
  }
  for (const edge of RESIZE_EDGES) {
    const el = document.createElement('div')
    el.className = `pet-resize-handle ${edge}`
    el.setAttribute('data-edge', edge)
    el.addEventListener('pointerdown', (e) => {
      // 按住期间指针事件(含移出窗口/窗口外松开)全部路由到本元素,松开不漏
      el.setPointerCapture(e.pointerId)
      setResizing(true)
      void api.resizeStart(edge)
    })
    const end = (e: PointerEvent): void => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      setResizing(false)
      void api.resizeEnd()
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    document.body.appendChild(el)
    cleanup.push(() => el.remove())
  }
  // 窗口失焦兜底:指针捕获可能被系统打断(Alt-Tab 等),确保 resize 状态不悬挂
  const onBlur = (): void => {
    setResizing(false)
    void api.resizeEnd()
  }
  window.addEventListener('blur', onBlur)
  cleanup.push(() => {
    setResizing(false)
    window.removeEventListener('blur', onBlur)
  })
  return () => {
    for (const dispose of cleanup) dispose()
  }
}
