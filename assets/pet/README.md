# assets/pet —— 宠物素材放置规则

> 动画管线按本目录的**目录名 + 文件命名**加载,请严格遵守命名规则。
> **现役角色是 Live2D**(`live2d/`,0015 起);`sprites/` 只作为 Live2D 不可用时的回落占位
> (WebGL2 缺失时动画后端回落到 PixiJS 球宠,暂不加载贴图)。放好后把素材来源的 license
> 记录在文末表格里(免费≠可商用)。

## 目录总览

```
assets/pet/
├── live2d/         现役角色:Live2D 模型 + Core + 着色器(见 live2d/README.md)
├── sprites/        角色动画(PixiJS 精灵图;回落/备选路线)
├── lottie/         Lottie JSON(备选路线,未采用)
├── icons/          托盘 / 应用图标
└── audio/          音效(阶段后补,先留空)
```

## sprites/ —— 角色动画(回落/备选路线)

### 状态目录(名字固定,代码按名找)

| 目录 | 状态 | 优先级 | 帧数建议 |
|---|---|---|---|
| `idle` | 待机(常驻循环) | ⭐ 必选 | 8~12 |
| `thinking` | 思考(DSH agent 忙碌) | ⭐ 强烈建议 | 4~8 |
| `happy` | 开心(任务完成) | 建议 | 4~6 |
| `sad` | 难过(报错/失败) | 建议 | 4~6 |
| `talking` | 说话(气泡/语音) | 可选后补 | 4~6 |

### 每个状态目录内,两种格式任选其一

**A. 序列帧(推荐)**:`00.png`、`01.png`、`02.png` … 两位补零、连续递增;同目录内所有帧尺寸一致。

**B. 单张雪碧图**:`sheet.png` + `frames.json`(帧布局):

```json
{
  "fps": 12,
  "frames": [
    { "x": 0, "y": 0, "w": 256, "h": 256 },
    { "x": 256, "y": 0, "w": 256, "h": 256 }
  ]
}
```

### 通用要求

- PNG-32(**带透明通道、无背景**),角色居中、边缘留白
- 帧尺寸:256×256(推荐);细节多可用 512×512,**全项目统一一个尺寸**
- fps:默认 12,可在 `sprites.json` 里按状态覆盖
- 素材风格建议:萌系小动物(猫/狐/狗)+ 扁平或简笔风;**不要用带 IP 的角色**(皮卡丘等)

## sprites.json —— 可选清单(不想要可删)

```json
{
  "defaultFps": 12,
  "states": {
    "idle": { "fps": 12 },
    "thinking": { "fps": 10 },
    "happy": { "fps": 12 },
    "sad": { "fps": 10 },
    "talking": { "fps": 12 }
  }
}
```

## icons/

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `tray.png` | 64×64 | 系统托盘图标 |
| `icon.png` | 256×256 | 应用图标(打包 .ico 用) |

可用角色头像,后期再补也行。

## lottie/(可选路线)

一个动画一个 JSON,文件名 = 状态名:`idle.json`、`thinking.json` … 与 sprites/ 二选一或并存(代码优先读 sprites/)。

## audio/(后补)

短音效 WAV/MP3:`complete`(完成)、`error`(报错)、`notify`(通知)等,先留空目录。

---

## License 记录(务必填写)

| 素材 | 来源 URL | License | 可商用? | 署名要求 |
|---|---|---|---|---|
| sprites/idle |  |  |  |  |
| sprites/thinking |  |  |  |  |
| sprites/happy |  |  |  |  |
| sprites/sad |  |  |  |  |
| icons/tray |  |  |  |  |
| icons/icon |  |  |  |  |
