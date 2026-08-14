import { RpcId, type ApprovalResponsePayload, type ClientResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import type {
  PetApprovalRequest,
  PetCreateResult,
  PetHistoryEntry,
  PetHistoryResult,
  PetOpResult,
  PetSessionListResult,
  PetSessionSummary,
} from '../../shared/pet-event.ts'
import type { ConnectionHandle } from './connection.ts'

/**
 * 阶段 3 操作面:会话列表/切换/历史 + 审批回包。
 * 所有方法签名以仓库 client 类型为准;这里只做"仓库类型 → 扁平展示类型"的翻译,
 * 不手写协议。审批回包走 `api.respond`(echo 服务端 rpcId),不是 unary 方法。
 */
export interface PetOps {
  listSessions(): Promise<PetSessionListResult>
  getHistory(sessionId: string, beforeSeq: number | null, maxMessages: number | null): Promise<PetHistoryResult>
  selectSession(sessionId: string | null): PetOpResult
  createSession(): Promise<PetCreateResult>
  respondApproval(request: PetApprovalRequest): Promise<PetOpResult>
}

export function createPetOps(
  getConnection: () => ConnectionHandle | undefined,
  getTargetSessionId: () => string | null,
  setTargetSessionId: (id: string | null) => void,
): PetOps {
  /** tool/call 的 callId → 工具名,用于 tool/result 展示(跨页保留)。 */
  const toolNames = new Map<string, string>()

  async function listSessions(): Promise<PetSessionListResult> {
    const connection = getConnection()
    if (!connection) return { ok: false, summary: 'connection not ready', targetSessionId: getTargetSessionId(), items: [] }
    try {
      const response = await connection.api.sessions.list({})
      const result = response.result
      if (!result.ok) {
        return { ok: false, summary: `rpc error: ${JSON.stringify(result.error)}`, targetSessionId: getTargetSessionId(), items: [] }
      }
      const items: PetSessionSummary[] = result.value.items.map((item) => ({
        sessionId: String(item.sessionId),
        title: sessionTitle(item),
        updatedAt: item.updatedAt,
        running: item.running,
        blank: item.blank,
      }))
      return { ok: true, summary: `${items.length} sessions`, targetSessionId: getTargetSessionId(), items }
    } catch (error) {
      return { ok: false, summary: String(error), targetSessionId: getTargetSessionId(), items: [] }
    }
  }

  async function getHistory(
    sessionId: string,
    beforeSeq: number | null,
    maxMessages: number | null,
  ): Promise<PetHistoryResult> {
    const connection = getConnection()
    if (!connection) return { ok: false, summary: 'connection not ready', sessionId, hasMore: false, entries: [] }
    if (!sessionId) return { ok: false, summary: 'missing sessionId', sessionId: null, hasMore: false, entries: [] }
    try {
      const response = await connection.api.sessions.history({
        sessionId: sessionId as SessionId,
        ...(beforeSeq === null ? {} : { beforeSeq }),
        ...(maxMessages === null ? {} : { maxMessages }),
      })
      const result = response.result
      if (!result.ok) {
        return { ok: false, summary: `rpc error: ${JSON.stringify(result.error)}`, sessionId, hasMore: false, entries: [] }
      }
      const entries = result.value.events.map((entry) => flattenEvent(entry.event, toolNames)).filter((e): e is PetHistoryEntry => e !== null)
      return { ok: true, summary: `${entries.length} events`, sessionId, hasMore: result.value.hasMore, entries }
    } catch (error) {
      return { ok: false, summary: String(error), sessionId, hasMore: false, entries: [] }
    }
  }

  function selectSession(sessionId: string | null): PetOpResult {
    setTargetSessionId(sessionId)
    return { label: 'session.select', ok: true, summary: sessionId ? `target → ${sessionId}` : 'target cleared (fallback: most recent)' }
  }

  async function createSession(): Promise<PetCreateResult> {
    const connection = getConnection()
    if (!connection) return { ok: false, summary: 'connection not ready' }
    try {
      const response = await connection.api.sessions.create({})
      const result = response.result
      if (!result.ok) {
        return { ok: false, summary: `rpc error: ${JSON.stringify(result.error)}` }
      }
      const sessionId = String(result.value.sessionId)
      setTargetSessionId(sessionId)
      return { ok: true, summary: `created → ${sessionId}`, sessionId }
    } catch (error) {
      return { ok: false, summary: String(error) }
    }
  }

  async function respondApproval(request: PetApprovalRequest): Promise<PetOpResult> {
    const connection = getConnection()
    if (!connection) return { label: 'approval.respond', ok: false, summary: 'connection not ready' }
    if (request.outcome !== 'allowed-once' && request.outcome !== 'rejected') {
      return { label: 'approval.respond', ok: false, summary: 'invalid outcome' }
    }
    try {
      // ApprovalResponsePayload 的品牌字段是编译期标记;此处从 renderer 字符串回填,
      // 协议形状由 ApprovalResponsePayload 承担,wire 校验在 /api/respond 端。
      const value = {
        sessionId: String(request.sessionId),
        approvalId: String(request.approvalId),
        outcome: request.outcome,
      } as unknown as ApprovalResponsePayload
      const message: ClientResponse = {
        type: 'client-response',
        rpcId: RpcId(String(request.rpcId)),
        result: { ok: true, value },
      }
      const receipt = await connection.api.respond(message)
      if (!receipt.accepted) {
        return { label: 'approval.respond', ok: false, summary: `not accepted: ${receipt.reason}` }
      }
      return { label: 'approval.respond', ok: true, summary: `${request.outcome === 'allowed-once' ? 'allowed' : 'rejected'} → ${request.approvalId}` }
    } catch (error) {
      return { label: 'approval.respond', ok: false, summary: String(error) }
    }
  }

  return { listSessions, getHistory, selectSession, createSession, respondApproval }
}

/** 会话标题:list 行的 projections.values.title(投影缓存;无则 null)。 */
function sessionTitle(item: { projections?: { values?: Record<string, unknown> } }): string | null {
  const title = item.projections?.values?.['title']
  return typeof title === 'string' && title.length > 0 ? title : null
}

/**
 * 把一条 SessionEvent 摊平成展示行;噪音事件(chunk/step/request/todo)返回 null。
 * 仅取 type 字段窄化,不依赖具体 data 深度(与仓库类型同源)。
 */
function flattenEvent(event: SessionEvent, toolNames: Map<string, string>): PetHistoryEntry | null {
  const base = { seq: event.seq, time: event.time }
  switch (event.type) {
    case 'user/message': {
      const text = event.data.content.map((block) => (block.type === 'text' ? block.text : '')).filter(Boolean).join('\n')
      return { ...base, kind: 'user', text: text || '(无文本)' }
    }
    case 'assistant/message': {
      const text = event.data.message.content.map((block) => (block.type === 'text' ? block.text : '')).filter(Boolean).join('\n')
      return { ...base, kind: 'assistant', text: text || '(无文本)' }
    }
    case 'tool/call': {
      toolNames.set(String(event.data.callId), event.data.name)
      return { ...base, kind: 'tool', text: `🔧 ${event.data.name}` }
    }
    case 'tool/result': {
      const isError = event.data.error !== undefined || event.data.message.content[0]?.isError === true
      const name = toolNames.get(String(event.data.message.content[0]?.toolCallId)) ?? 'tool'
      return { ...base, kind: 'tool', text: `${isError ? '✗' : '✓'} ${name}${isError ? ' 失败' : ''}` }
    }
    case 'turn/start':
      return { ...base, kind: 'meta', text: `▶ 回合 ${event.data.turn}` }
    case 'turn/end':
      return { ...base, kind: 'meta', text: `■ 回合 ${event.data.turn} · ${event.data.reason.kind}` }
    default:
      return null
  }
}
