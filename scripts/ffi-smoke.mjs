// 0063 冒烟测试:端到端验证 koffi 的 SetWindowSubclass 子类回调机制
// (纯 Node,不依赖 Electron):创建隐藏窗口 → 子类化 → SendMessageW(WM_NCHITTEST)
// → 验证回调收到消息、参数类型正确、返回值能传回。
const koffi = (await import('koffi')).default

const WM_NCHITTEST = 0x0084
const WM_GETDLGCODE = 0x0087
const HTCLIENT = 1
const HTTOPLEFT = 13

let fails = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) fails++
}

try {
  const user32 = koffi.load('user32.dll')
  const comctl32 = koffi.load('comctl32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  check('load user32/comctl32/kernel32', true)

  const proto = koffi.proto(
    'long PetSubclassProc(void* hWnd, unsigned int uMsg, uintptr wParam, uintptr lParam, uintptr uIdSubclass, uintptr dwRefData)',
  )
  const callbackType = koffi.pointer(proto)
  check('koffi.proto 解析成功', true)

  let sawHitTest = false
  let argTypes = ''
  let chainResult = ''
  function cb(hwnd, uMsg, wParam, lParam, uId, ref) {
    argTypes = `hwnd=${typeof hwnd}(${hwnd}) uMsg=${typeof uMsg}(${uMsg}) wParam=${typeof wParam} lParam=${typeof lParam}(${lParam}) uId=${typeof uId} ref=${typeof ref}`
    if (uMsg === WM_NCHITTEST) {
      sawHitTest = true
      // uintptr 以 Number 传入:屏幕坐标在 2^31 内,Number 位运算精确
      const l = Number(lParam)
      const x = l & 0xffff
      const y = (l >>> 16) & 0xffff
      return x === 10 && y === 10 ? HTTOPLEFT : HTCLIENT
    }
    if (uMsg === WM_GETDLGCODE) {
      const r = defSubclassProc(hwnd, uMsg, wParam, lParam)
      chainResult = `in-callback defSubclassProc=${r} (typeof ${typeof r})`
      return r === null ? 0 : r
    }
    return 0
  }
  const proc = koffi.register(cb, callbackType)
  check('koffi.register 回调注册', typeof proc === 'bigint', `proc=${proc}`)

  const createWindowExW = user32.func(
    'void* CreateWindowExW(uint dwExStyle, str16 lpClassName, str16 lpWindowName, uint dwStyle, int X, int Y, int nWidth, int nHeight, void* hWndParent, void* hMenu, void* hInstance, void* lpParam)',
  )
  const getModuleHandleW = kernel32.func('void* GetModuleHandleW(str16 lpModuleName)')
  const destroyWindow = user32.func('int DestroyWindow(void* hWnd)')
  const sendMessageW = user32.func('void* SendMessageW(void* hWnd, uint uMsg, uintptr wParam, uintptr lParam)')

  const hwnd = createWindowExW(0, 'STATIC', 'pet-ffi-smoke', 0x80000000 /* WS_POPUP,不显示 */, 0, 0, 300, 300, 0n, 0n, getModuleHandleW(null), 0n)
  check('CreateWindowExW 创建隐藏窗口', typeof hwnd === 'bigint' && hwnd !== 0n, `hwnd=${hwnd}`)
  if (!hwnd) process.exit(1)

  const setWindowSubclass = comctl32.func('int SetWindowSubclass(void* hWnd, void* pfnSubclass, uintptr uIdSubclass, uintptr dwRefData)')
  const defSubclassProc = comctl32.func('long DefSubclassProc(void* hWnd, unsigned int uMsg, uintptr wParam, uintptr lParam)')
  const removeWindowSubclass = comctl32.func('int RemoveWindowSubclass(void* hWnd, void* pfnSubclass, uintptr uIdSubclass)')

  const ok = setWindowSubclass(hwnd, proc, 1, 0)
  check('SetWindowSubclass 成功', ok === 1, `ret=${ok}`)

  // 合成 lParam:(x=10, y=10) —— 应命中我们的 HTTOPLEFT 分支
  const lp = (10 << 16) | 10
  const r1 = sendMessageW(hwnd, WM_NCHITTEST, 0, lp)
  check('WM_NCHITTEST 回调收到且返回值传回', sawHitTest && r1 === BigInt(HTTOPLEFT), `ret=${r1} argTypes=[${argTypes}]`)

  // 非命中测试消息 → 应经 DefSubclassProc 交还(STATIC 类处理 WM_GETDLGCODE 返回 DLGC_STATIC=0x100)
  const r2 = sendMessageW(hwnd, WM_GETDLGCODE, 0, 0)
  check('非 NCHITTEST 经 DefSubclassProc 交还', r2 === BigInt(0x100), `ret=${r2} ${chainResult}`)

  // 移除子类后恢复原行为(STATIC 基类对 NCHITTEST 返回 HTNOWHERE=-1,仅记录)
  const rm = removeWindowSubclass(hwnd, proc, 1)
  check('RemoveWindowSubclass 成功', rm === 1, `ret=${rm}`)
  const r3 = sendMessageW(hwnd, WM_NCHITTEST, 0, lp)
  console.log(`INFO  移除子类后 NCHITTEST 交还原类 ret=${r3}(STATIC 类返回 HTNOWHERE,符合预期)`)

  destroyWindow(hwnd)
} catch (e) {
  console.error('EXCEPTION:', e)
  fails++
}

console.log(fails === 0 ? '\n== 全部通过 ==' : `\n== ${fails} 项失败 ==`)
process.exit(fails === 0 ? 0 : 1)
