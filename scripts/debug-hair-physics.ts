/**
 * Live2D 物理调试工具(0036):在 Node 环境直接跑 CubismPhysics 演算,
 * 检查 _currentRigOutputs 里各 PhysicsSetting 的粒子输出量级、验证
 * restoreHairFromAnglePhysics 的恢复逻辑。跑法:
 *   npx --no-install tsx scripts/debug-hair-physics.ts
 * 依赖根仓库 node_modules 的 tsx;无需 DOM/WebGL(物理演算纯计算)。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 1. Core 是 Emscripten 产物,Node 分支需要 __dirname / require(wasm base64 内嵌),
//    用 vm.runInThisContext 注入全局后执行,`var Live2DCubismCore` 挂到 globalThis
;(globalThis as { __dirname?: string }).__dirname = dirname(fileURLToPath(import.meta.url))
;(globalThis as { require?: NodeRequire }).require = createRequire(import.meta.url)
const coreCode = readFileSync(new URL('../assets/pet/live2d/core/live2dcubismcore.js', import.meta.url), 'utf8')
vm.runInThisContext(coreCode, { filename: 'live2dcubismcore.js' })
console.log('Core Version:', (globalThis as any).Live2DCubismCore?.Version)

const { CubismFramework, LogLevel, Option } = await import('../vendor/live2d/Framework/dist/src/live2dcubismframework.js')
const { CubismMoc } = await import('../vendor/live2d/Framework/dist/src/model/cubismmoc.js')
const { CubismPhysics } = await import('../vendor/live2d/Framework/dist/src/physics/cubismphysics.js')

const option = new Option()
option.loggingLevel = LogLevel.LogLevel_Error
CubismFramework.startUp(option)
CubismFramework.initialize()

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// 2. 模型
const mocBuf = toArrayBuffer(readFileSync(new URL('../assets/pet/live2d/ds-pet.moc3', import.meta.url)))
const moc = CubismMoc.create(mocBuf, true)
const model = moc.createModel()
console.log('model created, params:', model.getParameterCount())

// 3. 物理
const physBuf = toArrayBuffer(readFileSync(new URL('../assets/pet/live2d/ds-pet.physics3.json', import.meta.url)))
const physics = CubismPhysics.create(physBuf, physBuf.byteLength)

const idm = CubismFramework.getIdManager()
const idxOf = (name: string): number => model.getParameterIndex(idm.getId(name))
const iAngleX = idxOf('ParamAngleX')
const iAngleY = idxOf('ParamAngleY')
const iHairUp = idxOf('ParamBackHairUp')
const iHairDown = idxOf('ParamBackHairDown')
const iHairSwing = idxOf('ParamBackHairSwing')
const iSwayX = idxOf('ParamHairSwayX')
const iSwayY = idxOf('ParamHairSwayY')
const iDragX = idxOf('ParamDragX')
const iDragY = idxOf('ParamDragY')
console.log('idx angleX/Y:', iAngleX, iAngleY, '| hair:', iHairUp, iHairDown, iHairSwing, iSwayX, iSwayY, '| drag:', iDragX, iDragY)
console.log(
  'ParamAngleX min/max/def:', model.getParameterMinimumValue(iAngleX), model.getParameterMaximumValue(iAngleX), model.getParameterDefaultValue(iAngleX),
  '| hairUp:', model.getParameterMinimumValue(iHairUp), model.getParameterMaximumValue(iHairUp),
)

const rigState = physics as unknown as {
  _currentRigOutputs: { outputs: number[] }[]
  _physicsRig: { settings: { outputCount: number }[] }
}
console.log('_currentRigOutputs.length:', rigState._currentRigOutputs?.length)
rigState._currentRigOutputs?.forEach((o, i) => console.log(`  rig[${i}].outputs:`, o.outputs))
// 打印 SDK _physicsRig.outputs 实际结构(destination.id 字段确认)
const sdkOut = rigState._physicsRig.outputs as unknown as Array<Record<string, unknown>>
console.log('\n_physicsRig.outputs[0..5] 结构:')
for (let i = 0; i < Math.min(6, sdkOut.length); i++) {
  const d = sdkOut[i]?.destination as { id?: unknown } | undefined
  const idObj = d?.id
  console.log(`  [${i}] id=`, typeof idObj, idObj instanceof Object ? String(idObj) : idObj,
    '| angleScale=', (sdkOut[i] as { angleScale?: number })?.angleScale,
    '| weight=', (sdkOut[i] as { weight?: number })?.weight)
}

// 4. 模拟视角跟随:headX→ParamAngleX=15°, headY→ParamAngleY=8°
model.setParameterValueByIndex(iAngleX, 15)
model.setParameterValueByIndex(iAngleY, 8)
console.log('\n=== evaluate 30 帧(ParamAngleX=15, ParamAngleY=8, ParamDrag=0) ===')
for (let f = 0; f < 30; f++) {
  physics.evaluate(model, 1 / 60)
  if (f % 5 === 4 || f < 3) {
    const o = rigState._currentRigOutputs
    const g = (i: number) => o[i]?.outputs.map((v) => v.toFixed(3)).join(',')
    console.log(
      `f=${f} | S1[up,down,swing]=[${g(0)}] | S2[swing]=[${g(1)}] | S3[swayX]=[${g(2)}] | S4[swayY]=[${g(3)}]`,
      `| param hairUp=${model.getParameterValueByIndex(iHairUp).toFixed(3)} swing=${model.getParameterValueByIndex(iHairSwing).toFixed(3)} swayX=${model.getParameterValueByIndex(iSwayX).toFixed(3)}`,
    )
  }
}

// 4.5 完整模拟 cubism-runtime 的恢复逻辑(blend=0 未拖动),验证最终参数值
console.log('\n=== 模拟 restoreHairFromAnglePhysics(blend=0) ===')
{
  const rig = rigState._physicsRig
  const out = rig.outputs
  const hairIdx: Record<string, number> = {
    ParamBackHairUp: iHairUp,
    ParamBackHairDown: iHairDown,
    ParamBackHairSwing: iHairSwing,
    ParamHairSwayX: iSwayX,
    ParamHairSwayY: iSwayY,
  }
  const results: Record<string, number> = {}
  for (let s = 0; s < 4; s++) {
    const setting = rig.settings[s]
    const settingOutputs = rigState._currentRigOutputs[s]?.outputs
    for (let j = 0; j < setting.outputCount; j++) {
      const def = out[setting.baseOutputIndex + j]
      const idName = (def.destination.id as { getString(): string }).getString()
      const idx = hairIdx[idName]
      if (idx === undefined) continue
      const raw = settingOutputs?.[j] ?? 0
      const min = model.getParameterMinimumValue(idx)
      const max = model.getParameterMaximumValue(idx)
      const restored = Math.min(max, Math.max(min, raw * def.angleScale))
      model.setParameterValueByIndex(idx, restored)
      results[idName] = restored
    }
  }
  console.log('恢复后参数:', results)
  console.log('模型实际值: up=', model.getParameterValueByIndex(iHairUp).toFixed(3),
    'down=', model.getParameterValueByIndex(iHairDown).toFixed(3),
    'swing=', model.getParameterValueByIndex(iHairSwing).toFixed(3),
    'swayX=', model.getParameterValueByIndex(iSwayX).toFixed(3),
    'swayY=', model.getParameterValueByIndex(iSwayY).toFixed(3))
}

// 5. 再模拟拖动:ParamDragY=0.8, 看 Setting5 输出量级
model.setParameterValueByIndex(iAngleX, 0)
model.setParameterValueByIndex(iAngleY, 0)
model.setParameterValueByIndex(iDragX, 0.6)
model.setParameterValueByIndex(iDragY, 0.6)
console.log('\n=== 再跑 10 帧(ParamDragX=0.6, ParamDragY=0.6, 角度=0) ===')
for (let f = 0; f < 10; f++) {
  physics.evaluate(model, 1 / 60)
  const o = rigState._currentRigOutputs
  const g = (i: number) => o[i]?.outputs.map((v) => v.toFixed(3)).join(',')
  if (f % 3 === 2 || f < 2) {
    console.log(
      `f=${f} | S5[tailTip,tailRoot,swing,swayY,angleY]=[${g(4)}] | S6[tailTip,swayX,up,down,angleZ]=[${g(5)}]`,
      `| param hairUp=${model.getParameterValueByIndex(iHairUp).toFixed(3)} swing=${model.getParameterValueByIndex(iHairSwing).toFixed(3)}`,
    )
  }
}
