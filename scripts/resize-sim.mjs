// 用法:node scripts/resize-sim.mjs [edge] [title]  edge ∈ e|w|s|n|se|... 默认 e;title 默认 "SeekBuddy"
import { load, struct } from 'koffi'

const edge = process.argv[2] ?? 'e'
const title = process.argv[3] ?? 'SeekBuddy'
const user32 = load('user32.dll')
const RECT = struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
const FindWindowW = user32.func('void *FindWindowW(str16 cls, str16 title)')
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ RECT *rect)')
const SetCursorPos = user32.func('bool SetCursorPos(int x, int y)')
const mouseEvent = user32.func('void mouse_event(uint flags, uint dx, uint dy, uint data, uintptr_t extra)')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hwnd = FindWindowW(null, title)
if (!hwnd) throw new Error(`window "${title}" not found`)
const rect = () => {
  const r = {}
  GetWindowRect(hwnd, r)
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}
const fmt = (tag, r) => `${tag} rect=${r.x},${r.y} w=${r.w} h=${r.h}`

const r0 = rect()
console.log(fmt('start', r0))
// 边缘手柄起点(手柄 8px 宽,四角 16px)
const cx = edge.includes('w') ? r0.x + 4 : edge.includes('e') ? r0.x + r0.w - 4 : r0.x + r0.w / 2
const cy = edge.includes('n') ? r0.y + 4 : edge.includes('s') ? r0.y + r0.h - 4 : r0.y + r0.h / 2
SetCursorPos(cx, cy)
await sleep(250)
mouseEvent(0x0002, 0, 0, 0, 0) // LEFTDOWN
await sleep(200)
// 沿边方向拖 120px:纯横向边(e/w)只拖 X,纯纵向边(s/n)只拖 Y,角拖斜向
const dx = edge.includes('e') ? 120 : edge.includes('w') ? -120 : 0
const dy = edge.includes('s') ? 80 : edge.includes('n') ? -80 : 0
const steps = 12
for (let i = 1; i <= steps; i++) {
  SetCursorPos(cx + (dx * i) / steps, cy + (dy * i) / steps)
  await sleep(25)
  console.log(fmt(`t=${i * 25}ms`, rect()))
}
await sleep(250)
mouseEvent(0x0004, 0, 0, 0, 0) // LEFTUP
await sleep(200)
console.log(fmt('final', rect()))
