import { join } from 'node:path'
import { nativeImage, Notification, type NativeImage, type NotificationConstructorOptions } from 'electron'

/** 应用图标缓存(通知图标;与托盘同一素材,win32 用 ico 含多尺寸帧;非 win32 解析失败则通知不带图标)。 */
let cachedIcon: NativeImage | undefined
function appIcon(): NativeImage | undefined {
  if (cachedIcon) return cachedIcon
  try {
    cachedIcon = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/pet/icons/ymcog-jpmci-001.ico'))
    return cachedIcon.isEmpty() ? undefined : cachedIcon
  } catch {
    return undefined
  }
}

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
      const opts: NotificationConstructorOptions = { title, body }
      const icon = appIcon()
      if (icon) opts.icon = icon
      new Notification(opts).show()
    } catch (error) {
      console.error('[pet] notification failed:', error)
    }
  }

  function onEvent(event: {
    type: string
    sessionId?: string | null
    message?: string
    toolName?: string
    reason?: string | null
    title?: string
    body?: string
    /** 0060:提问条目(question:pending 用,取首个问题文本做通知正文)。 */
    questions?: { question?: string }[]
  }): void {
    switch (event.type) {
      case 'approval:pending':
        notify('🔐 DSH 需要审批', `${event.toolName ?? '工具'}${event.reason ? ` — ${event.reason}` : ''}`)
        break
      case 'question:pending': {
        // 0060:提问需要用户动作(同审批,总是通知;窗口隐藏时用户也要被叫回来回答)
        const first = event.questions?.[0]?.question ?? ''
        const count = event.questions?.length ?? 1
        notify('❓ DSH 向你提问', count > 1 ? `${first}(共 ${count} 题)` : first)
        break
      }
      case 'agent:error':
        notify('⚠ DSH 报错', event.message ?? 'agent 执行失败')
        break
      case 'pet:notify':
        notify(event.title ?? '🔔 SeekBuddy', event.body ?? '')
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
