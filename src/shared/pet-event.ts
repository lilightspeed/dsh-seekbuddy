import type { ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api'

/** host.describe 的成功值(握手后拿到的主机描述)。 */
export type HostDescription = ResponseValue<'host.describe'>

/** 宠物侧粗粒度连接状态(与主进程连接循环对应)。 */
export type ConnectionState = 'connected' | 'reconnecting'

/** 主进程 → renderer 的归一化宠物事件(阶段 1 最小集)。 */
export type PetEvent =
  | { type: 'dsh:connected'; description: HostDescription }
  | { type: 'dsh:state'; state: ConnectionState }
  | { type: 'dsh:frame'; stream: 'mux' | 'host'; frameType: string }
  | { type: 'op:result'; label: string; ok: boolean; summary: string }

/** preload 暴露给 renderer 的 window.petApi 白名单(阶段 1)。 */
export interface PetApi {
  onPetEvent(handler: (event: PetEvent) => void): () => void
  getState(): Promise<PetConnectionState>
  listSessions(): Promise<PetOpResult>
  debugReconnect(): Promise<boolean>
}

export type PetConnectionState = {
  connection: ConnectionState | null
  description: HostDescription | null
}

export type PetOpResult = {
  label: string
  ok: boolean
  summary: string
}
