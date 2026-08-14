import type { ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api'

/** host.describe 的成功值(握手后拿到的主机描述)。 */
export type HostDescription = ResponseValue<'host.describe'>

/** 宠物侧粗粒度连接状态(与主进程连接循环对应)。 */
export type ConnectionState = 'connected' | 'reconnecting'

/** 主进程 → renderer 的归一化宠物事件。 */
export type PetEvent =
  | { type: 'dsh:connected'; description: HostDescription }
  | { type: 'dsh:state'; state: ConnectionState }
  | {
      type: 'dsh:frame'
      stream: 'mux' | 'host'
      frameType: string
      /** session/event 帧的 SessionEvent.type(其余帧为 null)。 */
      eventType: string | null
    }
  | { type: 'dsh:turn-start' }
  | { type: 'dsh:turn-end' }
  | { type: 'op:result'; label: string; ok: boolean; summary: string }

/** preload 暴露给 renderer 的 window.petApi 白名单(阶段 2)。 */
export interface PetApi {
  onPetEvent(handler: (event: PetEvent) => void): () => void
  getState(): Promise<PetConnectionState>
  /** 向 DSH 最近的会话发送一条文本消息(session.prompt)。 */
  sendMessage(text: string): Promise<PetOpResult>
  /** 窗口拖拽(传 screen 坐标,CSS px)。 */
  dragStart(x: number, y: number): void
  dragMove(x: number, y: number): void
  dragEnd(): void
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
