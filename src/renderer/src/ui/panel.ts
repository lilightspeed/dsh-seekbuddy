import type { PetActivityEntry, PetApi, PetHistoryEntry, PetPluginEntry, PetPluginListResult, PetSessionSummary } from '../../../shared/pet-event.ts'
import type { PendingApproval } from './approvals.ts'

export interface PanelHooks {
  /** 审批中心(面板审批 tab 与浮动卡共用)。 */
  approvals: {
    list(): PendingApproval[]
    subscribe(listener: (list: PendingApproval[]) => void): () => void
    respond(item: PendingApproval, outcome: 'allowed-once' | 'rejected'): Promise<void>
  }
  /** B2 雷达:会话活动表(主进程事件增量累积)。 */
  activity: {
    list(): PetActivityEntry[]
    subscribe(listener: (list: PetActivityEntry[]) => void): () => void
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
 * 会话面板:会话列表(切换目标)+ 雷达 + 历史 + 审批 + 设置 tab。
 * vanilla DOM(React/Zustand 待复杂 UI 再引入)。
 */
export function createPanel(api: PetApi, hooks: PanelHooks) {
  const panelEl = document.querySelector<HTMLDivElement>('#panel')
  const btnEl = document.querySelector<HTMLButtonElement>('#btn-panel')
  const sessionsEl = document.querySelector<HTMLDivElement>('#tab-sessions')
  const historyEl = document.querySelector<HTMLDivElement>('#tab-history')
  const approvalsEl = document.querySelector<HTMLDivElement>('#tab-approvals')
  const pluginsEl = document.querySelector<HTMLDivElement>('#tab-plugins')
  const settingsEl = document.querySelector<HTMLDivElement>('#tab-settings')
  const badgeEl = document.querySelector<HTMLSpanElement>('#approval-badge')
  /** 会话页运行中角标(B2 雷达并入会话页)。 */
  const runningBadgeEl = document.querySelector<HTMLSpanElement>('#session-running-badge')

  let targetSessionId: string | null = null
  /** 最近一次会话列表(雷达行基线:标题/running/updatedAt)。 */
  let sessionItems: PetSessionSummary[] = []
  /** B3 插件监控:最近一次查询结果与状态文案。 */
  let lastPluginResult: PetPluginListResult | null = null
  let lastPluginSummary = '未刷新'
  let pluginLoading = false
  /** 历史查看的会话 + 已加载锚点。 */
  let historySessionId: string | null = null
  let historySessionTitle: string | null = null
  let historyBeforeSeq: number | null = null
  let historyHasMore = false
  let historyLoading = false

  function switchTab(name: 'sessions' | 'history' | 'approvals' | 'plugins' | 'settings'): void {
    document.querySelectorAll<HTMLButtonElement>('#panel .panel-tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset['tab'] === name)
    })
    sessionsEl?.classList.toggle('active', name === 'sessions')
    historyEl?.classList.toggle('active', name === 'history')
    approvalsEl?.classList.toggle('active', name === 'approvals')
    pluginsEl?.classList.toggle('active', name === 'plugins')
    settingsEl?.classList.toggle('active', name === 'settings')
    if (name === 'history') {
      if (!historySessionId) {
        // 尚未选择会话:提示去会话页选一个
        if (historyEl) {
          historyEl.textContent = ''
          const hint = document.createElement('div')
          hint.className = 'history-row meta'
          hint.textContent = '← 请先在「会话」页选择一个会话查看历史'
          historyEl.appendChild(hint)
        }
      } else {
        void refreshHistory()
      }
    }
    if (name === 'approvals') renderApprovals()
    if (name === 'plugins') renderPlugins()
    if (name === 'settings') void refreshSettings()
  }

  function toggle(): void {
    if (!panelEl) return
    const show = panelEl.classList.contains('hidden')
    panelEl.classList.toggle('hidden', !show)
    if (show) {
      void refreshSessions()
      renderApprovals()
      if (settingsEl?.classList.contains('active')) void refreshSettings()
    }
  }

  async function refreshSessions(): Promise<PetSessionSummary[] | null> {
    const result = await api.listSessions()
    if (!result.ok) {
      hooks.onFlash(`✗ 会话列表:${result.summary}`, false)
      return null
    }
    targetSessionId = result.targetSessionId
    sessionItems = result.items
    renderSessions(result.items)
    updateRunningBadge()
    // 会话列表刷新后,历史锚点失效,重置为尾部
    historySessionId = null
    historyBeforeSeq = null
    if (!historyEl?.classList.contains('active')) return result.items
    const current = result.items.find((item) => item.sessionId === targetSessionId)
    if (current) {
      historySessionId = current.sessionId
      historySessionTitle = current.title
    }
    void refreshHistory()
    return result.items
  }

  /**
   * 目标会话解析:显式目标优先;未选时回退"最近更新的非空会话"(与主进程
   * ensureTargetSession 一致)。返回 { id, title, isExplicit }。
   */
  function resolveTarget(items: PetSessionSummary[]): { id: string; title: string; isExplicit: boolean } | null {
    const explicit = targetSessionId ? items.find((item) => item.sessionId === targetSessionId) : undefined
    if (explicit) return { id: explicit.sessionId, title: shortTitle(explicit), isExplicit: true }
    const fallback = items.find((item) => !item.blank)
    if (fallback) return { id: fallback.sessionId, title: shortTitle(fallback), isExplicit: false }
    return null
  }

  /** 清除显式目标 → 回退自动(最近会话),并刷新列表/横幅。 */
  async function clearTarget(): Promise<void> {
    const result = await api.selectSession(null)
    if (!result.ok) {
      hooks.onFlash(`✗ 清除目标:${result.summary}`, false)
      return
    }
    targetSessionId = null
    hooks.onFlash('📤 已回退自动发送目标', true)
    await refreshSessions()
  }

  /** 会话页:顶部"发送目标"横幅(明确指出发消息落点)+ 会话列表(含实时状态)。 */
  function renderSessions(items: PetSessionSummary[]): void {
    if (!sessionsEl) return
    sessionsEl.textContent = ''
    const target = resolveTarget(items)
    // B2 实时状态:活动表(回合增量)叠加在列表基线上
    const activity = new Map(hooks.activity.list().map((e) => [e.sessionId, e]))

    // 顶部横幅:说明当前发消息会到哪个会话
    const banner = document.createElement('div')
    banner.className = 'target-banner'
    const label = document.createElement('span')
    label.className = 'target-label'
    label.textContent = target ? (target.isExplicit ? '📤 发送到' : '📤 自动发送到') : '📤 发送目标'
    const name = document.createElement('span')
    name.className = 'target-name'
    name.textContent = target ? target.title : '（无可用会话，发送时将新建）'
    name.title = target?.id ?? ''
    banner.append(label, name)
    if (target && target.isExplicit) {
      const clearBtn = document.createElement('button')
      clearBtn.className = 'target-clear'
      clearBtn.textContent = '取消选择'
      clearBtn.title = '回退为自动选择最近会话'
      clearBtn.addEventListener('click', () => void clearTarget())
      banner.appendChild(clearBtn)
    }
    sessionsEl.appendChild(banner)

    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'session-row'
      if (item.sessionId === target?.id) row.classList.add('selected')
      const dot = document.createElement('span')
      // 实时状态(活动表)与列表基线取并集:任一 running 即脉冲绿点
      const act = activity.get(item.sessionId)
      const isRunning = item.running || act?.running === true
      dot.className = `dot${isRunning ? ' running' : ''}`
      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = shortTitle(item)
      title.title = item.sessionId
      // 状态列:运行中 > 最近回合结果(带时间)> 基线更新时间
      const status = document.createElement('span')
      status.className = 'session-status'
      if (isRunning) {
        status.textContent = '● 运行中'
        status.classList.add('running')
      } else if (act?.reason) {
        status.textContent = `${reasonText(act.reason)} · ${relativeTime(act.time)}`
      } else {
        status.textContent = relativeTime(item.updatedAt)
      }
      row.append(dot, title, status)
      if (item.sessionId === target?.id) {
        const tag = document.createElement('span')
        tag.className = 'target-tag'
        tag.textContent = '目标'
        row.appendChild(tag)
      }
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
    // 只把该会话设为目标,停留在会话页(横幅/徽标由 refreshSessions 同步更新);
    // 历史锚点也预置,之后用户主动切到"历史"tab 时直接看该会话。
    const items = await refreshSessions()
    historySessionId = sessionId
    historyBeforeSeq = null
    historySessionTitle = items?.find((item) => item.sessionId === sessionId)?.title ?? null
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
      // 标题:当前查看的会话
      if (historySessionTitle) {
        const title = document.createElement('div')
        title.className = 'history-title'
        title.textContent = `💬 ${historySessionTitle}`
        historyEl.appendChild(title)
      }
      if (entries.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'history-row meta'
        empty.textContent = '（无历史消息）'
        historyEl.appendChild(empty)
      } else if (historyHasMore) {
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

  // ---- 设置 tab(阶段 5:DSH 地址 / 外观 / 自启 / 语音开关)----
  const urlInput = document.querySelector<HTMLInputElement>('#set-dsh-url')
  const urlApplyBtn = document.querySelector<HTMLButtonElement>('#set-dsh-apply')
  const opacitySlider = document.querySelector<HTMLInputElement>('#set-opacity')
  const opacityVal = document.querySelector<HTMLSpanElement>('#set-opacity-val')
  const scaleSlider = document.querySelector<HTMLInputElement>('#set-scale')
  const scaleVal = document.querySelector<HTMLSpanElement>('#set-scale-val')
  const autostartCheck = document.querySelector<HTMLInputElement>('#set-autostart')
  const voiceCheck = document.querySelector<HTMLInputElement>('#set-voice')

  /** 从主进程拉最新配置并回填控件(输入框正在编辑时跳过,避免打断输入)。 */
  async function refreshSettings(): Promise<void> {
    if (!settingsEl) return
    let cfg: Awaited<ReturnType<PetApi['getConfig']>>
    try {
      cfg = await api.getConfig()
    } catch {
      return
    }
    // 输入框/滑块正在交互时不回填,避免打断用户输入
    if (urlInput && document.activeElement !== urlInput) urlInput.value = cfg.dsh.baseUrl
    if (opacitySlider && document.activeElement !== opacitySlider) opacitySlider.value = String(Math.round(cfg.appearance.opacity * 100))
    if (opacityVal) opacityVal.textContent = `${Math.round(cfg.appearance.opacity * 100)}%`
    if (scaleSlider && document.activeElement !== scaleSlider) scaleSlider.value = String(Math.round(cfg.appearance.scale * 100))
    if (scaleVal) scaleVal.textContent = `${Math.round(cfg.appearance.scale * 100)}%`
    if (autostartCheck) autostartCheck.checked = cfg.launchAtLogin
    if (voiceCheck) voiceCheck.checked = cfg.voice.enabled
  }

  // opacity 滑块:实时预览,拖动停顿 120ms 才落盘一次(透明度不改窗口尺寸,无反馈回路)
  let opacityTimer: ReturnType<typeof setTimeout> | undefined
  function debounceOpacity(value: number): void {
    if (opacityTimer) clearTimeout(opacityTimer)
    opacityTimer = setTimeout(() => {
      void api.setConfig({ opacity: value }).then((cfg) => {
        if (opacityVal) opacityVal.textContent = `${Math.round(cfg.appearance.opacity * 100)}%`
      })
    }, 120)
  }

  urlApplyBtn?.addEventListener('click', () => {
    const value = urlInput?.value.trim() ?? ''
    if (!value) return
    void api.setConfig({ dshBaseUrl: value }).then((cfg) => {
      hooks.onFlash(`✅ DSH 地址 → ${cfg.dsh.baseUrl}`, true)
      if (urlInput) urlInput.value = cfg.dsh.baseUrl
    })
  })
  opacitySlider?.addEventListener('input', () => {
    if (!opacitySlider) return
    if (opacityVal) opacityVal.textContent = `${opacitySlider.value}%`
    debounceOpacity(Number(opacitySlider.value) / 100)
  })
  // 缩放滑块:拖拽中**只更新数值标签**,松手(change)才应用。
  // 若拖拽中实时 setBounds,滑块元素宽度随窗口变化,Chromium 会把静止的指针
  // 位置按新宽度重算 value → 又触发 setConfig → 窗口再缩放 —— 来回跳 10% 的
  // 反馈回路(0010 修复)。松手应用后窗口尺寸不再在拖拽期间变化,回路被切断。
  scaleSlider?.addEventListener('input', () => {
    if (!scaleSlider) return
    if (scaleVal) scaleVal.textContent = `${scaleSlider.value}%`
  })
  scaleSlider?.addEventListener('change', () => {
    if (!scaleSlider) return
    void api.setConfig({ scale: Number(scaleSlider.value) / 100 }).then((cfg) => {
      const applied = Math.round(cfg.appearance.scale * 100)
      if (scaleVal) scaleVal.textContent = `${applied}%`
      // 回填实际生效值(与配置一致;理论上滑块范围 60–150 已含 clamp)
      if (scaleSlider) scaleSlider.value = String(applied)
    })
  })
  autostartCheck?.addEventListener('change', () => {
    if (!autostartCheck) return
    void api.setConfig({ launchAtLogin: autostartCheck.checked }).then((cfg) => {
      hooks.onFlash(cfg.launchAtLogin ? '🚀 已开启开机自启' : '已关闭开机自启', true)
    })
  })
  voiceCheck?.addEventListener('change', () => {
    if (!voiceCheck) return
    void api.setConfig({ voiceEnabled: voiceCheck.checked }).then((cfg) => {
      hooks.onFlash(cfg.voice.enabled ? '🔊 语音已开启(阶段 6 生效)' : '🔇 语音已关闭', true)
    })
  })

  // ---- B2 雷达 tab:全会话活动(运行中/完成/出错),点击设目标 ----

  /** turn reason → 展示文本。 */
  function reasonText(reason: string): string {
    switch (reason) {
      case 'completed':
        return '✓ 完成'
      case 'error':
        return '✗ 出错'
      case 'max-tokens':
        return '✗ 超长'
      case 'aborted':
        return '■ 中断'
      case 'blocked':
        return '⛔ 阻塞'
      default:
        return reason
    }
  }

  /** 运行中会话数 = 活动表 running ∪ 会话列表 running;驱动会话页角标。 */
  function runningCount(): number {
    const activityRunning = new Set(hooks.activity.list().filter((e) => e.running).map((e) => e.sessionId))
    for (const s of sessionItems) {
      if (s.running) activityRunning.add(s.sessionId)
    }
    return activityRunning.size
  }

  /** 会话 tab 角标:同时在跑的会话数。 */
  function updateRunningBadge(): void {
    if (!runningBadgeEl) return
    const n = runningCount()
    runningBadgeEl.textContent = String(n)
    runningBadgeEl.classList.toggle('hidden', n === 0)
  }

  // ---- B3 只读插件监控 tab:agent 中介读目标会话插件清单 ----

  /** 插件 id / packageId 过长时截断展示。 */
  function shortId(id: string): string {
    return id.length > 20 ? `${id.slice(0, 18)}…` : id
  }

  /** 一张插件卡:id + 状态 + 元信息 + 可折叠原始 JSON。 */
  function pluginCard(p: PetPluginEntry): HTMLElement {
    const card = document.createElement('div')
    card.className = 'plugin-card'
    const head = document.createElement('div')
    head.className = 'plugin-head'
    const id = document.createElement('span')
    id.className = 'plugin-id'
    id.textContent = p.pluginId
    const state = document.createElement('span')
    state.className = `plugin-state ${p.state}`
    state.textContent = p.state
    head.append(id, state)
    card.appendChild(head)
    if (p.name) {
      const name = document.createElement('div')
      name.className = 'plugin-name'
      name.textContent = p.name
      card.appendChild(name)
    }
    const meta = document.createElement('div')
    meta.className = 'plugin-meta'
    const bits: string[] = [`packages: ${p.packageCount}`]
    if (p.currentPackageId) bits.push(`current: ${shortId(p.currentPackageId)}`)
    if (p.nextPackageId) bits.push(`next: ${shortId(p.nextPackageId)}`)
    if (p.activeRun) bits.push(`run: ${shortId(p.activeRun.packageId)}`)
    if (p.pendingApproval) bits.push('⏳ 待审批')
    meta.textContent = bits.join(' · ')
    card.appendChild(meta)
    const raw = document.createElement('details')
    raw.className = 'plugin-raw'
    const summary = document.createElement('summary')
    summary.textContent = '原始 JSON'
    const pre = document.createElement('pre')
    pre.textContent = p.raw
    raw.append(summary, pre)
    card.appendChild(raw)
    return card
  }

  function renderPlugins(): void {
    if (!pluginsEl) return
    pluginsEl.textContent = ''
    const toolbar = document.createElement('div')
    toolbar.className = 'plugin-toolbar'
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'setting-apply'
    refreshBtn.textContent = '🔄 刷新'
    refreshBtn.disabled = pluginLoading
    refreshBtn.addEventListener('click', () => void refreshPlugins())
    const hint = document.createElement('span')
    hint.className = 'plugin-hint'
    hint.textContent = '只读监控 · 完整管理(define/run/stop)待 DSH 原生 API'
    toolbar.append(refreshBtn, hint)
    pluginsEl.appendChild(toolbar)

    if (pluginLoading) {
      const loading = document.createElement('div')
      loading.className = 'history-row meta'
      loading.textContent = '查询中…(占用一次模型回合,请稍候)'
      pluginsEl.appendChild(loading)
      return
    }
    const status = document.createElement('div')
    status.className = 'plugin-status'
    status.textContent = lastPluginSummary
    pluginsEl.appendChild(status)

    if (!lastPluginResult) return
    if (!lastPluginResult.ok) {
      const err = document.createElement('div')
      err.className = 'plugin-error'
      err.textContent = `✗ ${lastPluginResult.summary}`
      pluginsEl.appendChild(err)
      if (lastPluginResult.rawReply) {
        const raw = document.createElement('details')
        raw.className = 'plugin-raw'
        const summary = document.createElement('summary')
        summary.textContent = 'agent 原始回复'
        const pre = document.createElement('pre')
        pre.textContent = lastPluginResult.rawReply
        raw.append(summary, pre)
        pluginsEl.appendChild(raw)
      }
      return
    }
    if (lastPluginResult.plugins.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-row meta'
      empty.textContent = '（该会话暂无动态插件）'
      pluginsEl.appendChild(empty)
      return
    }
    for (const p of lastPluginResult.plugins) pluginsEl.appendChild(pluginCard(p))
  }

  async function refreshPlugins(): Promise<void> {
    if (pluginLoading) return
    pluginLoading = true
    lastPluginSummary = '查询中…'
    renderPlugins()
    try {
      const result = await api.listPlugins()
      lastPluginResult = result
      lastPluginSummary = result.ok
        ? `刷新于 ${new Date(result.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${result.summary}`
        : result.summary
    } catch (error) {
      lastPluginResult = { ok: false, summary: String(error), refreshedAt: 0, plugins: [] }
      lastPluginSummary = '查询失败'
    } finally {
      pluginLoading = false
      renderPlugins()
    }
  }

  // 活动增量(B2 雷达并入会话页):角标实时更新;会话页开着时整页重渲染(实时状态列)
  hooks.activity.subscribe(() => {
    updateRunningBadge()
    if (sessionsEl?.classList.contains('active') && sessionItems.length > 0) renderSessions(sessionItems)
  })

  // 审批角标
  hooks.approvals.subscribe((list) => {
    if (!badgeEl) return
    badgeEl.textContent = String(list.length)
    badgeEl.classList.toggle('hidden', list.length === 0)
    if (approvalsEl?.classList.contains('active')) renderApprovals()
  })

  btnEl?.addEventListener('click', toggle)
  document.querySelectorAll<HTMLButtonElement>('#panel .panel-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset['tab'] as 'sessions' | 'history' | 'approvals' | 'plugins' | 'settings'))
  })

  return { toggle, refreshSessions }
}
