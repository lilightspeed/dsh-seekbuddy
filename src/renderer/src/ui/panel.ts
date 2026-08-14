import type { PetApi, PetHistoryEntry, PetSessionSummary } from '../../../shared/pet-event.ts'
import type { PendingApproval } from './approvals.ts'

export interface PanelHooks {
  /** 审批中心(面板审批 tab 与浮动卡共用)。 */
  approvals: {
    list(): PendingApproval[]
    subscribe(listener: (list: PendingApproval[]) => void): () => void
    respond(item: PendingApproval, outcome: 'allowed-once' | 'rejected'): Promise<void>
  }
  onFlash(text: string, ok: boolean): void
}

/** 相对时间("刚刚 / 5 分钟前 / 2 小时前 / 8月15日")。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 短标题:优先 projections 标题;空/blank 会话给占位。 */
function shortTitle(session: PetSessionSummary): string {
  if (session.title) return session.title
  if (session.blank) return '(空会话)'
  return `会话 ${session.sessionId.slice(0, 8)}`
}

/**
 * 会话面板:会话列表(切换目标)+ 历史查看 + 审批 tab。
 * vanilla DOM(React/Zustand 待复杂 UI 再引入)。
 */
export function createPanel(api: PetApi, hooks: PanelHooks) {
  const panelEl = document.querySelector<HTMLDivElement>('#panel')
  const btnEl = document.querySelector<HTMLButtonElement>('#btn-panel')
  const sessionsEl = document.querySelector<HTMLDivElement>('#tab-sessions')
  const historyEl = document.querySelector<HTMLDivElement>('#tab-history')
  const approvalsEl = document.querySelector<HTMLDivElement>('#tab-approvals')
  const badgeEl = document.querySelector<HTMLSpanElement>('#approval-badge')

  let targetSessionId: string | null = null
  /** 历史查看的会话 + 已加载锚点。 */
  let historySessionId: string | null = null
  let historyBeforeSeq: number | null = null
  let historyHasMore = false
  let historyLoading = false

  function switchTab(name: 'sessions' | 'history' | 'approvals'): void {
    document.querySelectorAll<HTMLButtonElement>('#panel .panel-tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset['tab'] === name)
    })
    sessionsEl?.classList.toggle('active', name === 'sessions')
    historyEl?.classList.toggle('active', name === 'history')
    approvalsEl?.classList.toggle('active', name === 'approvals')
    if (name === 'history') void refreshHistory()
    if (name === 'approvals') renderApprovals()
  }

  function toggle(): void {
    if (!panelEl) return
    const show = panelEl.classList.contains('hidden')
    panelEl.classList.toggle('hidden', !show)
    if (show) {
      void refreshSessions()
      renderApprovals()
    }
  }

  async function refreshSessions(): Promise<void> {
    const result = await api.listSessions()
    if (!result.ok) {
      hooks.onFlash(`✗ 会话列表:${result.summary}`, false)
      return
    }
    targetSessionId = result.targetSessionId
    renderSessions(result.items)
    // 会话列表刷新后,历史锚点失效,重置为尾部
    historySessionId = null
    historyBeforeSeq = null
    if (!historyEl?.classList.contains('active')) return
    const current = result.items.find((item) => item.sessionId === targetSessionId)
    if (current) historySessionId = current.sessionId
    void refreshHistory()
  }

  function renderSessions(items: PetSessionSummary[]): void {
    if (!sessionsEl) return
    sessionsEl.textContent = ''
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'session-row'
      if (item.sessionId === targetSessionId) row.classList.add('selected')
      const dot = document.createElement('span')
      dot.className = `dot${item.running ? ' running' : ''}`
      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = shortTitle(item)
      title.title = item.sessionId
      const time = document.createElement('span')
      time.className = 'time'
      time.textContent = relativeTime(item.updatedAt)
      row.append(dot, title, time)
      row.addEventListener('click', () => void selectSession(item.sessionId))
      sessionsEl.appendChild(row)
    }
    const createBtn = document.createElement('button')
    createBtn.className = 'panel-btn'
    createBtn.textContent = '＋ 新建会话'
    createBtn.addEventListener('click', () => void createSession())
    sessionsEl.appendChild(createBtn)
  }

  async function selectSession(sessionId: string): Promise<void> {
    const result = await api.selectSession(sessionId)
    if (!result.ok) {
      hooks.onFlash(`✗ 切换会话:${result.summary}`, false)
      return
    }
    targetSessionId = sessionId
    historySessionId = sessionId
    historyBeforeSeq = null
    // 高亮当前选择
    sessionsEl?.querySelectorAll('.session-row').forEach((row) => {
      row.classList.toggle('selected', row.querySelector('.title')?.getAttribute('title') === sessionId)
    })
    switchTab('history')
  }

  async function createSession(): Promise<void> {
    const result = await api.createSession()
    if (!result.ok || !result.sessionId) {
      hooks.onFlash(`✗ 新建会话:${result.summary}`, false)
      return
    }
    hooks.onFlash(`✅ 新建会话 ${result.sessionId.slice(0, 8)}`, true)
    await refreshSessions()
  }

  /** 加载历史(首次 = 尾部页;afterOldest = 向上翻页)。 */
  async function refreshHistory(afterOldest = false): Promise<void> {
    if (!historyEl || !historySessionId || historyLoading) return
    historyLoading = true
    try {
      const beforeSeq = afterOldest ? historyBeforeSeq : null
      const result = await api.getHistory(historySessionId, beforeSeq ?? undefined, 40)
      if (!result.ok) {
        hooks.onFlash(`✗ 历史:${result.summary}`, false)
        return
      }
      historyHasMore = result.hasMore
      // 向上翻页:新条目插到顶部(seq 必然更小);首次加载整页替换
      renderHistoryInto(result.entries, afterOldest)
      historyBeforeSeq = result.entries[0]?.seq ?? null
    } finally {
      historyLoading = false
    }
  }

  function renderHistoryInto(entries: PetHistoryEntry[], prepend: boolean): void {
    if (!historyEl) return
    const frag = document.createDocumentFragment()
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = `history-row ${entry.kind}`
      row.dataset['seq'] = String(entry.seq)
      const time = document.createElement('span')
      time.className = 'time'
      time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const text = document.createElement('div')
      text.textContent = entry.text
      row.append(time, text)
      frag.appendChild(row)
    }
    if (prepend) {
      // 插到"加载更早"按钮之后(按钮保持置顶)
      const olderBtn = historyEl.querySelector('.panel-btn')
      if (olderBtn) {
        olderBtn.after(frag)
      } else {
        historyEl.prepend(frag)
      }
    } else {
      historyEl.textContent = ''
      if (historyHasMore) {
        const olderBtn = document.createElement('button')
        olderBtn.className = 'panel-btn'
        olderBtn.textContent = '↑ 加载更早'
        olderBtn.addEventListener('click', () => void refreshHistory(true))
        historyEl.appendChild(olderBtn)
      }
      historyEl.appendChild(frag)
    }
  }

  function renderApprovals(): void {
    if (!approvalsEl) return
    approvalsEl.textContent = ''
    const list = hooks.approvals.list()
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-row meta'
      empty.textContent = '暂无待审批'
      approvalsEl.appendChild(empty)
      return
    }
    for (const item of list) {
      const card = document.createElement('div')
      card.className = 'history-row tool'
      card.textContent = `🔐 ${item.toolName}${item.reason ? ` — ${item.reason}` : ''}`
      const actions = document.createElement('div')
      actions.className = 'approval-actions'
      const allowBtn = document.createElement('button')
      allowBtn.className = 'approval-allow-btn'
      allowBtn.textContent = '允许'
      allowBtn.addEventListener('click', () => void hooks.approvals.respond(item, 'allowed-once'))
      const rejectBtn = document.createElement('button')
      rejectBtn.className = 'approval-reject-btn'
      rejectBtn.textContent = '拒绝'
      rejectBtn.addEventListener('click', () => void hooks.approvals.respond(item, 'rejected'))
      actions.append(allowBtn, rejectBtn)
      card.appendChild(actions)
      approvalsEl.appendChild(card)
    }
  }

  // 审批角标
  hooks.approvals.subscribe((list) => {
    if (!badgeEl) return
    badgeEl.textContent = String(list.length)
    badgeEl.classList.toggle('hidden', list.length === 0)
    if (approvalsEl?.classList.contains('active')) renderApprovals()
  })

  btnEl?.addEventListener('click', toggle)
  document.querySelectorAll<HTMLButtonElement>('#panel .panel-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset['tab'] as 'sessions' | 'history' | 'approvals'))
  })

  return { toggle, refreshSessions }
}
