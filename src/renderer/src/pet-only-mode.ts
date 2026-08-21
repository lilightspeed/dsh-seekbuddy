import type { PetApi } from '../../shared/pet-event.ts'
import type { PetAnimator } from './pet/animator.ts'

/**
 * 0062 极简模式(仅显示宠物):
 * - 隐藏全部非宠物组件(CSS body.pet-only 统一处理,组件逻辑零改动);
 * - **不改动窗口大小**:窗口保持进入模式前的尺寸,宠物超出窗口的部分被截断
 *   (用户明确允许画面截断),屏幕位置/大小随窗口 CSS 不变;
 * - 拖动:沿用 #stage 原生 drag(整窗即拖拽范围),与普通模式同一套机制;
 *   摸头/身体命中区(no-drag)依旧优先;
 * - 所有动作逻辑(状态机/动画/摸头/身体 sad/睡眠/拖动物理)保留。
 *
 * 早期版本(0062 初版)会把窗口收缩到宠物包围盒大小 + 关闭 acrylic,但这会在
 * 窗口边缘留下一圈细灰边/阴影(已通过 DWM 描边/圆角修复),且收缩逻辑复杂易抖。
 * 现改为纯"隐藏组件",窗口尺寸完全交给用户(可手动缩到很低高度),宠物截断即可。
 */

export interface PetOnlyModeOptions {
  /** 模式开关状态变化(驱动主页面按钮激活态)。 */
  onActiveChange?(active: boolean): void
}

export interface PetOnlyMode {
  isActive(): boolean
  enter(): void
  exit(): void
  dispose(): void
}

export function createPetOnlyMode(
  _api: PetApi | undefined,
  _animator: PetAnimator,
  options: PetOnlyModeOptions,
): PetOnlyMode {
  let active = false

  /** 切换激活态:挂/卸 body.pet-only(组件显隐由 CSS 统一处理)。 */
  function setActive(next: boolean): void {
    if (active === next) return
    active = next
    document.body.classList.toggle('pet-only', next)
    options.onActiveChange?.(next)
  }

  return {
    isActive: () => active,
    enter: () => setActive(true),
    exit: () => setActive(false),
    dispose(): void {
      setActive(false)
    },
  }
}
