import { Notification } from 'electron'

/**
 * 系统通知(阶段 3):DSH 事件 → 桌面通知。
 * 策略(可调):
 * - 审批/报错:总是通知(需要用户动作或很少见)。
 * - 回合完成:仅当宠物窗口隐藏(用户走开了)且属于目标会话时通知,避免常驻窗口下刷屏。
 */
export function createNotifier(options: {
  isWindowVisible: () => boolean
  isTargetSession: (sessionId: string | null) => boolean
}): {
  notify(title: string, body: string): void
  onEvent(event: { type: string; sessionId?: string | null; message?: string; toolName?: string; reason?: string | null }): void
} {
  function notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    try {
      new Notification({ title, body }).show()
    } catch (error) {
      console.error('[pet] notification failed:', error)
    }
  }

  function onEvent(event: { type: string; sessionId?: string | null; message?: string; toolName?: string; reason?: string | null; title?: string; body?: string }): void {
    switch (event.type) {
      case 'approval:pending':
        notify('🔐 DSH 需要审批', `${event.toolName ?? '工具'}${event.reason ? ` — ${event.reason}` : ''}`)
        break
      case 'agent:error':
        notify('⚠ DSH 报错', event.message ?? 'agent 执行失败')
        break
      case 'pet:notify':
        notify(event.title ?? '🔔 DSH Pet', event.body ?? '')
        break
      case 'dsh:turn-end': {
        const bad = event.reason === 'error' || event.reason === 'max-tokens' || event.reason === 'blocked'
        if (bad) {
          notify('⚠ DSH 回合异常', `reason: ${event.reason}`)
        } else if (event.reason === 'completed' && !options.isWindowVisible() && options.isTargetSession(event.sessionId ?? null)) {
          notify('✅ DSH 完成', '目标会话回合结束')
        }
        break
      }
      default:
        break
    }
  }

  return { notify, onEvent }
}
