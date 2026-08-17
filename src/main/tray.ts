import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

/** 托盘:显示/隐藏 + 退出;图标用应用图标 ymcog-jpmci-001.ico(win32,含多尺寸帧),
 *  非 Windows 平台回退原占位 png(nativeImage 不认 .ico)。 */
export function createTray(onToggle: () => void): Tray {
  const iconPath = join(
    import.meta.dirname,
    process.platform === 'win32'
      ? '../../assets/pet/icons/ymcog-jpmci-001.ico'
      : '../../assets/pet/icons/tray.png',
  )
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
