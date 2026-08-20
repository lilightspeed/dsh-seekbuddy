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
  // 0056c:角色层锚点**每帧**跟随窗口尺寸 —— resize 事件可能被系统/Chromium 合并
  // (低于主进程 setBounds 频率),事件驱动会让占位宠物在缩放期间滞后跳变;
  // ticker 已由 main.ts 驱动,这里只更新一个 Vector2,开销可忽略。
  app.ticker.add(() => {
    layer.position.set(window.innerWidth / 2, window.innerHeight * 0.44)
  })
  app.stage.addChild(layer)
  return { app, layer }
}
