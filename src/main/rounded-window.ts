import { type BrowserWindow } from 'electron'

/**
 * 系统圆角窗口(Windows 11 专用):设置 DWMWA_WINDOW_CORNER_PREFERENCE = ROUND,
 * 让 DWM 把窗口**本身**裁成圆角,从而连 acrylic 高斯模糊背景一起裁圆
 * —— 圆角外的模糊被 DWM 裁剪掉,圆角内保留模糊。
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

/** DWMWA_WINDOW_CORNER_PREFERENCE / DWMWCP_ROUND(Win11 22H2+) */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUND = 2

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

/**
 * 设置系统圆角偏好(ROUND)。返回是否成功;失败不抛异常(日志告警)。
 * 窗口重建后需重新调用(createWindow / ready-to-show / resize)。
 */
export async function applySystemRoundedCorners(win: BrowserWindow): Promise<boolean> {
  if (process.platform !== 'win32' || win.isDestroyed()) return false
  try {
    const ffi = await getFfi()
    if (!ffi) return false
    const value = Buffer.alloc(4)
    value.writeInt32LE(DWMWCP_ROUND, 0)
    const ret = ffi.dwmSetWindowAttribute(readHwnd(win.getNativeWindowHandle()), DWMWA_WINDOW_CORNER_PREFERENCE, value, 4)
    if (ret !== 0) {
      console.warn(`[pet] DwmSetWindowAttribute(圆角偏好)失败:ret=${ret}`)
      return false
    }
    return true
  } catch (error) {
    console.warn('[pet] 系统圆角设置失败:', error)
    return false
  }
}
