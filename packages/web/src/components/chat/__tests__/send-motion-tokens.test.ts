import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const GLOBALS = readFileSync(path.resolve(__dirname, '../../../routes/globals.css'), 'utf8')

/** One declaration serves every theme: light-dark() picks the side from the
 *  root's color-scheme, so the system-theme fallback needs no copy of its own.
 *  Each side is that theme's `--system-red` at the alpha its `--accent-fill`
 *  already uses against `--accent`. */
const DANGER_FILL = '--danger-fill: light-dark(rgba(178,59,51,0.14), rgba(224,103,90,0.14));'

/** Everything from the opening of `selector` to the next block at the same
 *  nesting depth, so an assertion about one palette cannot be satisfied by a
 *  neighbour's declaration. */
function block(selector: string): string {
  const start = GLOBALS.indexOf(selector)
  expect(start, `${selector} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = GLOBALS.indexOf('{', start); i < GLOBALS.length; i++) {
    if (GLOBALS[i] === '{') depth++
    else if (GLOBALS[i] === '}' && --depth === 0) return GLOBALS.slice(start, i)
  }
  throw new Error(`unterminated block for ${selector}`)
}

describe('--danger-fill', () => {
  it('is declared once, for light and dark together', () => {
    expect(GLOBALS.split(DANGER_FILL)).toHaveLength(2)
    expect(GLOBALS.match(/--danger-fill:/g)).toHaveLength(1)
  })

  it('is the only source of the failed bubble colour — no hardcoded value in the rules', () => {
    const rule = block('.user-msg-bubble[data-send-state="failed"]')
    expect(rule).toContain('var(--danger-fill)')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})

describe('enter motion', () => {
  it.each([
    ['.user-msg-bubble[data-msg-enter]', 'jinn-msg-send-in', '--duration-base'],
    ['.assistant-transcript[data-msg-enter]', 'jinn-msg-receive-in', '--duration-slow'],
  ])('%s animates with a duration token, never a literal', (selector, keyframes, duration) => {
    const rule = block(selector)
    expect(rule).toContain(`animation: ${keyframes} var(${duration}) var(--ease-smooth) backwards`)
    expect(rule).not.toMatch(/\d+m?s/)
  })

  it('switches both enter animations off under reduced motion', () => {
    // Both end on the resting state, so `animation: none` is safe here — unlike
    // the view transitions at the top of the motion system, which must collapse
    // to the instant token instead or their snapshot never unfreezes.
    expect(GLOBALS).toContain(
      '@media (prefers-reduced-motion: reduce) {\n  .user-msg-bubble[data-msg-enter], .assistant-transcript[data-msg-enter] { animation: none; }\n}',
    )
  })

  it('enters the conversation title with a duration token and no literal', () => {
    const rule = block('[data-title-enter] {')
    expect(rule).toContain('animation: jinn-title-enter var(--duration-base) var(--ease-smooth)')
    expect(rule).not.toMatch(/\d+m?s/)
  })

  it('enters the title on opacity and transform alone', () => {
    // The mobile title sits in a fixed-height nav bar between the back control
    // and the compose button. Anything that changed its box would move both.
    const keyframes = block('@keyframes jinn-title-enter')
    expect(keyframes).not.toContain('filter')
    expect(keyframes).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding|font|inset|scale)\s*:/)
  })

  it('switches the title entrance off under reduced motion', () => {
    expect(GLOBALS).toContain(
      '@media (prefers-reduced-motion: reduce) {\n  [data-title-enter] { animation: none; }\n}',
    )
  })

  it('animates an arriving tool call with a duration token and no literal', () => {
    const rule = block('.tool-arrive {')
    expect(rule).toContain('animation: jinn-tool-rise var(--duration-base) var(--ease-smooth) backwards')
    // The `--arrive-delay` fallback is a stagger, not a duration, and matches
    // what every other arrival rule in this file already writes.
    expect(rule).not.toMatch(/animation:[^;]*\d+m?s/)
  })

  it('rises the tool call on transform and opacity alone', () => {
    // `filter` is not a compositor property: blurring a pill that sits in the
    // transcript repaints it every frame, which is the one thing the motion rule
    // rules out. The dispatch keyframe blurs; this one is that keyframe without it.
    expect(block('@keyframes jinn-tool-rise')).not.toContain('filter')
  })

  it('switches the tool-call entrance off under reduced motion', () => {
    expect(GLOBALS).toContain(
      '@media (prefers-reduced-motion: reduce) {\n  .tool-arrive { animation: none; }\n}',
    )
  })

  it('leaves the state transitions to the existing token block rather than a new rule', () => {
    // globals.css redefines --duration-fast|base|slow to --duration-instant under
    // reduced motion, so a transition authored with them collapses for free.
    const bubble = block('.user-msg-bubble {')
    expect(bubble).toContain('transition: opacity var(--duration-fast) var(--ease-smooth)')
    expect(bubble).not.toMatch(/\d+m?s/)
    expect(GLOBALS).not.toContain('.user-msg-bubble { transition: none')
  })
})
