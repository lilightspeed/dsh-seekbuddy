import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_PET_CONFIG,
  type PetConfig,
  type PetConfigUpdate,
} from '../shared/pet-config.ts'

/**
 * 主进程内部补丁(比 renderer 的 PetConfigUpdate 多一个 targetSessionId,
 * 该字段只能由主进程自己写 —— selectSession 时持久化,renderer 改不了)。
 */
export interface PetConfigPatch extends PetConfigUpdate {
  targetSessionId?: string | null
}

/**
 * 阶段 5:极简 JSON 配置持久化(electron-store 的"等价"实现,零依赖):
 * - 文件:userData/config.json(dev 与 prod 的 userData 各自独立,互不污染)。
 * - 读:构造时读一次,与默认值合并;文件不存在/损坏 → 保持默认,不崩溃。
 * - 写:原子写(先写 .tmp 再 rename,同盘 rename 原子),避免写一半损坏配置。
 * 设置项少、写频率低,不需要 schema 库;baseUrl 合法性在此收敛。
 */
export class PetConfigStore {
  private readonly file: string
  private value: PetConfig

  constructor() {
    this.file = join(app.getPath('userData'), 'config.json')
    this.value = cloneDefault()
    this.load()
  }

  get(): PetConfig {
    return this.value
  }

  /** 应用补丁并落盘;返回更新后的完整配置(主进程据此做副作用:重连/外观/自启)。 */
  update(patch: PetConfigPatch): PetConfig {
    const next: PetConfig = {
      ...this.value,
      dsh: { ...this.value.dsh },
      appearance: { ...this.value.appearance },
      pet: { ...this.value.pet },
      voice: { ...this.value.voice },
    }
    if (patch.dshBaseUrl !== undefined) {
      const normalized = normalizeBaseUrl(patch.dshBaseUrl)
      if (normalized !== null) next.dsh.baseUrl = normalized
    }
    if (patch.opacity !== undefined) next.appearance.opacity = clamp(patch.opacity, 0, 1)
    if (patch.scale !== undefined) next.appearance.scale = clamp(patch.scale, 0.6, 1.6)
    if (patch.petPositionX !== undefined) next.pet.positionX = clamp(patch.petPositionX, 0, 1)
    if (patch.petPositionY !== undefined) next.pet.positionY = clamp(patch.petPositionY, 0, 1)
    if (patch.petScale !== undefined) next.pet.scale = clamp(patch.petScale, 0.2, 3)
    if (patch.petHeadAmplitude !== undefined) next.pet.headAmplitude = clamp(patch.petHeadAmplitude, 0, 1)
    if (patch.petEyeAmplitude !== undefined) next.pet.eyeAmplitude = clamp(patch.petEyeAmplitude, 0, 1)
    if (patch.petDeadZone !== undefined) next.pet.deadZone = clamp(patch.petDeadZone, 0, 100)
    if (patch.petDistance !== undefined) next.pet.distance = clamp(patch.petDistance, 20, 2000)
    if (patch.petResponse !== undefined) next.pet.response = clamp(patch.petResponse, 0.2, 5)
    if (patch.petPupilSensitivity !== undefined) next.pet.pupilSensitivity = clamp(patch.petPupilSensitivity, 200, 2000)
    if (patch.petPupilMax !== undefined) next.pet.pupilMax = clamp(patch.petPupilMax, 0, 1)
    if (patch.petDragStrength !== undefined) next.pet.dragStrength = clamp(patch.petDragStrength, 0, 1)
    if (patch.petShowHitMesh !== undefined) next.pet.showHitMesh = Boolean(patch.petShowHitMesh)
    if (patch.petPatStrength !== undefined) next.pet.patStrength = clamp(patch.petPatStrength, 0, 8)
    if (patch.voiceEnabled !== undefined) next.voice.enabled = Boolean(patch.voiceEnabled)
    if (patch.launchAtLogin !== undefined) next.launchAtLogin = Boolean(patch.launchAtLogin)
    if (patch.targetSessionId !== undefined) {
      next.targetSessionId = patch.targetSessionId === null ? null : String(patch.targetSessionId)
    }
    this.value = next
    this.save()
    return this.value
  }

  private save(): void {
    try {
      const dir = dirname(this.file)
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[pet] config save failed:', error)
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PetConfig>
      if (raw && typeof raw === 'object') {
        const next: PetConfig = {
          ...this.value,
          dsh: { ...this.value.dsh },
          appearance: { ...this.value.appearance },
          pet: { ...this.value.pet },
          voice: { ...this.value.voice },
        }
        if (typeof raw.dsh?.baseUrl === 'string') {
          const normalized = normalizeBaseUrl(raw.dsh.baseUrl)
          if (normalized !== null) next.dsh.baseUrl = normalized
        }
        if (typeof raw.appearance?.opacity === 'number') next.appearance.opacity = clamp(raw.appearance.opacity, 0, 1)
        if (typeof raw.appearance?.scale === 'number') next.appearance.scale = clamp(raw.appearance.scale, 0.6, 1.6)
        if (raw.pet && typeof raw.pet === 'object') {
          if (typeof raw.pet.positionX === 'number') next.pet.positionX = clamp(raw.pet.positionX, 0, 1)
          if (typeof raw.pet.positionY === 'number') next.pet.positionY = clamp(raw.pet.positionY, 0, 1)
          if (typeof raw.pet.scale === 'number') next.pet.scale = clamp(raw.pet.scale, 0.2, 3)
          if (typeof raw.pet.headAmplitude === 'number') next.pet.headAmplitude = clamp(raw.pet.headAmplitude, 0, 1)
          if (typeof raw.pet.eyeAmplitude === 'number') next.pet.eyeAmplitude = clamp(raw.pet.eyeAmplitude, 0, 1)
          if (typeof raw.pet.deadZone === 'number') next.pet.deadZone = clamp(raw.pet.deadZone, 0, 100)
          if (typeof raw.pet.distance === 'number') next.pet.distance = clamp(raw.pet.distance, 20, 2000)
          if (typeof raw.pet.response === 'number') next.pet.response = clamp(raw.pet.response, 0.2, 5)
          if (typeof raw.pet.pupilSensitivity === 'number') next.pet.pupilSensitivity = clamp(raw.pet.pupilSensitivity, 200, 2000)
          if (typeof raw.pet.pupilMax === 'number') next.pet.pupilMax = clamp(raw.pet.pupilMax, 0, 1)
          if (typeof raw.pet.dragStrength === 'number') next.pet.dragStrength = clamp(raw.pet.dragStrength, 0, 1)
          if (typeof raw.pet.showHitMesh === 'boolean') next.pet.showHitMesh = raw.pet.showHitMesh
          if (typeof raw.pet.patStrength === 'number') next.pet.patStrength = clamp(raw.pet.patStrength, 0, 8)
        }
        if (typeof raw.voice?.enabled === 'boolean') next.voice.enabled = raw.voice.enabled
        if (typeof raw.launchAtLogin === 'boolean') next.launchAtLogin = raw.launchAtLogin
        if (raw.targetSessionId === null || typeof raw.targetSessionId === 'string') {
          next.targetSessionId = raw.targetSessionId
        }
        this.value = next
      }
    } catch {
      // 文件不存在或损坏:保持默认值,首次保存时重建
    }
  }
}

function cloneDefault(): PetConfig {
  return {
    ...DEFAULT_PET_CONFIG,
    dsh: { ...DEFAULT_PET_CONFIG.dsh },
    appearance: { ...DEFAULT_PET_CONFIG.appearance },
    pet: { ...DEFAULT_PET_CONFIG.pet },
    voice: { ...DEFAULT_PET_CONFIG.voice },
  }
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

/**
 * 归一化 DSH 基址:只接受 http(s)://host[:port](去尾斜杠);
 * 带路径/非法输入返回 null(调用方保持原值)。DSH 基址必须是根路径。
 */
function normalizeBaseUrl(url: string): string | null {
  const trimmed = String(url).trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]+$/.test(trimmed)) return null
  return trimmed
}
