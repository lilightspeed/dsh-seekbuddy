/**
 * 0063 win32 缩放手势结束判定的左键状态查询(koffi FFI,懒加载,失败静默退化)。
 *
 * 只保留**从 JS 同步调用**的 GetAsyncKeyState —— 这类调用与 rounded-window.ts
 * 的 DwmSetWindowAttribute 同款,安全。切勿再往 win32 窗口挂 koffi 原生回调
 * (SetWindowSubclass 等):koffi 回调在 Electron 主进程的 OS 消息泵里是被排队
 * 延迟执行的,回调里再调 DefSubclassProc 已脱离系统 dispatch 上下文,实测
 * COMCTL32.dll ACCESS_VIOLATION / 0xC000041D(STATUS_FATAL_USER_CALLBACK_
 * EXCEPTION)崩溃 —— WM_NCHITTEST 子类方案不可行(0063 实测),详见 AGENTS.md。
 */

const VK_LBUTTON = 0x01

interface KeyStateFfi {
  /** SHORT GetAsyncKeyState(int vKey):bit15 = 当前按下。 */
  getAsyncKeyState(vKey: number): number
}

let ffiPromise: Promise<KeyStateFfi | null> | null = null
/** 已解析的 FFI(isLeftButtonDown 同步读取;加载失败保持 null)。 */
let ffi: KeyStateFfi | null = null

function loadFfi(): Promise<KeyStateFfi | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!ffiPromise) {
    ffiPromise = (async () => {
      try {
        const koffi = (await import('koffi')).default
        const user32 = koffi.load('user32.dll')
        const instance: KeyStateFfi = {
          getAsyncKeyState: user32.func('short GetAsyncKeyState(int vKey)'),
        }
        ffi = instance
        return instance
      } catch (error) {
        console.warn('[pet] GetAsyncKeyState FFI 初始化失败(缩放结束兜底退化为静默判定):', error)
        return null
      }
    })()
  }
  return ffiPromise
}

/** 启动即预热 FFI(避免首次缩放兜底判定时尚未加载完成)。 */
export function warmUpWin32KeyState(): void {
  void loadFfi()
}

/** 0063:左键当前是否按下(GetAsyncKeyState,VK_LBUTTON 的 bit15)。FFI 不可用时视为未按下。 */
export function isLeftButtonDown(): boolean {
  const f = ffi
  if (!f) return false
  return (f.getAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0
}
