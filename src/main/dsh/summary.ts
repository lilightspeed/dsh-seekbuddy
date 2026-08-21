import type { SessionEvent } from '@deepseek-ai/dsh-client-connection/client'
import type { PetSummaryEntry } from '../../shared/pet-event.ts'

/**
 * 最近对话浮层的重要性过滤(单一职责:增量流与历史基线共用同一规则)。
 *
 * 仅保留:用户消息 / 助手**最终**文本回复(无 tool-call 块)。
 * 丢弃:thinking(reasoning)、工具调用过程、工具失败、回合异常、正常完成回合等
 * 一切助手/用户以外的系统消息。
 *
 * 只按 event.type 窄化,不依赖具体 data 深度(与仓库类型同源,禁止手写接口类型)。
 */

/** 剥离注入在文本里的系统标签(标签及其中内容整体移除),避免展示给宠物用户。 */
function stripSystemTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system-reminder\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** content 块里的可见文本(text 块拼接;reasoning/image/tool-call 忽略;系统标签剥离)。 */
function textOfBlocks(content: readonly { type: string }[]): string {
  return stripSystemTags(
    content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim(),
  )
}

/**
 * 把一条 SessionEvent 摊平成对话摘要;助手/用户以外的系统消息返回 null。
 * toolNames:tool/call 在此登记 callId → 工具名(供其它消费者引用)。
 */
export function summaryEntryOf(event: SessionEvent, toolNames: Map<string, string>): PetSummaryEntry | null {
  switch (event.type) {
    case 'user/message': {
      const text = textOfBlocks(event.data.content)
      if (!text) return null
      return { seq: event.seq, time: event.time, kind: 'user', text }
    }
    case 'assistant/message': {
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
