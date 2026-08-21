import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

/** 0062:托盘句柄 —— setPetOnly 在极简模式勾选态变化后重建菜单(checkbox 状态同步)。 */
export interface PetTray {
  setPetOnly(checked: boolean): void
}

/**
 * 托盘:显示/隐藏 + 极简模式开关 + 退出;图标用应用图标 ymcog-jpmci-001.ico
 * (win32,含多尺寸帧)。项目仅支持 Windows;非 win32 平台对 .ico 的支持未验证。
 * 极简模式下窗口内 UI 全部隐藏,托盘是切换回普通模式的常驻入口之一。
 */
export function createTray(
  onToggle: () => void,
  opts: {
    /** 当前是否处于极简模式(勾选态来源)。 */
    isPetOnly: () => boolean
    /** 点击勾选/取消极简模式(checked 为目标值;由主进程落盘配置并推送 renderer)。 */
    onPetOnlyToggle: (checked: boolean) => void
  },
): PetTray {
  const icon = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/pet/icons/ymcog-jpmci-001.ico'))
  const tray = new Tray(icon)
  tray.setToolTip('DSH Pet')
  const rebuild = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 / 隐藏', click: onToggle },
        { type: 'separator' },
        {
          label: '极简模式(仅显示宠物)',
          type: 'checkbox',
          checked: opts.isPetOnly(),
          click: (item) => opts.onPetOnlyToggle(item.checked),
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    )
  }
  rebuild()
  tray.on('double-click', onToggle)
  return {
    setPetOnly(): void {
      rebuild()
    },
  }
}
