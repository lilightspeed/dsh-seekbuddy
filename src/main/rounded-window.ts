import { type BrowserWindow } from 'electron'

/**
 * 窗口边缘外观(Windows 11 专用,经 DwmSetWindowAttribute):
 * - 普通模式:圆角偏好 ROUND,让 DWM 把窗口**本身**裁成圆角,连 acrylic 高斯
 *   模糊背景一起裁圆 —— 圆角外的模糊被 DWM 裁剪掉,圆角内保留模糊。
 * - 极简模式:直角偏好 DONOTROUND + 描边 NONE(圆角窗口的伴生描边/阴影与
 *   "仅显示宠物"矛盾,见 applyWindowEdgeStyle)。
 *
 * 为什么不用 SetWindowRgn(26d403d 的路线,已废弃):
 * Electron 43 的透明窗口走 DirectComposition 渲染,Win32 窗口区域
 * (SetWindowRgn / DwmEnableBlurBehindWindow 的 hRgnBlur)对它静默失效
 * —— SetWindowRgn 返回 1 但 GetWindowRgn 立即为 NULLREGION,DWM 的
 * acrylic 背景依旧铺满整个矩形(实测)。唯一能裁剪 DWM 背景的是系统级
 * 圆角偏好,代价是圆角半径由系统固定(本机 ~8 DIP,150% 缩放下 ~12px
 * 物理像素),renderer 的卡片圆角需适配为同一值(见 index.html)。
 *
 * 只在 win32 生效;其他平台静默 no-op。窗口重建后需重新设置
 * (Electron 创建窗口时会设回 DONOTROUND)。
 */

/** 与系统圆角偏好对齐的圆角半径(DIP),renderer 的 #bg / 输入条底部圆角用同值。 */
export const SYSTEM_CORNER_RADIUS_DIP = 8

/** DWMWA_WINDOW_CORNER_PREFERENCE(Win11 22H2+):DWMWCP_ROUND / DWMWCP_DONOTROUND */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUND = 2
const DWMWCP_DONOTROUND = 1
/**
 * DWMWA_BORDER_COLOR(Win11 22H2+):DWM 给圆角窗口自带的 1px 描边颜色。
 * 极简模式下窗口全透明,这圈描边就是"宠物周围一圈很细的灰边"的来源 ——
 * 设 DWMWA_COLOR_NONE 彻底去除;普通模式恢复 DWMWA_COLOR_DEFAULT(系统默认)。
 */
const DWMWA_BORDER_COLOR = 34
const DWMWA_COLOR_NONE = 0xfffffffe
const DWMWA_COLOR_DEFAULT = 0xffffffff

interface Win32CornerFfi {
  dwmSetWindowAttribute(hwnd: bigint, attr: number, attrValue: Buffer, attrSize: number): number
}

let ffiPromise: Promise<Win32CornerFfi | null> | null = null

/** 懒加载 koffi(仅 win32):native 模块缺失/加载失败时不拖垮主进程。 */
function getFfi(): Promise<Win32CornerFfi | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!ffiPromise) {
    ffiPromise = (async () => {
      try {
        const koffi = (await import('koffi')).default
        const dwmapi = koffi.load('dwmapi.dll')
        const dwmSetWindowAttribute = dwmapi.func(
          'int DwmSetWindowAttribute(void* hwnd, int attr, void* attrValue, int attrSize)',
        )
        return { dwmSetWindowAttribute }
      } catch (error) {
        console.warn('[pet] koffi/DwmSetWindowAttribute 初始化失败:', error)
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

/** 写一个 32 位 DWM 窗口属性;失败返回 false(调用方告警但不中断)。 */
async function setDwmInt(win: BrowserWindow, attr: number, value: number): Promise<boolean> {
  if (process.platform !== 'win32' || win.isDestroyed()) return false
  try {
    const ffi = await getFfi()
    if (!ffi) return false
    const buf = Buffer.alloc(4)
    buf.writeInt32LE(value | 0, 0)
    const ret = ffi.dwmSetWindowAttribute(readHwnd(win.getNativeWindowHandle()), attr, buf, 4)
    if (ret !== 0) {
      console.warn(`[pet] DwmSetWindowAttribute(attr=${attr}) 失败:ret=${ret}`)
      return false
    }
    return true
  } catch (error) {
    console.warn('[pet] DwmSetWindowAttribute 异常:', error)
    return false
  }
}

/**
 * 按极简模式收敛窗口边缘外观(Win11 专用,其他平台 no-op):
 * - 极简模式:圆角偏好 DONOTROUND + 描边 DWMWA_COLOR_NONE。Win11 对圆角窗口
 *   会附带画 1px 灰描边和窗口外阴影(DWM 圆角窗口的伴生 chrome),在极简模式的
 *   全透明窗口上表现为"宠物周围一圈细灰边 + 边框外阴影"—— 只有去掉圆角偏好
 *   和描边才能让窗口边缘彻底干净(阴影随圆角 chrome 一并消失)。
 * - 普通模式:恢复圆角偏好 ROUND(裁剪 acrylic 模糊背景必需)+ 默认描边。
 * 窗口重建/resize 后需重新调用(DWM 属性不随窗口保留,Electron 会重置圆角偏好)。
 */
export async function applyWindowEdgeStyle(win: BrowserWindow, petOnly: boolean): Promise<boolean> {
  const corner = await setDwmInt(win, DWMWA_WINDOW_CORNER_PREFERENCE, petOnly ? DWMWCP_DONOTROUND : DWMWCP_ROUND)
  const border = await setDwmInt(win, DWMWA_BORDER_COLOR, petOnly ? DWMWA_COLOR_NONE : DWMWA_COLOR_DEFAULT)
  return corner || border
}
