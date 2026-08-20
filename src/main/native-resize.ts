import type { BrowserWindow } from 'electron'

/**
 * 0056e:Windows 原生窗口缩放 —— 向窗口发送 WM_NCLBUTTONDOWN + 非客户区命中
 * 测试码,让 DefWindowProc 进入**系统级 sizing 循环**(与标题栏/边框缩放的
 * 同一路径)。窗口框架与内容由 OS/DWM 一起移动,彻底消除"程序化 setBounds 缩放
 * 时宠物/组件来回弹跳"(多次轮询方案均未根治,0056b/c/d)。
 *
 * 模态循环运行在调用线程(主进程):SendMessage 阻塞到用户松开鼠标,期间主进程
 * 的 Node 事件循环暂停(光标轮询/DSH 转发停顿 —— 拖拽是短暂手势,可接受;
 * renderer 是独立进程,照常渲染)。MIN/MAX 夹取由 win.setMinimumSize/
 * setMaximumSize(WM_GETMINMAXINFO)在系统循环内自然生效。
 *
 * 仅在 win32 生效;koffi 不可用或失败返回 false,调用方回落轮询方案。
 */

const WM_NCLBUTTONDOWN = 0x00a1

/** Win32 非客户区命中测试码(与边缘/四角一一对应)。 */
const HIT_TEST: Record<string, number> = {
  n: 12, // HTTOP
  s: 15, // HTBOTTOM
  e: 11, // HTRIGHT
  w: 10, // HTLEFT
  ne: 14, // HTTOPRIGHT
  nw: 13, // HTTOPLEFT
  se: 17, // HTBOTTOMRIGHT
  sw: 16, // HTBOTTOMLEFT
}

interface SendMessageFfi {
  sendMessageW(hwnd: bigint, msg: number, wParam: number, lParam: number): number
}

let ffiPromise: Promise<SendMessageFfi | null> | null = null

/** 懒加载 koffi(仅 win32):native 模块缺失/加载失败时返回 null,不拖垮主进程。 */
function getSendMessage(): Promise<SendMessageFfi | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!ffiPromise) {
    ffiPromise = (async () => {
      try {
        const koffi = (await import('koffi')).default
        const user32 = koffi.load('user32.dll')
        const sendMessageW = user32.func('int SendMessageW(void* hwnd, uint msg, uint wParam, uint lParam)')
        return { sendMessageW }
      } catch (error) {
        console.warn('[pet] koffi/SendMessageW 初始化失败:', error)
        return null
      }
    })()
  }
  return ffiPromise
}

/** 读取 native window handle 的 HWND 整数值(平台指针宽)。 */
function readHwnd(handle: Buffer): bigint {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
}

/**
 * 进入原生缩放循环(阻塞直到松开鼠标)。
 * @param cursor 当前屏幕光标(DIP;WM_NCLBUTTONDOWN 的 lParam 起点)
 * @returns 是否成功发起;false = 非 win32 / koffi 不可用 / 非法边缘。
 */
export async function startNativeResize(
  win: BrowserWindow,
  edge: string,
  cursor: { x: number; y: number },
): Promise<boolean> {
  if (process.platform !== 'win32' || win.isDestroyed()) return false
  const ffi = await getSendMessage()
  const hitTest = HIT_TEST[edge]
  if (!ffi || hitTest === undefined) return false
  try {
    // lParam = 屏幕坐标(x 低 16 位 / y 高 16 位,负坐标按补码打包)
    const lParam = ((cursor.y & 0xffff) << 16) | (cursor.x & 0xffff)
    // frameless 窗口需临时可缩放(WS_THICKFRAME),系统 sizing 循环才完整生效
    win.setResizable(true)
    ffi.sendMessageW(readHwnd(win.getNativeWindowHandle()), WM_NCLBUTTONDOWN, hitTest, lParam)
    // SendMessage 返回 = 系统循环结束(用户已松开鼠标)
    win.setResizable(false)
    return true
  } catch (error) {
    console.warn('[pet] 原生缩放失败(回落轮询方案):', error)
    try {
      win.setResizable(false)
    } catch {
      // 忽略恢复失败
    }
    return false
  }
}
