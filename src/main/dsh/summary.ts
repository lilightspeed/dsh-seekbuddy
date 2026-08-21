import type { SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import type { PetSummaryEntry } from '../../shared/pet-event.ts'

/**
 * 最近对话浮层的重要性过滤(单一职责:增量流与历史基线共用同一规则)。
 *
 * 按 DSH 的 source.kind 标签区分对话角色(与 harness web 同一套规则):
 * - 保留:USER(user/message + source.kind 'user') / ASSISTANT(assistant/message + source.kind 'model')
 * - 丢弃:CONTEXT(source.kind 'plugin',如 <system-reminder>) / TOOL(tool/result) / 其它系统消息
 *
 * 只按 event.type + source.kind 窄化,不依赖具体 data 深度(与仓库类型同源,禁止手写接口类型)。
 */

/** content 块里的可见文本(text 块拼接;reasoning/image/tool-call 忽略)。 */
function textOfBlocks(content: readonly { type: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 把一条 SessionEvent 摊平成对话摘要;助手/用户以外的系统消息返回 null。
 * toolNames:tool/call 在此登记 callId → 工具名(供其它消费者引用)。
 */
export function summaryEntryOf(event: SessionEvent, toolNames: Map<string, string>): PetSummaryEntry | null {
  switch (event.type) {
    case 'user/message': {
      // 仅保留真实用户消息(source.kind 'user');丢弃插件注入的 CONTEXT(如 <system-reminder>,source.kind 'plugin')
      if (event.data.source.kind !== 'user') return null
      const text = textOfBlocks(event.data.content)
      if (!text) return null
      return { seq: event.seq, time: event.time, kind: 'user', text }
    }
    case 'assistant/message': {
      // 仅保留模型回复(source.kind 'model')
      if (event.data.message.source.kind !== 'model') return null
      const content = event.data.message.content
      // 含 tool-call 块 = 中间过程(要调工具),不是最终回复;只保留最终文本回复。
      if (content.some((block) => block.type === 'tool-call')) return null
      const text = textOfBlocks(content)
      if (!text) return null
      return { seq: event.seq, time: event.time, kind: 'assistant', text }
    }
    case 'tool/call':
      toolNames.set(String(event.data.callId), event.data.name)
      return null
    default:
      return null
  }
}
