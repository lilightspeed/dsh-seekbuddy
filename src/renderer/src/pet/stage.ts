import { Application, Container } from 'pixi.js'

export interface PetStage {
  app: Application
  /** 角色层:宠物内容都挂这里;将来换 Live2D 时把这一层换成独立 canvas。 */
  layer: Container
}

/** 创建透明 Pixi 舞台,铺满窗口;角色锚点在窗口下方偏中。 */
export async function createStage(): Promise<PetStage> {
  const app = new Application()
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    resizeTo: window,
    resolution: window.devicePixelRatio || 1,
  })
  document.querySelector<HTMLDivElement>('#stage')?.appendChild(app.canvas)

  const layer = new Container()
  layer.position.set(window.innerWidth / 2, window.innerHeight * 0.44)
  // 阶段 5 窗口缩放:resizeTo 只缩放渲染器,角色层锚点需手动跟随窗口尺寸
  window.addEventListener('resize', () => {
    layer.position.set(window.innerWidth / 2, window.innerHeight * 0.44)
  })
  app.stage.addChild(layer)
  return { app, layer }
}
