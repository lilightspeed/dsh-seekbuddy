import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    title: 'DSH Pet',
    show: false,
    webPreferences: {
      // type:module 下 electron-vite 把 preload 输出为 .mjs,sandbox 必须关闭
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  // 开发:加载 electron-vite 的开发服务器;生产:加载 out/renderer/index.html
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
