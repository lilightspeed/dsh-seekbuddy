import type { PetApi } from '../../shared/pet-event.ts'
import { DEFAULT_PET_CONFIG, type PetPetSettings } from '../../shared/pet-config.ts'
import type { PetAnimator } from './pet/animator.ts'

/**
 * 0062 极简模式(仅显示宠物):
 * - 隐藏全部非宠物组件(CSS body.pet-only 统一处理,组件逻辑零改动);
 * - 窗口收缩到宠物包围盒大小,宠物屏幕位置/大小**始终不变**;
 * - 拖动范围收紧为宠物包围盒(独立 drag 层 #pet-drag-zone);
 * - 所有动作逻辑(状态机/动画/摸头/身体 sad/睡眠/拖动物理)保留。
 *
 * 窗口收缩的数学(按现有投影矩阵推导,见 cubism-runtime rebuildView):
 * 宠物屏幕尺寸 ∝ scale × 窗口高度,模型中心屏幕位置 = 窗口位置 + (px×宽, py×高)。
 * 因此每次窗口尺寸变化后,保持"模型中心屏幕点"与"屏幕尺寸"不变的重算为:
 *   scale' = scale × H旧 / H新
 *   px'    = (中心屏幕x - 新窗x) / 新窗宽   (py 同理)
 * 这些派生值只经 onPetSettingsApply 直接喂给动画器,不写 config.json(不持久化)。
 *
 * 窗口跟随:每 150ms 检查包围盒 —— 动画外延(思考气泡/Zzz/抬手)超出窗口立即放大;
 * 稳定回缩 1.5s 后才收缩(防抖动);用户拖动窗口期间(位置在两轮检查间变化)暂停,
 * 避免 setBounds 与原生拖动互相打架。
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口相对宠物包围盒的边距(px):呼吸空间 + 圆角余量。 */
const WINDOW_MARGIN = 16
/** 拖动区相对宠物包围盒的额外范围(px):略大于包围盒便于抓取。 */
const DRAG_PAD = 6
/** 包围盒检查间隔(ms)。 */
const CHECK_INTERVAL_MS = 150
/** 包围盒稳定回缩的判定时长(ms):动画外延消退后这么久才收缩窗口。 */
const SHRINK_DEBOUNCE_MS = 1500
/** 模型未就绪时进入模式的挂起重试间隔(ms)(启动恢复路径)。 */
const RETRY_INTERVAL_MS = 300
/** 窗口位置变化 ≥ 该值(px)视为用户正在拖动窗口(暂停包络调整)。 */
const DRAG_MOVE_EPS = 1

export interface PetOnlyModeOptions {
  /** 应用派生外观(不持久化):进入/跟随/退出时,基于基准设置覆盖 px/py/scale。 */
  onPetSettingsApply(settings: PetPetSettings): void
  /** 模式开关状态变化(驱动主页面按钮激活态)。 */
  onActiveChange?(active: boolean): void
}

export interface PetOnlyMode {
  isActive(): boolean
  enter(): void
  exit(): void
  /** 同步基准外观(配置加载 / 设置面板变更时调用;模式内派生值基于它)。 */
  updateBaseSettings(settings: PetPetSettings): void
  dispose(): void
}

export function createPetOnlyMode(
  api: PetApi | undefined,
  animator: PetAnimator,
  options: PetOnlyModeOptions,
): PetOnlyMode {
  let active = false
  /** 模型未就绪时挂起的进入请求(启动恢复路径,就绪后自动进入)。 */
  let pendingEnter = false
  /** 用户真实外观配置(派生值的基底;面板在极简模式下不可见,模式期间不变)。 */
  let baseSettings: PetPetSettings | null = null
  /** 当前生效的派生外观(进入时 = 基准,窗口变化时重算)。 */
  let current = { positionX: 0.5, positionY: 0.44, scale: 1 }
  /** 进入时的外观与窗口尺寸(退出恢复用:恢复尺寸、锚定宠物当前所在位置)。 */
  let entry: { appearance: PetPetSettings; windowSize: { width: number; height: number } } | null = null
  let checkTimer: ReturnType<typeof setInterval> | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  /** 上一轮检查的窗口位置(拖动检测用)。 */
  let lastWin: Rect | null = null
  /** 包围盒稳定回缩计时起点(ms;null = 未开始计时)。 */
  let shrinkSince: number | null = null
  const dragZoneEl = document.querySelector<HTMLDivElement>('#pet-drag-zone')

  /** 应用派生外观:合并进 current 并喂给动画器(不写配置,不持久化)。 */
  function applyDerived(partial: { positionX?: number; positionY?: number; scale?: number }): void {
    current = { ...current, ...partial }
    if (baseSettings) {
      options.onPetSettingsApply({
        ...baseSettings,
        positionX: current.positionX,
        positionY: current.positionY,
        scale: current.scale,
      })
    }
  }

  /** 切换激活态:挂/卸 body.pet-only(组件显隐由 CSS 统一处理)。 */
  function setActive(next: boolean): void {
    if (active === next) return
    active = next
    document.body.classList.toggle('pet-only', next)
    options.onActiveChange?.(next)
  }

  /** 目标窗口 = 宠物包围盒(屏幕) + 边距;夹取交给主进程 set-bounds。 */
  function computeTargetWindow(win: Rect, bounds: Rect): Rect {
    return {
      x: Math.round(win.x + bounds.x - WINDOW_MARGIN),
      y: Math.round(win.y + bounds.y - WINDOW_MARGIN),
      width: Math.round(bounds.width + WINDOW_MARGIN * 2),
      height: Math.round(bounds.height + WINDOW_MARGIN * 2),
    }
  }

  /**
   * setBounds 到目标窗口,并保持"模型中心屏幕点 + 屏幕尺寸"不变:
   * 用变更前的窗口与当前派生外观算出中心屏幕点,再按新窗口反推 px/py,
   * scale 按窗口高度比例缩放(屏幕尺寸 ∝ scale × H)。
   */
  async function applyWindow(target: Rect): Promise<boolean> {
    if (!api) return false
    const before = await api.getWindowBounds()
    if (!before) return false
    const applied = await api.setWindowBounds(target)
    if (!applied) return false
    // 夹取后未实际变化(如宠物小于 MIN 窗口)→ 无需重算外观
    if (
      Math.abs(applied.x - before.x) < 1 &&
      Math.abs(applied.y - before.y) < 1 &&
      Math.abs(applied.width - before.width) < 1 &&
      Math.abs(applied.height - before.height) < 1
    ) {
      return false
    }
    const centerX = before.x + current.positionX * before.width
    const centerY = before.y + current.positionY * before.height
    applyDerived({
      positionX: (centerX - applied.x) / applied.width,
      positionY: (centerY - applied.y) / applied.height,
      scale: (current.scale * before.height) / applied.height,
    })
    return true
  }

  /** 拖动区定位(宠物包围盒 + 小边距,窗口 CSS 坐标)。 */
  function updateDragZone(bounds: Rect): void {
    if (!dragZoneEl) return
    dragZoneEl.style.left = `${bounds.x - DRAG_PAD}px`
    dragZoneEl.style.top = `${bounds.y - DRAG_PAD}px`
    dragZoneEl.style.width = `${bounds.width + DRAG_PAD * 2}px`
    dragZoneEl.style.height = `${bounds.height + DRAG_PAD * 2}px`
  }

  async function check(): Promise<void> {
    if (!active || !animator.getDisplayBounds) return
    const raw = animator.getDisplayBounds()
    if (!raw) return
    const win = await api?.getWindowBounds()
    if (!win) return
    // 拖动检测:窗口位置在两轮检查间变化 → 用户正在拖,跳过本轮(0062:避免
    // setBounds 与原生拖动互相覆盖,窗口来回跳)
    if (lastWin && (Math.abs(win.x - lastWin.x) >= DRAG_MOVE_EPS || Math.abs(win.y - lastWin.y) >= DRAG_MOVE_EPS)) {
      lastWin = win
      return
    }
    lastWin = win
    updateDragZone(raw)
    const target = computeTargetWindow(win, raw)
    const needGrow = target.width > win.width + 1 || target.height > win.height + 1
    const needShrink = target.width < win.width - 1 || target.height < win.height - 1
    if (needGrow) {
      // 动画外延超出窗口 → 立即放大(锚点不变,宠物不动)
      shrinkSince = null
      await applyWindow(target)
    } else if (needShrink) {
      // 包围盒稳定小于窗口 → 计时后收缩(防动画外延抖动导致窗口忽大忽小)
      const now = performance.now()
      if (shrinkSince === null) shrinkSince = now
      else if (now - shrinkSince >= SHRINK_DEBOUNCE_MS) {
        shrinkSince = null
        await applyWindow(target)
      }
    } else {
      shrinkSince = null
    }
  }

  function startCheckLoop(): void {
    if (checkTimer) return
    checkTimer = setInterval(() => void check(), CHECK_INTERVAL_MS)
  }

  function stopCheckLoop(): void {
    if (checkTimer) {
      clearInterval(checkTimer)
      checkTimer = undefined
    }
    lastWin = null
    shrinkSince = null
  }

  /** 模型未就绪时挂起:就绪后自动进入(启动恢复路径用)。 */
  function startPendingRetry(): void {
    if (retryTimer) return
    retryTimer = setInterval(() => {
      if (!pendingEnter) {
        if (retryTimer) {
          clearInterval(retryTimer)
          retryTimer = undefined
        }
        return
      }
      if (animator.getDisplayBounds?.()) {
        pendingEnter = false
        if (retryTimer) {
          clearInterval(retryTimer)
          retryTimer = undefined
        }
        void enter()
      }
    }, RETRY_INTERVAL_MS)
  }

  async function enter(): Promise<void> {
    if (active) return
    if (!api || !animator.getDisplayBounds) return
    const raw = animator.getDisplayBounds()
    if (!raw) {
      pendingEnter = true
      startPendingRetry()
      return
    }
    const win = await api.getWindowBounds()
    if (!win) return
    const base = baseSettings ?? DEFAULT_PET_CONFIG.pet
    current = { positionX: base.positionX, positionY: base.positionY, scale: base.scale }
    entry = { appearance: { ...base }, windowSize: { width: win.width, height: win.height } }
    setActive(true)
    updateDragZone(raw)
    // 初始收缩:窗口 = 包围盒 + 边距(夹取由主进程),宠物屏幕位置/大小不变
    await applyWindow(computeTargetWindow(win, raw))
    startCheckLoop()
  }

  async function exit(): Promise<void> {
    if (!active) return
    stopCheckLoop()
    pendingEnter = false
    const snap = entry
    entry = null
    if (api && snap) {
      // 恢复进入时的窗口尺寸,但锚定宠物**当前**屏幕位置(极简期间拖动过也不跳回);
      // 派生外观同步恢复(恢复尺寸下重算后与锚点一致,宠物停在原处)
      const win = await api.getWindowBounds()
      if (win) {
        const centerX = win.x + current.positionX * win.width
        const centerY = win.y + current.positionY * win.height
        await api.setWindowBounds({
          x: Math.round(centerX - snap.appearance.positionX * snap.windowSize.width),
          y: Math.round(centerY - snap.appearance.positionY * snap.windowSize.height),
          width: snap.windowSize.width,
          height: snap.windowSize.height,
        })
      }
      applyDerived({
        positionX: snap.appearance.positionX,
        positionY: snap.appearance.positionY,
        scale: snap.appearance.scale,
      })
    }
    // 窗口/外观就绪后再恢复完整界面(chrome 不闪错位)
    setActive(false)
  }

  return {
    isActive: () => active,
    enter: () => void enter(),
    exit: () => void exit(),
    updateBaseSettings(settings: PetPetSettings): void {
      baseSettings = { ...settings }
      // 竞态兜底:配置晚于进入时加载(如启动后立刻点按钮)→ 补应用当前派生值,
      // 否则动画器仍停在旧外观,窗口已收缩但宠物位置/大小错位
      if (active) {
        options.onPetSettingsApply({
          ...baseSettings,
          positionX: current.positionX,
          positionY: current.positionY,
          scale: current.scale,
        })
      }
    },
    dispose(): void {
      stopCheckLoop()
      pendingEnter = false
      if (retryTimer) {
        clearInterval(retryTimer)
        retryTimer = undefined
      }
      setActive(false)
    },
  }
}
