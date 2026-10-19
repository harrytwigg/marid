import { describe, expect, it } from 'vitest'

import { composerCardPresentation } from '../chat-composer-presentation'

// The glass composer (glass-identity.css) styles the card by class, and the loading ring is a class too,
// not an inline box-shadow, so the float rules and the ring can be ordered against each other in CSS.
describe('composerCardPresentation', () => {
  it('marks only an active, loading card as loading', () => {
    expect(composerCardPresentation(true, true).className).toContain('composer-card-loading')
    expect(composerCardPresentation(true, false).className).not.toContain('composer-card-loading')
    expect(composerCardPresentation(false, true).className).not.toContain('composer-card-loading')
  })

  it('sets no inline style, so nothing outranks the stylesheet', () => {
    for (const [active, loading] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      expect(composerCardPresentation(active, loading).style).toBeUndefined()
    }
  })

  it('keeps the active class that carries the resting shadow', () => {
    expect(composerCardPresentation(true, false).className).toContain('composer-card-active')
    expect(composerCardPresentation(false, false).className).not.toContain('composer-card-active')
  })
})
