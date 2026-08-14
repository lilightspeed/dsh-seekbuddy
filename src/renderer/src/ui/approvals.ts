import type { PetApi, PetEvent, PetOpResult } from '../../../shared/pet-event.ts'

/** renderer 侧待审批条目(来自 approval:pending 事件)。 */
export interface PendingApproval {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface ApprovalHooks {
  /** 气泡提示(ok 绿 / 失败红)。 */
  onFlash(text: string, ok: boolean): void
  /** 待审批数量变化(面板角标)。 */
  onCountChange(count: number): void
}

/**
 * 审批中心:维护 pending 表 + 浮动审批卡(允许/拒绝)。
 * 回包走 api.respondApproval(echo rpcId);失败不弹系统通知,气泡提示即可。
 */
export function createApprovalCenter(api: PetApi, hooks: ApprovalHooks) {
  const pending = new Map<string, PendingApproval>() // key: rpcId
  const listeners = new Set<(list: PendingApproval[]) => void>()

  function emit(): void {
    const list = [...pending.values()]
    hooks.onCountChange(list.length)
    for (const listener of listeners) listener(list)
  }

  function add(ev: Extract<PetEvent, { type: 'approval:pending' }>): void {
    const item: PendingApproval = { rpcId: ev.rpcId, sessionId: ev.sessionId, approvalId: ev.approvalId, toolName: ev.toolName }
    if (ev.callId !== undefined) item.callId = ev.callId
    if (ev.reason !== undefined) item.reason = ev.reason
    pending.set(ev.rpcId, item)
    emit()
  }

  function removeByApprovalId(approvalId: string): void {
    for (const [rpcId, item] of pending) {
      if (item.approvalId === approvalId) pending.delete(rpcId)
    }
    emit()
  }

  function removeByRpcId(rpcId: string): void {
    pending.delete(rpcId)
    emit()
  }

  async function respond(item: PendingApproval, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const result: PetOpResult = await api.respondApproval({
      rpcId: item.rpcId,
      sessionId: item.sessionId,
      approvalId: item.approvalId,
      outcome,
    })
    if (result.ok) {
      removeByRpcId(item.rpcId)
      hooks.onFlash(outcome === 'allowed-once' ? '✅ 已允许' : '⛔ 已拒绝', true)
    } else {
      hooks.onFlash(`✗ 审批回包失败:${result.summary}`, false)
    }
  }

  return {
    add,
    removeByApprovalId,
    removeByRpcId,
    respond,
    list: (): PendingApproval[] => [...pending.values()],
    subscribe(listener: (list: PendingApproval[]) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
