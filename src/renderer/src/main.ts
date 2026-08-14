import { createActor } from 'xstate'
import type { PetApi, PetEvent } from '../../shared/pet-event.ts'
import { petMachine, type PetState } from './fsm/pet-machine.ts'
import type { PetAnimator } from './pet/animator.ts'
import { createSpriteAnimator } from './pet/sprite-animator.ts'
import { createStage } from './pet/stage.ts'

declare global {
  interface Window {
    petApi?: PetApi
  }
}

const api = window.petApi
const statusEl = document.querySelector<HTMLDivElement>('#status')
const bubbleEl = document.querySelector<HTMLDivElement>('#bubble')
const inputEl = document.querySelector<HTMLInputElement>('#msg-input')
const sendBtn = document.querySelector<HTMLButtonElement>('#btn-send')

let bubbleTimer: ReturnType<typeof setTimeout> | undefined
let connText = 'connecting'
let petText = ''

function renderStatus(): void {
  if (statusEl) statusEl.textContent = `${connText}${petText ? ` · pet: ${petText}` : ''}`
}

/** 气泡:显示 text,visibleMs 后自动隐藏。 */
function showBubble(text: string, visibleMs = 3000): void {
  if (!bubbleEl) return
  bubbleEl.textContent = text
  bubbleEl.classList.add('visible')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubbleEl?.classList.remove('visible'), visibleMs)
}

async function boot(): Promise<void> {
  if (!api) {
    connText = 'preload 未注入 window.petApi'
    renderStatus()
    return
  }

  // 舞台 + 动画后端(占位球宠) + 状态机
  const stage = await createStage()
  const animator: PetAnimator = createSpriteAnimator(stage)
  const actor = createActor(petMachine)
  actor.subscribe((snapshot) => {
    petText = snapshot.value as PetState
    renderStatus()
    animator.play(snapshot.value as PetState)
  })
  actor.start()

  // 每帧驱动动画
  stage.app.ticker.add(() => animator.tick(stage.app.ticker.deltaMS / 1000))

  // DSH 事件 → 状态机事件 + 气泡
  api.onPetEvent((event: PetEvent) => {
    switch (event.type) {
      case 'dsh:connected':
        connText = 'connected'
        renderStatus()
        break
      case 'dsh:state':
        connText = event.state
        renderStatus()
        break
      case 'dsh:turn-start':
        actor.send({ type: 'DSH_WORKING' })
        break
      case 'dsh:turn-end':
        actor.send({ type: 'DSH_DONE' })
        showBubble('✓ 完成', 2500)
        break
      case 'op:result':
        if (event.ok) {
          actor.send({ type: 'TALK' })
          showBubble(`发送:${event.summary}`, 2200)
        } else {
          actor.send({ type: 'DSH_ERROR' })
          showBubble(`✗ ${event.summary}`, 3500)
        }
        break
      default:
        break
    }
  })

  // 若连接在订阅前已完成,补读当前状态
  void api.getState().then((state) => {
    if (state.connection) {
      connText = state.connection
      renderStatus()
    }
  })

  // 窗口拖拽:由 #stage 的 -webkit-app-region: drag 原生处理(见 index.html),
  // 不再走 IPC 逐帧 setPosition(曾导致卡顿 + setPosition 参数转换崩溃)。

  // 气泡输入 → 发消息
  const send = (): void => {
    const text = inputEl?.value.trim()
    if (!text) return
    if (inputEl) inputEl.value = ''
    void api.sendMessage(text).then((result) => {
      if (!result.ok) {
        actor.send({ type: 'DSH_ERROR' })
        showBubble(`✗ ${result.summary}`, 3500)
      }
      // ok 时等待 turn-end 事件提示完成;op:result 事件本身不再重复弹
    })
  }
  sendBtn?.addEventListener('click', send)
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send()
  })
}

void boot()
