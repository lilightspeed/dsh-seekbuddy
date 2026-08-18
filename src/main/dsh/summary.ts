import type { SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import type { PetSummaryEntry } from '../../shared/pet-event.ts'

/**
 * 主页常驻消息条的重要性过滤(单一职责:增量流与历史基线共用同一规则)。
 *
 * 保留:用户消息 / 助手**最终**文本回复(无 tool-call 块)/ 工具失败 / 回合异常。
 * 丢弃:thinking(reasoning)、工具调用过程、chunk/step/request/todo、正常完成回合。
 *
 * 只按 event.type 窄化,不依赖具体 data 深度(与仓库类型同源,禁止手写接口类型)。
 */

/** 折叠连续空白/换行 → 单空格,并截断到上限(带省略号)。 */
export function clampText(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** 回合结束 reason.kind → 摘要文本;正常完成(completed)不进消息条(气泡已提示)。 */
function turnEndText(kind: string): string | null {
  switch (kind) {
    case 'completed':
      return null
    case 'error':
      return '✗ 回合出错'
    case 'max-tokens':
      return '✗ 回合超长中断'
    case 'aborted':
      return '■ 回合已中断'
    case 'blocked':
      return '⛔ 回合被阻塞'
    case 'interrupted':
      return '■ 回合中断(重载)'
    default:
      return `■ 回合结束:${kind}`
  }
}

/** content 块里的可见文本(text 块拼接;reasoning/image/tool-call 忽略)。 */
function textOfBlocks(content: readonly { type: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 把一条 SessionEvent 摊平成"重要消息"摘要;噪音事件返回 null。
 * toolNames:tool/call 在此登记 callId → 工具名,供后续 tool/result 失败时引用
 * (增量流与历史流都保证 tool/call 先于其 tool/result 到达)。
 */
export function summaryEntryOf(event: SessionEvent, toolNames: Map<string, string>): PetSummaryEntry | null {
  switch (event.type) {
    case 'user/message': {
      const text = textOfBlocks(event.data.content)
      if (!text) return null
      return { seq: event.seq, time: event.time, kind: 'user', text: clampText(text) }
    }
    case 'assistant/message': {
      const content = event.data.message.content
      // 含 tool-call 块 = 中间过程(要调工具),不是最终回复;只保留最终文本回复。
      if (content.some((block) => block.type === 'tool-call')) return null
      const text = textOfBlocks(content)
      if (!text) return null
      return { seq: event.seq, time: event.time, kind: 'assistant', text: clampText(text) }
    }
    case 'tool/call':
      toolNames.set(String(event.data.callId), event.data.name)
      return null
    case 'tool/result': {
      const first = event.data.message.content[0]
      const isError = event.data.error !== undefined || first?.isError === true
      if (!isError) return null
      const name = toolNames.get(String(first?.toolCallId)) ?? 'tool'
      return { seq: event.seq, time: event.time, kind: 'meta', text: `✗ 工具失败:${name}` }
    }
    case 'turn/end': {
      const text = turnEndText(event.data.reason.kind)
      if (!text) return null
      return { seq: event.seq, time: event.time, kind: 'meta', text }
    }
    default:
      return null
  }
}
