import type { BrowserWindow } from 'electron'

/**
 * 0063 win32 原生缩放的底层支撑(koffi FFI;加载失败时静默退化,不拖垮主进程):
 *
 * 1) **四角/四边命中区扩展**:Electron frameless 窗口的原生缩放命中区只有窗口
 *    最外约 5px(Chromium kResizeInsideBoundsSize)。renderer 的四角手柄是
 *    24×24、四边手柄 8px(no-drag + resize 光标,见 index.html .pet-resize-handle),
 *    于是"手柄圈内、5px 之外"的环形区域按下时既不是原生缩放(超出命中区)也不是
 *    窗口拖动(no-drag 屏蔽 drag 区域)—— **按下完全无反应**,是否触发全看落点,
 *    这就是"有概率拖不动"的来源(0056e 的 SendMessageW(WM_NCLBUTTONDOWN, HT*)
 *    注入路线失败:Chromium 窗口过程吞掉注入消息;子类化 WM_NCHITTEST 则不同,
 *    系统对真实鼠标按下按命中码进入原生 sizing 循环,与原生 5px 区同一条路径)。
 *    这里用 comctl32 的 SetWindowSubclass 子类化 WM_NCHITTEST:光标落在手柄几何
 *    内时直接返回对应 HT 命中码(左上角 HTTOPLEFT …),原生 sizing 循环即刻启动;
 *    几何外一律 DefSubclassProc 交还 Chromium(drag 区域/原生 5px 行为不变)。
 *    几何与 index.html 完全一致(CSS px → 按窗口 DPI 换算物理 px):
 *    角 24×24,边 8px,边带与角 12px 退让(边手柄 left/right 或 top/bottom 各 12px)。
 *
 * 2) **左键状态查询(GetAsyncKeyState)**:win32 原生缩放下 renderer 收不到任何
 *    指针事件(按下被非客户区命中测试吞掉),主进程无法从事件知道手势是否结束。
 *    `resized` 事件偶发缺失,而"resize 事件静默"既可能是松手结束、也可能是拖拽
 *    中途光标停顿 —— 用左键状态区分二者:静默 + 左键已松开 = 结束;静默 + 左键
 *    仍按下 = 暂停(见 index.ts armResizeEndFallback)。
 *
 * 极简模式锁定窗口大小时(set-resizable),命中扩展关闭(setWin32ResizeHitEnabled),
 * WM_NCHITTEST 原样交还 Electron(不再显示/响应缩放)。
 */

const WM_NCHITTEST = 0x0084
const VK_LBUTTON = 0x01
/** SetWindowSubclass 的 uIdSubclass(任意非零,移除时对账用)。 */
const SUBCLASS_ID = 0x44534850

/** WM_NCHITTEST 命中码(winuser.h)。 */
const HTLEFT = 10
const HTRIGHT = 11
const HTTOP = 12
const HTTOPLEFT = 13
const HTTOPRIGHT = 14
const HTBOTTOM = 15
const HTBOTTOMLEFT = 16
const HTBOTTOMRIGHT = 17

/** 与 index.html 的 .pet-resize-handle 几何一致(CSS px):角 24×24,边 8,边带 12px 角退让。 */
const CORNER_CSS = 24
const EDGE_CSS = 8
const EDGE_INSET_CSS = 12

interface Win32ResizeFfi {
  /** BOOL GetWindowRect(HWND, LPRECT):rect 为 16 字节 Buffer(left/top/right/bottom int32)。 */
  getWindowRect(hwnd: bigint, rect: Buffer): number
  /** UINT GetDpiForWindow(HWND):失败返回 0(调用方回退 96)。 */
  getDpiForWindow(hwnd: bigint): number
  /** SHORT GetAsyncKeyState(int vKey):bit15 = 当前按下。 */
  getAsyncKeyState(vKey: number): number
  /** BOOL SetWindowSubclass(HWND, SUBCALLPROC, UINT_PTR, DWORD_PTR)。 */
  setWindowSubclass(hwnd: bigint, proc: bigint, id: number, refData: number): number
  /** LRESULT DefSubclassProc(HWND, UINT, WPARAM, LPARAM):子类链续传。 */
  defSubclassProc(hwnd: bigint, msg: number, wParam: number, lParam: number): number
  /** BOOL RemoveWindowSubclass(HWND, SUBCALLPROC, UINT_PTR)。 */
  removeWindowSubclass(hwnd: bigint, proc: bigint, id: number): number
  /** LRESULT SendMessageW(HWND, UINT, WPARAM, LPARAM):安装自检用(合成 WM_NCHITTEST)。 */
  sendMessageW(hwnd: bigint, msg: number, wParam: number, lParam: number): bigint
  /** koffi.register 注册的子类回调指针(模块级持有防 GC)。 */
  proc: bigint
}

let ffiPromise: Promise<Win32ResizeFfi | null> | null = null
/** 已解析的 FFI(子类回调与 isLeftButtonDown 同步读取;加载失败保持 null)。 */
let ffi: Win32ResizeFfi | null = null
/** 命中扩展开关(极简模式锁定窗口大小时关闭;默认开启,与建窗 resizable:true 一致)。 */
let hitEnabled = true

/** 读取 native window handle 的 HWND 整数值(平台指针宽)。 */
function readHwnd(handle: Buffer): bigint {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
}

/** WM_NCHITTEST 子类回调:光标在手柄几何内 → 返回对应缩放命中码,否则交还 Chromium。
 *  koffi 回调实参:void* → bigint(uintptr 按 Number 传入,屏幕坐标 < 2^31 精确)。 */
function onSubclassMessage(
  hwnd: bigint,
  uMsg: number,
  wParam: number,
  lParam: number,
  _uIdSubclass: number,
  _dwRefData: number,
): number {
  const f = ffi
  if (!f) return 0
  // 非命中测试 / 扩展已关 / 合成消息(lParam=0,如键盘触发)→ 原样续传
  if (!hitEnabled || uMsg !== WM_NCHITTEST || lParam === 0) {
    return f.defSubclassProc(hwnd, uMsg, wParam, lParam)
  }
  // lParam:LOWORD=光标 x,HIWORD=光标 y(有符号 16 位,屏幕物理坐标;多显示器时
  // 坐标可能超过 32767 回绕成负数,须按有符号解读)
  const l = Number(lParam)
  let x = l & 0xffff
  let y = (l >>> 16) & 0xffff
  if (x >= 0x8000) x -= 0x10000
  if (y >= 0x8000) y -= 0x10000
  const rect = Buffer.alloc(16)
  if (!f.getWindowRect(hwnd, rect)) {
    return f.defSubclassProc(hwnd, uMsg, wParam, lParam)
  }
  const left = rect.readInt32LE(0)
  const top = rect.readInt32LE(4)
  const right = rect.readInt32LE(8)
  const bottom = rect.readInt32LE(12)
  // 手柄几何是 CSS px,按窗口 DPI 换算成物理 px,保证命中区与 DOM 手柄重合
  const dpi = f.getDpiForWindow(hwnd) || 96
  const s = dpi / 96
  const corner = Math.round(CORNER_CSS * s)
  const edge = Math.round(EDGE_CSS * s)
  const inset = Math.round(EDGE_INSET_CSS * s)
  const dl = x - left
  const dr = right - x
  const dt = y - top
  const db = bottom - y
  // 四角优先(24×24),再四边(8px,带 12px 角退让)——与 CSS 手柄区域一一对应
  if (dl < corner && dt < corner) return HTTOPLEFT
  if (dr < corner && dt < corner) return HTTOPRIGHT
  if (dl < corner && db < corner) return HTBOTTOMLEFT
  if (dr < corner && db < corner) return HTBOTTOMRIGHT
  if (dt < edge && dl >= inset && dr >= inset) return HTTOP
  if (db < edge && dl >= inset && dr >= inset) return HTBOTTOM
  if (dl < edge && dt >= inset && db >= inset) return HTLEFT
  if (dr < edge && dt >= inset && db >= inset) return HTRIGHT
  return f.defSubclassProc(hwnd, uMsg, wParam, lParam)
}

/** 懒加载 koffi + user32/comctl32,并注册一次子类回调(模块级复用,防 GC)。 */
function loadFfi(): Promise<Win32ResizeFfi | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!ffiPromise) {
    ffiPromise = (async () => {
      try {
        const koffi = (await import('koffi')).default
        const user32 = koffi.load('user32.dll')
        const comctl32 = koffi.load('comctl32.dll')
        // 注意:koffi v3 的 register 需要**回调指针类型**(pointer(proto)),裸 proto 会抛
        // "expected <callback> * type"(0063 实测)。回调实参里 uintptr 以 Number 传入。
        const proto = koffi.proto(
          'long PetSubclassProc(void* hWnd, unsigned int uMsg, uintptr wParam, uintptr lParam, uintptr uIdSubclass, uintptr dwRefData)',
        )
        const proc = koffi.register(onSubclassMessage, koffi.pointer(proto))
        const instance: Win32ResizeFfi = {
          getWindowRect: user32.func('int GetWindowRect(void* hWnd, void* lpRect)'),
          getDpiForWindow: user32.func('uint GetDpiForWindow(void* hWnd)'),
          getAsyncKeyState: user32.func('short GetAsyncKeyState(int vKey)'),
          setWindowSubclass: comctl32.func(
            'int SetWindowSubclass(void* hWnd, void* pfnSubclass, uintptr uIdSubclass, uintptr dwRefData)',
          ),
          defSubclassProc: comctl32.func('long DefSubclassProc(void* hWnd, unsigned int uMsg, uintptr wParam, uintptr lParam)'),
          removeWindowSubclass: comctl32.func('int RemoveWindowSubclass(void* hWnd, void* pfnSubclass, uintptr uIdSubclass)'),
          sendMessageW: user32.func('void* SendMessageW(void* hWnd, uint uMsg, uintptr wParam, uintptr lParam)'),
          proc,
        }
        ffi = instance
        return instance
      } catch (error) {
        console.warn('[pet] win32 缩放命中 FFI 初始化失败(缩放命中区保持 Electron 原生):', error)
        return null
      }
    })()
  }
  return ffiPromise
}

/**
 * 0063:在 win32 窗口上安装 WM_NCHITTEST 子类(命中区扩展到 CSS 手柄几何)。
 * 返回销毁函数(RemoveWindowSubclass;窗口已销毁时 no-op)。失败/非 win32 返回 no-op。
 */
export async function installWin32ResizeHit(win: BrowserWindow): Promise<() => void> {
  if (process.platform !== 'win32') return () => {}
  const f = await loadFfi()
  if (!f) return () => {}
  try {
    if (win.isDestroyed()) return () => {}
    const hwnd = readHwnd(win.getNativeWindowHandle())
    if (!f.setWindowSubclass(hwnd, f.proc, SUBCLASS_ID, 0)) {
      console.warn('[pet] SetWindowSubclass 失败,四角缩放命中区保持 Electron 原生(约 5px)')
      return () => {}
    }
    // 自检:向窗口发一个合成 WM_NCHITTEST(左上角内侧 12px 物理坐标),确认子类
    // 真的接管了命中测试 —— 返回 HTTOPLEFT 即生效;否则大概率是回调/坐标问题,
    // 输出具体返回值便于定位(0063 曾因 register 用法错误静默退化,加日志防复发)。
    try {
      const rect = Buffer.alloc(16)
      if (f.getWindowRect(hwnd, rect)) {
        const px = rect.readInt32LE(0) + 12
        const py = rect.readInt32LE(4) + 12
        const probe = f.sendMessageW(hwnd, WM_NCHITTEST, 0, ((py & 0xffff) << 16) | (px & 0xffff))
        if (Number(probe) !== HTTOPLEFT) {
          console.warn(`[pet] win32 缩放命中自检异常:WM_NCHITTEST(12,12) 返回 ${probe},预期 HTTOPLEFT=${HTTOPLEFT}`)
        } else {
          console.info('[pet] win32 缩放命中扩展已生效:四角/四边手柄几何命中 HT 码')
        }
      }
    } catch (error) {
      console.warn('[pet] win32 缩放命中自检失败:', error)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      try {
        if (!win.isDestroyed()) f.removeWindowSubclass(hwnd, f.proc, SUBCLASS_ID)
      } catch (error) {
        console.warn('[pet] RemoveWindowSubclass 失败:', error)
      }
    }
  } catch (error) {
    console.warn('[pet] win32 缩放命中扩展安装失败:', error)
    return () => {}
  }
}

/** 0063:极简模式锁定窗口大小时关闭命中扩展(set-resizable 时同步切换)。 */
export function setWin32ResizeHitEnabled(enabled: boolean): void {
  hitEnabled = enabled
}

/** 启动即预热 FFI(避免首次缩放兜底判定时尚未加载完成)。 */
export function warmUpWin32Resize(): void {
  void loadFfi()
}

/** 0063:左键当前是否按下(GetAsyncKeyState,VK_LBUTTON 的 bit15)。FFI 不可用时视为未按下。 */
export function isLeftButtonDown(): boolean {
  const f = ffi
  if (!f) return false
  return (f.getAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0
}
