import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

/** 0062:托盘句柄 —— setPetOnly 在极简模式状态变化后重建菜单(开启态由 label 前缀「✓ 」反映)。 */
export interface PetTray {
  setPetOnly(checked: boolean): void
}

/**
 * 托盘:显示/隐藏 + 极简模式开关 + 退出;图标用应用图标 ymcog-jpmci-001.ico
 * (win32,含多尺寸帧)。项目仅支持 Windows;非 win32 平台对 .ico 的支持未验证。
 * 极简模式下窗口内 UI 全部隐藏,托盘是切换回普通模式的常驻入口之一。
 *
 * 交互:左键单击图标 = 显示 / 隐藏窗口(原双击,已改为单击);右键 = 弹出菜单。
 * 菜单项保持纯文本(无 checkbox / 图标):checkbox 会让原生菜单预留左侧勾选列,
 * 导致所有文本整体右移(文本偏右);极简模式开启态改用「✓ 」前缀体现,文本正常左对齐。
 * 不使用 setContextMenu(避免 Windows 下左键既弹菜单又触发单击切换的冲突),
 * 改为右键按需 popUpContextMenu。
 */
export function createTray(
  onToggle: () => void,
  opts: {
    /** 当前是否处于极简模式(勾选态来源)。 */
    isPetOnly: () => boolean
    /** 点击切换极简模式(checked 为目标值;由主进程落盘配置并推送 renderer)。 */
    onPetOnlyToggle: (checked: boolean) => void
  },
): PetTray {
  const icon = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/pet/icons/ymcog-jpmci-001.ico'))
  const tray = new Tray(icon)
  tray.setToolTip('DSH Pet')

  // 0062:菜单项纯文本(无 checkbox / 图标),避免原生菜单预留左侧列导致文本右移;
  // 极简模式开启态用「✓ 」前缀体现,状态每次重建时按当前值读取。
  const buildMenu = (): Menu =>
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: onToggle },
      { type: 'separator' },
      {
        label: opts.isPetOnly() ? '✓ 仅显示宠物' : '仅显示宠物',
        click: () => opts.onPetOnlyToggle(!opts.isPetOnly()),
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])

  let menu = buildMenu()
  // 左键单击:显示 / 隐藏窗口(原 double-click,改为单击)
  tray.on('click', onToggle)
  // 右键:弹出菜单
  tray.on('right-click', () => tray.popUpContextMenu(menu))

  return {
    setPetOnly(): void {
      // 状态变化后重建(菜单为右键按需弹出,弹出时已是新状态;此处重建以保一致)
      menu = buildMenu()
    },
  }
}
