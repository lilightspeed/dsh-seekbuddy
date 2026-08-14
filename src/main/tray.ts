import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

/** 托盘:显示/隐藏 + 退出;图标占位(assets/pet/icons/tray.png,后续可换角色头像)。 */
export function createTray(onToggle: () => void): Tray {
  const iconPath = join(import.meta.dirname, '../../assets/pet/icons/tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  const tray = new Tray(icon)
  tray.setToolTip('DSH Pet')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: onToggle },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  )
  tray.on('double-click', onToggle)
  return tray
}
