import { Graphics } from 'pixi.js'
import type { PetState } from '../fsm/pet-machine.ts'
import type { PetAnimator } from './animator.ts'
import type { PetStage } from './stage.ts'

/**
 * 占位动画后端:用 PixiJS 几何图形程序化画一个"球宠"。
 * 素材到位后,把本文件换成加载 assets/pet/sprites/<state>/ 贴图的实现
 * (接口不变,外部零改动)。素材放置规则见 assets/pet/README.md。
 */

// 状态色对齐 DeepSeek 主题蓝(design-platform deepseek scale):
// 500 主色 / 400 明快 / 300 浅蓝(思考) / 450 说话
const BODY_COLORS: Record<PetState, number> = {
  idle: 0x4176e6, // deepseek-500
  thinking: 0xb7c8fe, // deepseek-300
  happy: 0x679efe, // deepseek-400
  sad: 0x99aacc,
  talking: 0x5686fe, // deepseek-450
}

const BODY_RADIUS = 46

/** 各状态的动画参数:跳动幅度(px)、跳动周期(s)、嘴型。 */
const MOTION: Record<PetState, { bounce: number; period: number; mouth: 'smile' | 'frown' | 'talk' | 'none' }> = {
  idle: { bounce: 6, period: 1.8, mouth: 'smile' },
  thinking: { bounce: 10, period: 0.9, mouth: 'none' },
  happy: { bounce: 16, period: 0.45, mouth: 'smile' },
  sad: { bounce: 0, period: 1, mouth: 'frown' },
  talking: { bounce: 8, period: 1.2, mouth: 'talk' },
}

export function createSpriteAnimator(stage: PetStage): PetAnimator {
  const body = new Graphics()
  const eyeL = new Graphics()
  const eyeR = new Graphics()
  const mouth = new Graphics()
  stage.layer.addChild(body, eyeL, eyeR, mouth)

  let state: PetState = 'idle'
  let time = 0
  let blink = 0

  function draw(deltaSeconds: number): void {
    time += deltaSeconds
    const m = MOTION[state]
    const bounceY = m.bounce === 0 ? 6 : m.bounce * Math.abs(Math.sin((time * Math.PI * 2) / m.period))
    // 呼吸缩放
    const breath = 1 + 0.02 * Math.sin(time * Math.PI * 2 * 0.5)

    body.clear()
    body.circle(0, 8 - bounceY, BODY_RADIUS * breath).fill(BODY_COLORS[state])

    // 眼睛:正常为圆点;idle 偶发眨眼;thinking 上移(思考)
    blink += deltaSeconds
    const isBlink = state === 'idle' && (blink % 3.4) < 0.12
    const eyeY = 8 - bounceY - 8 + (state === 'thinking' ? -3 : 0)
    const eyeDX = state === 'thinking' ? 1 : 0
    eyeL.clear()
    eyeR.clear()
    if (isBlink) {
      eyeL.rect(-16 + eyeDX, eyeY + 2, 9, 2).fill(0x332211)
      eyeR.rect(7 + eyeDX, eyeY + 2, 9, 2).fill(0x332211)
    } else {
      eyeL.circle(-11 + eyeDX, eyeY, 4.5).fill(0x332211)
      eyeR.circle(11 + eyeDX, eyeY, 4.5).fill(0x332211)
    }

    // 嘴:smile 弧 / frown 反弧 / talk 开合椭圆 / none 无
    mouth.clear()
    const mouthY = 8 - bounceY + 18
    if (m.mouth === 'smile') {
      mouth.arc(0, mouthY - 6, 10, Math.PI * 0.15, Math.PI * 0.85).stroke({ width: 3, color: 0x553322 })
    } else if (m.mouth === 'frown') {
      mouth.arc(0, mouthY + 10, 10, Math.PI * 1.15, Math.PI * 1.85).stroke({ width: 3, color: 0x553322 })
    } else if (m.mouth === 'talk') {
      const open = 3 + 3 * Math.abs(Math.sin(time * Math.PI * 2 * 3))
      mouth.ellipse(0, mouthY + 2, 8, open).fill(0x553322)
    }
  }

  return {
    play(next: PetState): void {
      state = next
      draw(0)
    },
    tick(deltaSeconds: number): void {
      draw(deltaSeconds)
    },
    dispose(): void {
      body.destroy()
      eyeL.destroy()
      eyeR.destroy()
      mouth.destroy()
    },
  }
}
