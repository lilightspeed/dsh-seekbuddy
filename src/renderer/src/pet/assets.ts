import type { PetState } from '../fsm/pet-machine.ts'

/**
 * 素材加载入口(阶段 2 占位版)。
 *
 * 素材到位后(assets/pet/sprites/<state>/ 序列帧或 sheet,fps 见 sprites.json),
 * 在这里加载贴图并返回每状态的帧列表;SpriteAnimator 据此播放。
 * 当前返回空映射 → 动画器回落到几何占位。
 */
export async function loadPetAssets(): Promise<{ textures: Partial<Record<PetState, unknown>> }> {
  // TODO(阶段 2 素材):probe /pet/sprites.json → 按状态加载贴图序列
  return { textures: {} }
}
