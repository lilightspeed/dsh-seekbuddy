import { contextBridge } from 'electron'

// 阶段3(关键操作面)会把 DSH 连接事件与操作以白名单形式暴露给 renderer。
// 现在只放一个最小探针,证明 preload 链路通了。
contextBridge.exposeInMainWorld('petApi', {
  platform: process.platform,
})
