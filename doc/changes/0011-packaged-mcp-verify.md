# 0011 · A1 收尾:打包版 MCP 反向链路实机验证(DSH → 打包 mcp-server → 宠物)

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:阶段 4/5 遗留收尾(0008"真实 Agent 验证待 DSH 重启" + 0009"打包版 mcp-client 指向")

---

## 目的

把阶段 4 的反向链路验证从"开发态 mcp-server"升级到**打包版**(0009 遗留项):DSH 的 mcp-client 不再 spawn `apps/pet/out/main/mcp-server.js`,而是 spawn 安装/分发产物里 asar.unpacked 的 mcp-server,验证整条链路在打包环境下可用。

## 改动清单

### DSH 用户 profile(根仓库外,不提交)

| 文件 | 改动 |
|---|---|
| `C:\Users\wanyu\.dsh\profiles\web\cordis.patch.yml` | mcp-pet 的 `args` 指向打包版:`C:\Users\wanyu\Desktop\projects\deepseek-harness\apps\pet\dist\win-unpacked\resources\app.asar.unpacked\out\main\mcp-server.js`;注释标明打包版/开发版两条路径的切换方法 |

### apps/pet —— 无源码改动,仅本文档

## 关键决策

1. **指向 win-unpacked 路径而非 NSIS 安装路径**:本机尚未执行 NSIS 安装(`%LOCALAPPDATA%\Programs\dsh-pet` 不存在),win-unpacked 是当前唯一稳定的打包版产物位置(portable 每次自解压到临时目录,路径会变,不适合做 spawn 目标)。
2. **spawn 目标必须是 asar.unpacked 里的真实文件**:node 读不了 asar 内文件;打包版 mcp-server 自包含(0009 已全量打包),DSH 用裸 `node` spawn 即可,无需 node_modules。

## 踩坑记录

### 无(配置即生效,见验证)

## 验证结果

1. 用户启动打包版宠物(`dist\win-unpacked\dsh-pet.exe`)→ bridge 在 `127.0.0.1:39761` 监听 ✅
2. 用户重启 DSH → 新 patch 生效(web profile 不热载,0008 坑 5 已知)✅
3. DSH spawn 的 mcp-server 进程命令行确认指向 **win-unpacked 的 asar.unpacked 路径**(不是 dev 的 out/main)✅
4. 会话内依次调用三个 MCP 工具,全部返回 `ok`:
   - `mcp__pet__speak` ✅
   - `mcp__pet__setExpression(happy)` ✅
   - `mcp__pet__notify` ✅
5. 用户确认宠物窗口**三项表现全中**:说话气泡 + happy 表情 + 系统通知 ✅

链路:`DSH Agent 调用工具 → DSH mcp-client(stdio)→ 打包版 mcp-server → POST 127.0.0.1:39761/pet/bridge → 宠物主进程 → PetEvent → renderer 气泡/表情 + 系统通知`

## 遗留 / 后续

- **切换回 dev 开发**:把 cordis.patch.yml 的 args 改回 `apps/pet/out/main/mcp-server.js` 并重启 DSH(注释里已写)。
- **NSIS 安装后**:若以后改用安装版,args 需改为 `<install>\resources\app.asar.unpacked\out\main\mcp-server.js`(例如 `%LOCALAPPDATA%\Programs\dsh-pet\...`),再重启 DSH。
- 下一步(用户既定顺序):B2 多会话雷达 → B3 Cordis 插件管理界面。
