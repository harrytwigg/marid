import { describe, expect, it, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { ChatHeaderPills } from '../chat-tabs'

const noop = () => {}
const entering = (container: HTMLElement) => container.querySelectorAll('[data-title-enter]')

function header(title: string) {
  return <ChatHeaderPills title={title} onNew={noop} onBack={noop} />
}

/** The session tabs take their own row; the centred title stays. */
function headerWithTabs(title: string) {
  return <ChatHeaderPills title={title} onNew={noop} onBack={noop} mobileWorkingSet={<nav />} />
}

describe('chat title entrance', () => {
  const realMatchMedia = window.matchMedia
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: realMatchMedia, writable: true, configurable: true })
  })

  it('leaves the title a header opens with unmarked', () => {
    const { container } = render(header('Release plan'))
    expect(entering(container)).toHaveLength(0)
  })

  it('leaves a rerender that changes nothing unmarked', () => {
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Release plan'))
    expect(entering(container)).toHaveLength(0)
  })

  it('marks the nav-bar title when the conversation changes under it', () => {
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Weekly digest'))
    const marked = entering(container)
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toBe('Weekly digest')
  })

  it('leaves the desktop title alone', () => {
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Weekly digest'))
    // Both breakpoints render into jsdom; only the centred nav-bar title, which
    // has no desktop equivalent to reflow, carries the mark.
    expect(entering(container)).toHaveLength(1)
    expect(container.querySelectorAll('.truncate[data-title-enter]')).toHaveLength(1)
  })

  it('does not replay an entrance the reader already watched, on remount', () => {
    const first = render(header('Release plan'))
    first.rerender(header('Weekly digest'))
    expect(entering(first.container)).toHaveLength(1)
    first.unmount()

    const second = render(header('Weekly digest'))
    expect(entering(second.container)).toHaveLength(0)
  })

  it('still animates a title change while the session tabs are up, since the title never leaves the bar', () => {
    const { container, rerender } = render(headerWithTabs('Release plan'))
    rerender(headerWithTabs('Weekly digest'))
    expect(entering(container)).toHaveLength(1)
  })

  it('marks nothing under reduced motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true, configurable: true,
      value: (media: string) => ({
        matches: true, media,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
        onchange: null, dispatchEvent: () => false,
      }),
    })
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Weekly digest'))
    expect(entering(container)).toHaveLength(0)
  })
})
