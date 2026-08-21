import type { PetApi, PetEvent, PetOpResult, PetQuestionItem } from '../../../shared/pet-event.ts'

/** renderer 侧待回答提问条目(来自 question:pending 事件;一次 ask 可含多个问题)。 */
export interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: PetQuestionItem[]
}

/** 回答收集器:从提问卡 DOM 汇总出的一次回答(selected = 选项 label 数组)。 */
export interface QuestionAnswers {
  answers: { id: string; selected: string[]; custom?: string }[]
}

export interface QuestionHooks {
  /** 气泡提示(ok 绿 / 失败红)。 */
  onFlash(text: string, ok: boolean): void
  /** 待回答数量变化(浮动卡角标等)。 */
  onCountChange(count: number): void
}

/**
 * 0060 提问中心:维护 pending 表(与审批中心同构)。
 * 回包走 api.respondQuestion(echo rpcId);失败不弹系统通知,气泡提示即可。
 */
export function createQuestionCenter(api: PetApi, hooks: QuestionHooks) {
  const pending = new Map<string, PendingQuestion>() // key: rpcId
  const listeners = new Set<(list: PendingQuestion[]) => void>()

  function emit(): void {
    const list = [...pending.values()]
    hooks.onCountChange(list.length)
    for (const listener of listeners) listener(list)
  }

  function add(ev: Extract<PetEvent, { type: 'question:pending' }>): void {
    pending.set(ev.rpcId, { rpcId: ev.rpcId, sessionId: ev.sessionId, questions: ev.questions })
    emit()
  }

  function removeByRpcId(rpcId: string): void {
    pending.delete(rpcId)
    emit()
  }

  async function respond(item: PendingQuestion, answers: QuestionAnswers['answers']): Promise<void> {
    const result: PetOpResult = await api.respondQuestion({ rpcId: item.rpcId, sessionId: item.sessionId, answers })
    if (result.ok) {
      removeByRpcId(item.rpcId)
      hooks.onFlash('✅ 已回答', true)
    } else {
      hooks.onFlash(`✗ 提问回包失败:${result.summary}`, false)
    }
  }

  return {
    add,
    removeByRpcId,
    respond,
    list: (): PendingQuestion[] => [...pending.values()],
    subscribe(listener: (list: PendingQuestion[]) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
