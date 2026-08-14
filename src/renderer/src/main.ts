import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'

// 阶段1(连通性 PoC)将在这里装配 WebApiClient + ConnectionController:
//   const api: IApiClient = new WebApiClient({ baseUrl: 'http://127.0.0.1:3080' })
// 当前仅用类型探针证明 workspace:^ 引用 `@deepseek-ai/dsh-client-connection/client` 可解析。
const apiProbe: IApiClient | undefined = undefined
console.log('[pet] renderer ready, api probe =', apiProbe)

const appEl = document.querySelector<HTMLDivElement>('#app')
if (appEl) appEl.textContent = 'DSH Pet 骨架窗口就绪'
