// 临时脚本:打印 SessionEvent 类型结构与 tag 相关字段
import type { SessionEvent } from '@deepseek-ai/dsh-client-connection/client'

// 用条件类型抽出 tag/role 等字段
type ExtractTag<T> = T extends { tag?: infer V } ? V : never
type ExtractRole<T> = T extends { role?: infer V } ? V : never

// 打印事件 data 的所有可能字段(编译期探测,实际靠运行时日志)
type SessionEventTag = ExtractTag<SessionEvent>
type SessionEventRole = ExtractRole<SessionEvent>

// 强制报错以在编译器输出里看到完整类型
const _tag: SessionEventTag = null as any
const _role: SessionEventRole = null as any
void _tag; void _role
