/**
 * Live2D 手部不透明度调试工具(0038):检查 moc3 里手部 drawable 的不透明度是否由
 * 参数(ParamArmRChange)驱动,并复现 cubism-runtime 的 hold-end 播放循环。
 *
 * 背景结论(0038):moc3 的 ArtMesh8(待机右手)不透明度 = 1-ParamArmRChange,
 * ArtMesh30/31(思考右手) = ParamArmRChange —— 参数到 1 时只有抬起的手可见。
 * 曾出现"两只右手都半透明":素材 Motion_think.motion3.json 未写 FadeOutTime,
 * SDK 默认 _fadeOutSeconds=1.0,0.5s 的短动作被全程淡出压扁,曲线只到 ~52%。
 * 修复 = CubismMotion.setFadeOutTime(0)(cubism-runtime.startMotion)。
 *
 * 跑法:
 *   npx --no-install tsx scripts/debug-hand-opacity.ts
 * 无需 DOM/WebGL(model.update 是纯计算)。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as { __dirname?: string }).__dirname = dirname(fileURLToPath(import.meta.url))
;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)
const coreCode = readFileSync(new URL('../assets/pet/live2d/core/live2dcubismcore.js', import.meta.url), 'utf8')
vm.runInThisContext(coreCode, { filename: 'live2dcubismcore.js' })

const { CubismFramework, LogLevel, Option } = await import('../vendor/live2d/Framework/dist/src/live2dcubismframework.js')
const { CubismMoc } = await import('../vendor/live2d/Framework/dist/src/model/cubismmoc.js')
const { CubismMotion } = await import('../vendor/live2d/Framework/dist/src/motion/cubismmotion.js')
const { CubismMotionQueueManager } = await import('../vendor/live2d/Framework/dist/src/motion/cubismmotionqueuemanager.js')

const option = new Option()
option.loggingLevel = LogLevel.LogLevel_Error
CubismFramework.startUp(option)
CubismFramework.initialize()

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const mocBuf = toArrayBuffer(readFileSync(new URL('../assets/pet/live2d/ds-pet.moc3', import.meta.url)))
const moc = CubismMoc.create(mocBuf, true)
const model = moc.createModel()
const core = (model as unknown as { _model: any })._model

// 手部 drawable 索引(从上一轮 dump 已知)
const idxOfDrawable = (name: string): number => {
  for (let i = 0; i < core.drawables.count; i++) if (core.drawables.ids[i] === name) return i
  return -1
}
const dIdleArm = idxOfDrawable('ArtMesh8')
const dThinkArm1 = idxOfDrawable('ArtMesh30')
const dThinkArm2 = idxOfDrawable('ArtMesh31')

const idm = CubismFramework.getIdManager()
const iArm = model.getParameterIndex(idm.getId('ParamArmRChange'))

const motionBuf = toArrayBuffer(readFileSync(new URL('../assets/pet/live2d/Motion_think.motion3.json', import.meta.url)))
const motion = CubismMotion.create(motionBuf, motionBuf.byteLength)
motion.setLoop(false)
motion.setFadeInTime(0.15)
motion.setFadeOutTime(0) // 修复:素材无 FadeOutTime 时 SDK 默认 1.0s,短动作全程被淡出压扁
motion.setEffectIds([], [])

// 解析后的曲线数据(ParamArmRChange)
const mdata = (motion as unknown as { _motionData: any })._motionData
for (let ci = 0; ci < mdata.curveCount; ci++) {
  const curve = mdata.curves[ci]
  const idStr = typeof curve.id === 'string' ? curve.id : String(curve.id?.getString?.() ?? curve.id)
  if (idStr !== 'ParamArmRChange') continue
  console.log('curve ParamArmRChange segmentCount=', curve.segmentCount, 'baseSegmentIndex=', curve.baseSegmentIndex)
  for (let s = curve.baseSegmentIndex; s < curve.baseSegmentIndex + curve.segmentCount; s++) {
    const seg = mdata.segments[s]
    const pts = [0, 1, 2, 3].map((k) => {
      const p = mdata.points[seg.basePointIndex + k]
      return p ? `(${p.time},${p.value})` : '-'
    })
    console.log(`  segment[${s}] type=${seg.segmentType} evaluate=${seg.evaluate?.name ?? 'null'} points=${pts.join(' ')}`)
  }
}

const queue = new CubismMotionQueueManager()
queue.startMotion(motion, false)

// 直接求值测试:bezier 在若干时间点的值
{
  const seg = mdata.segments[7]
  const pts = [0, 1, 2, 3].map((k) => mdata.points[seg.basePointIndex + k])
  for (const x of [0.0, 0.1, 0.25, 0.4, 0.4667, 0.4833, 0.5, 0.6]) {
    const v = seg.evaluate(pts, x)
    console.log(`bezier(x=${x}) = ${v.toFixed(4)}`)
  }
  const cm = (await import('../vendor/live2d/Framework/dist/src/math/cubismmath.js')).CubismMath
  console.log('a=', (0.5 - 3 * 0.333 + 3 * 0.167 - 0).toFixed(6), '| Epsilon=', cm.Epsilon)
}

// 按 runtime 节奏模拟:loadParameters → motion 写 → 捕获 → saveParameters → 恢复 → model.update
let motionTime = 0
const frame = new Map<string, number>()
const dt = 1 / 60
const ARM_IDS = ['ParamArmRChange', 'ParamAngleY', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLY', 'ParamBrowRY', 'ParamEyeForm', 'ParamMouthFormOpen']
const armIndex = ARM_IDS.map((id) => [id, model.getParameterIndex(idm.getId(id))] as const)
const entry0 = queue.getCubismMotionQueueEntries()[0] as any

for (let f = 0; f < 90; f++) {
  model.loadParameters()
  const wasWriting = queue.getCubismMotionQueueEntries().some((e) => e && !e.isFinished())
  motionTime += dt
  const rawBefore = model.getParameterValueByIndex(iArm)
  queue.doUpdateMotion(model, motionTime)
  const rawAfter = model.getParameterValueByIndex(iArm)
  if (wasWriting) {
    for (const [id, idx] of armIndex) if (idx >= 0) frame.set(id, model.getParameterValueByIndex(idx))
  }
  model.saveParameters()
  // 恢复(等效 runtime 的 restore;不跳过任何参数,无拖动)
  for (const [id, idx] of armIndex) {
    if (idx >= 0 && frame.has(id)) model.setParameterValueByIndex(idx, frame.get(id) as number)
  }
  model.update()
  const armVal = model.getParameterValueByIndex(iArm)
  const op = (i: number) => (i >= 0 ? core.drawables.opacities[i].toFixed(3) : '-')
  if (f % 10 === 0 || f < 5 || (f >= 28 && f <= 36)) {
    console.log(
      `f=${f} t=${motionTime.toFixed(3)} elapsed=${(motionTime - entry0.getStartTime()).toFixed(3)} ` +
        `wasWriting=${wasWriting} raw=${rawBefore.toFixed(3)}->${rawAfter.toFixed(3)} arm=${armVal.toFixed(3)} ` +
        `| idleArm=${op(dIdleArm)} thinkArm1=${op(dThinkArm1)} thinkArm2=${op(dThinkArm2)}`,
    )
  }
}
console.log('\nfinal frame map:', Object.fromEntries(frame))
