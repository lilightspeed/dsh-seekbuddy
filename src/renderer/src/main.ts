import type { HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import type { PetApi, PetEvent, PetOpResult } from '../../shared/pet-event.ts'

declare global {
  interface Window {
    petApi?: PetApi
  }
}

const api = window.petApi
const connEl = document.querySelector<HTMLDivElement>('#conn')
const describeEl = document.querySelector<HTMLPreElement>('#describe')
const opsEl = document.querySelector<HTMLDivElement>('#ops')
const framesEl = document.querySelector<HTMLUListElement>('#frames')

const FRAME_LIMIT = 12

function setConn(text: string): void {
  console.log('[pet] state:', text)
  if (connEl) connEl.textContent = text
}

function showDescribe(description: HostDescription): void {
  console.log('[pet] describe:', description)
  if (describeEl) describeEl.textContent = JSON.stringify(description, null, 2)
}

function showOp(result: PetOpResult): void {
  console.log(`[pet] op ${result.ok ? 'ok' : 'fail'}:`, result.summary)
  if (!opsEl) return
  const line = document.createElement('div')
  line.textContent = `${result.ok ? '✓' : '✗'} ${result.label}: ${result.summary}`
  opsEl.prepend(line)
}

function logFrame(frameType: string, stream: 'mux' | 'host'): void {
  if (!framesEl) return
  const li = document.createElement('li')
  li.textContent = `[${stream}] ${frameType}`
  framesEl.prepend(li)
  while (framesEl.children.length > FRAME_LIMIT) {
    framesEl.lastChild?.remove()
  }
}

if (!api) {
  setConn('preload 未注入 window.petApi(检查 preload 路径)')
} else {
  let listedOnce = false

  api.onPetEvent((event: PetEvent) => {
    switch (event.type) {
      case 'dsh:connected':
        setConn('connected')
        showDescribe(event.description)
        // 连接就绪后自动跑一次真实操作,证明上行可用(阶段 1 验收项)
        if (!listedOnce) {
          listedOnce = true
          void api.listSessions().then(showOp)
        }
        break
      case 'dsh:state':
        setConn(event.state)
        break
      case 'dsh:frame':
        logFrame(event.frameType, event.stream)
        break
      case 'op:result':
        showOp(event)
        break
    }
  })

  // 若连接在订阅前已完成,补读当前状态(首次 connected 存在竞态,以 getState 兜底)
  void api.getState().then((state) => {
    if (state.connection) setConn(state.connection)
    if (state.description) showDescribe(state.description)
  })

  document.querySelector<HTMLButtonElement>('#btn-list')?.addEventListener('click', () => {
    void api.listSessions().then(showOp)
  })
  document.querySelector<HTMLButtonElement>('#btn-reconnect')?.addEventListener('click', () => {
    setConn('reconnecting(手动触发)…')
    void api.debugReconnect()
  })
}
