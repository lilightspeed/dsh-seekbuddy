import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PetPluginEntry, PetPluginListResult } from '../../shared/pet-event.ts'
import type { ConnectionHandle } from './connection.ts'

/**
 * B3(只读版)插件监控 ops。
 *
 * 背景(0013 侦察结论):DSH 的 /api 面没有 plugin.* 域,动态插件管理
 * (cordis_inspect_self/define/run/…) 是会话级 agent 工具,只能由模型在回合内
 * 调用。所以这里采用"agent 中介"只读方案:宠物给目标会话发一条严格的
 * 机器指令 → 会话 agent 调用 cordis_inspect_self() 并原样回吐 JSON →
 * 宠物轮询该会话历史,取回并解析。完整管理(define/run/stop)待 DSH 原生
 * plugin API(用户决定暂不深度改造 harness)。
 */

/** 发给目标会话的指令:只做一件事,只输出 JSON,不加任何装饰。 */
const LIST_PROMPT = [
  '这是一个无人工参与的机器调试调用,请只做一件事:',
  '1. 调用 cordis_inspect_self()(不带任何参数,列出当前会话所有动态插件)。',
  '2. 把工具返回的 JSON 整体原样输出(即 {"mode":"plugins","plugins":[...]} 那个对象)。',
  '要求:你的整条回复只包含这个 JSON,不要任何解释文字,不要 markdown 代码块标记(不要 ``` 或 ```json),不要遗漏字段。',
].join('\n')

/** 轮询参数:模型回合可能较慢,总超时 60s,间隔 1.5s。 */
const POLL_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_500

export interface PluginOpsDeps {
  getConnection: () => ConnectionHandle | undefined
  /** 解析目标会话(与发消息同一套逻辑,index.ts 注入)。 */
  getTargetSession: () => Promise<SessionId | null>
}

export interface PluginOps {
  /** 经 agent 中介读取目标会话的插件清单(只读)。 */
  listPlugins(): Promise<PetPluginListResult>
}

export function createPluginOps(deps: PluginOpsDeps): PluginOps {
  async function listPlugins(): Promise<PetPluginListResult> {
    const connection = deps.getConnection()
    if (!connection) return { ok: false, summary: 'connection not ready', refreshedAt: 0, plugins: [] }
    const sessionId = await deps.getTargetSession()
    if (!sessionId) return { ok: false, summary: 'no target session', refreshedAt: 0, plugins: [] }

    // 1. 记下当前尾部 seq(只认这条指令之后的新回复)
    const before = await tailSeq(connection, sessionId)

    // 2. 发指令(mode queue 排队执行)
    const accepted = await connection.api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: LIST_PROMPT }],
    })
    if (!accepted.result.ok) {
      return { ok: false, summary: `prompt rejected: ${JSON.stringify(accepted.result.error)}`, refreshedAt: 0, plugins: [] }
    }

    // 3. 轮询历史,等一条 seq > before 的 assistant 回复
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let lastText = ''
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      const tail = await tailAssistantText(connection, sessionId, before)
      if (tail === null) continue // 还没有新回复
      lastText = tail
      const parsed = extractPluginJson(tail)
      if (parsed !== null) {
        return { ok: true, summary: `${parsed.plugins.length} plugins`, refreshedAt: Date.now(), plugins: parsed.plugins }
      }
      // 有新回复但解析失败:多半是 agent 没按格式来,直接报错(不继续等)
      return { ok: false, summary: 'agent 回复不是可解析的插件 JSON', refreshedAt: 0, plugins: [], rawReply: tail.slice(0, 500) }
    }
    return {
      ok: false,
      summary: `插件查询超时(${POLL_TIMEOUT_MS / 1000}s):模型回合未完成`,
      refreshedAt: 0,
      plugins: [],
      ...(lastText === '' ? {} : { rawReply: lastText.slice(0, 500) }),
    }
  }

  return { listPlugins }
}

/** 会话历史尾部最后一个事件的 seq(空会话返回 null)。 */
async function tailSeq(connection: ConnectionHandle, sessionId: SessionId): Promise<number | null> {
  try {
    const response = await connection.api.sessions.history({ sessionId, maxMessages: 1 })
    const result = response.result
    if (!result.ok) return null
    const last = result.value.events.at(-1)
    return last === undefined ? null : last.event.seq
  } catch {
    return null
  }
}

/**
 * 读会话尾部,返回"seq > before 的最后一条 assistant/message"的文本;
 * 还没有新回复时返回 null。
 */
async function tailAssistantText(
  connection: ConnectionHandle,
  sessionId: SessionId,
  before: number | null,
): Promise<string | null> {
  try {
    const response = await connection.api.sessions.history({ sessionId, maxMessages: 40 })
    const result = response.result
    if (!result.ok) return null
    let found: string | null = null
    for (const entry of result.value.events) {
      const event = entry.event
      if (before !== null && event.seq <= before) continue
      if (event.type !== 'assistant/message') continue
      const text = event.data.message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
      if (text.trim() !== '') found = text
    }
    return found
  } catch {
    return null
  }
}

/** 从 agent 回复里抠出 {…} 或 […] 的 JSON(容忍 markdown 围栏与前后杂文)。 */
function extractPluginJson(text: string): { plugins: PetPluginEntry[] } | null {
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const startCandidates = ['{', '['].map((c) => cleaned.indexOf(c)).filter((i) => i !== -1)
  if (startCandidates.length === 0) return null
  const start = Math.min(...startCandidates)
  const open = cleaned[start]
  const close = open === '{' ? '}' : ']'
  const end = cleaned.lastIndexOf(close)
  if (end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const root = raw as { plugins?: unknown }
  if (!Array.isArray(root.plugins)) return null
  const plugins: PetPluginEntry[] = root.plugins
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
    .map((p) => flattenEntry(p))
  return { plugins }
}

/** 把 agent 回吐的插件摘要摊平成扁平展示类型(字段缺省容错)。 */
function flattenEntry(p: Record<string, unknown>): PetPluginEntry {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const active = p['activeRun'] as Record<string, unknown> | undefined
  const pending = p['pendingApproval'] as Record<string, unknown> | undefined
  return {
    pluginId: str(p['pluginId']) ?? 'unknown',
    name: str(p['name']) ?? '',
    state: str(p['state']) ?? 'unknown',
    packageCount: num(p['packageCount']),
    currentPackageId: str(p['currentPackageId']),
    nextPackageId: str(p['nextPackageId']),
    activeRun: active && typeof active === 'object' && active !== null
      ? { pluginRunId: str(active['pluginRunId']) ?? '', packageId: str(active['packageId']) ?? '' }
      : null,
    pendingApproval: pending && typeof pending === 'object' && pending !== null
      ? { pluginRunId: str(pending['pluginRunId']) ?? '', packageId: str(pending['packageId']) ?? '', mode: str(pending['mode']) ?? '' }
      : null,
    raw: JSON.stringify(p),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
