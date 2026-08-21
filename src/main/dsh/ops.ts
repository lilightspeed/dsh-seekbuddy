import { RpcId, type ApprovalResponsePayload, type ClientResponse, type QuestionResponsePayload } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import type {
  PetApprovalRequest,
  PetCreateResult,
  PetHistoryEntry,
  PetHistoryResult,
  PetOpResult,
  PetQuestionRequest,
  PetSessionListResult,
  PetSessionSummary,
  PetSummaryEntry,
  PetSummaryResult,
} from '../../shared/pet-event.ts'
import type { ConnectionHandle } from './connection.ts'
import { summaryEntryOf } from './summary.ts'

/**
 * 阶段 3 操作面:会话列表/切换/历史 + 审批回包。
 * 所有方法签名以仓库 client 类型为准;这里只做"仓库类型 → 扁平展示类型"的翻译,
 * 不手写协议。审批回包走 `api.respond`(echo 服务端 rpcId),不是 unary 方法。
 */
export interface PetOps {
  listSessions(): Promise<PetSessionListResult>
  getHistory(sessionId: string, beforeSeq: number | null, maxMessages: number | null): Promise<PetHistoryResult>
  /** 最近对话浮层基线:拉尾部事件并按"重要性规则"过滤(与增量流同一过滤器)。 */
  getHistorySummary(sessionId: string, maxMessages: number | null): Promise<PetSummaryResult>
  selectSession(sessionId: string | null): PetOpResult
  createSession(): Promise<PetCreateResult>
  respondApproval(request: PetApprovalRequest): Promise<PetOpResult>
  /** 0060:回包提问(echo 服务端 rpcId;answers 按问题 id 对应,一次 ask 批量回答)。 */
  respondQuestion(request: PetQuestionRequest): Promise<PetOpResult>
  stopTurn(): Promise<PetOpResult>
}

export function createPetOps(
  getConnection: () => ConnectionHandle | undefined,
  getTargetSessionId: () => string | null,
  setTargetSessionId: (id: string | null) => void,
  resolveTargetSession: () => Promise<SessionId | null>,
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

  /**
   * 最近对话浮层基线:拉尾部事件,经 summaryEntryOf(与增量流同一过滤器)过滤出
   * 重要摘要。每次调用独立配对 tool/call → tool/result(历史流顺序完整)。
   */
  async function getHistorySummary(
    sessionId: string,
    maxMessages: number | null,
  ): Promise<PetSummaryResult> {
    const connection = getConnection()
    if (!connection) return { ok: false, summary: 'connection not ready', sessionId: null, entries: [] }
    if (!sessionId) return { ok: false, summary: 'missing sessionId', sessionId: null, entries: [] }
    try {
      const response = await connection.api.sessions.history({
        sessionId: sessionId as SessionId,
        ...(maxMessages === null ? {} : { maxMessages }),
      })
      const result = response.result
      if (!result.ok) {
        return { ok: false, summary: `rpc error: ${JSON.stringify(result.error)}`, sessionId, entries: [] }
      }
      const toolNames = new Map<string, string>()
      const entries = result.value.events
        .map((entry) => summaryEntryOf(entry.event, toolNames))
        .filter((e): e is PetSummaryEntry => e !== null)
      return { ok: true, summary: `${entries.length} entries`, sessionId, entries }
    } catch (error) {
      return { ok: false, summary: String(error), sessionId, entries: [] }
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
      // 继承"目标"会话(显式目标优先,否则最近的非空会话):工作目录 / 模式(agent preset)/
      // 权限(preset)。目标缺失时回退 Host 默认(cwd 与默认 preset/默认模式)。
      const inherit = await resolveInheritTarget(connection)
      const createPayload: { cwd?: string; agentPreset?: string } = {}
      if (inherit.cwd !== undefined) createPayload.cwd = inherit.cwd
      if (inherit.agentPreset !== undefined) createPayload.agentPreset = inherit.agentPreset
      const response = await connection.api.sessions.create(createPayload)
      const result = response.result
      if (!result.ok) {
        return { ok: false, summary: `rpc error: ${JSON.stringify(result.error)}` }
      }
      const sessionId = String(result.value.sessionId)
      setTargetSessionId(sessionId)
      const bits: string[] = [`新建会话 ${sessionId.slice(0, 8)}`]
      if (inherit.cwd !== undefined) bits.push(`cwd=${inherit.cwd}`)
      if (inherit.agentPreset !== undefined) bits.push(`mode=${inherit.agentPreset}`)
      // 权限事实(permission/preset + sandbox/mode + approval/policy)不随 session.create
      // 传递,只能经 /permission 命令写入:对新建会话执行同一条命令,使其权限与目标一致。
      // 尽力而为 —— 命令服务未挂载/预设未知时只影响这一项,不阻塞会话创建。
      if (inherit.permissionPreset !== undefined && inherit.permissionPreset !== 'custom') {
        const applied = await connection.api.runCommand(sessionId, `/permission ${inherit.permissionPreset}`)
        bits.push(applied.ok
          ? `perm=${inherit.permissionPreset}`
          : `perm=${inherit.permissionPreset}(${applied.summary})`)
      }
      return { ok: true, summary: bits.join(' · '), sessionId }
    } catch (error) {
      return { ok: false, summary: String(error) }
    }
  }

  /**
   * 解析"目标"会话要继承的字段:显式目标优先,否则最近的非空会话(与主进程
   * resolveTargetSession 一致)。返回该会话的 cwd / agentPreset / 权限预设。
   */
  async function resolveInheritTarget(connection: ConnectionHandle): Promise<{
    cwd?: string
    agentPreset?: string
    permissionPreset?: string
  }> {
    const listResponse = await connection.api.sessions.list({})
    const list = listResponse.result
    if (!list.ok) return {}
    const items = list.value.items
    const targetId = getTargetSessionId()
    const chosen = targetId ? items.find((item) => String(item.sessionId) === targetId) : undefined
    const target = chosen ?? items.find((item) => !item.blank)
    if (target === undefined) return {}
    const permission = permissionPresetOf(target)
    return {
      ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
      ...(target.agentPreset === undefined ? {} : { agentPreset: target.agentPreset }),
      ...(permission === undefined ? {} : { permissionPreset: permission }),
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

  async function respondQuestion(request: PetQuestionRequest): Promise<PetOpResult> {
    const connection = getConnection()
    if (!connection) return { label: 'question.respond', ok: false, summary: 'connection not ready' }
    if (!Array.isArray(request.answers) || request.answers.length === 0) {
      return { label: 'question.respond', ok: false, summary: 'invalid answers' }
    }
    try {
      // QuestionResponsePayload 的品牌字段是编译期标记;此处从 renderer 扁平对象回填,
      // 协议形状由 QuestionResponsePayload 承担,wire 校验在 /api/respond 端。
      const value = {
        sessionId: String(request.sessionId),
        answer: {
          answers: request.answers.map((a) => ({
            id: String(a.id),
            selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
            ...(a.custom === undefined || a.custom === '' ? {} : { custom: String(a.custom) }),
          })),
        },
      } as unknown as QuestionResponsePayload
      const message: ClientResponse = {
        type: 'client-response',
        rpcId: RpcId(String(request.rpcId)),
        result: { ok: true, value },
      }
      const receipt = await connection.api.respond(message)
      if (!receipt.accepted) {
        return { label: 'question.respond', ok: false, summary: `not accepted: ${receipt.reason}` }
      }
      return { label: 'question.respond', ok: true, summary: `answered → ${request.answers.length} question(s)` }
    } catch (error) {
      return { label: 'question.respond', ok: false, summary: String(error) }
    }
  }

  async function stopTurn(): Promise<PetOpResult> {
    const connection = getConnection()
    if (!connection) return { label: 'session.cancel', ok: false, summary: 'connection not ready' }
    try {
      const sessionId = await resolveTargetSession()
      if (!sessionId) return { label: 'session.cancel', ok: false, summary: 'no target session' }
      const response = await connection.api.sessions.cancel({ sessionId })
      const result = response.result
      if (!result.ok) {
        return { label: 'session.cancel', ok: false, summary: `rpc error: ${JSON.stringify(result.error)}` }
      }
      return { label: 'session.cancel', ok: true, summary: `stop → ${sessionId}` }
    } catch (error) {
      return { label: 'session.cancel', ok: false, summary: String(error) }
    }
  }

  return { listSessions, getHistory, getHistorySummary, selectSession, createSession, respondApproval, respondQuestion, stopTurn }
}

/** 会话标题:list 行的 projections.values.title(投影缓存;无则 null)。 */
function sessionTitle(item: { projections?: { values?: Record<string, unknown> } }): string | null {
  const title = item.projections?.values?.['title']
  return typeof title === 'string' && title.length > 0 ? title : null
}

/**
 * 会话权限预设:list 行的 `projections.values.permissions.currentValue`
 * (permission-presets 投影的 select 值,如 danger-full-access=Full access)。
 * 部署未挂载投影/权限服务时该 key 缺席,返回 undefined。
 */
function permissionPresetOf(item: { projections?: { values?: Record<string, unknown> } }): string | undefined {
  const permissions = item.projections?.values?.['permissions']
  if (permissions === null || typeof permissions !== 'object') return undefined
  const current = (permissions as { currentValue?: unknown }).currentValue
  return typeof current === 'string' && current.length > 0 ? current : undefined
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
