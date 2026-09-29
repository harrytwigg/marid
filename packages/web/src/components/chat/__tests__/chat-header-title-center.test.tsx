import { type ReactNode } from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'

import { ChatHeaderPills } from '../chat-tabs'

// The mobile nav bar centres its title on the HEADER, not on the gap between the
// controls, by locking both side tracks to the width of the wider cluster. jsdom
// does no layout, so the pixels are checked in the browser; what is assertable
// here is the rule that produces them — feed the two clusters different widths
// and read back the grid template the component derives from them.

const ACTIONS_WIDTH = 72
const BARE_BACK_WIDTH = 36
const LABELLED_BACK_WIDTH = 132

// Stand in for layout: the back control reports `backWidth`, the actions cluster
// (identified by the compose button it wraps, not by the classes under test)
// reports `actionWidth`, everything else zero.
function stubClusterWidths(backWidth: number, actionWidth = ACTIONS_WIDTH) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches('button[aria-label^="Back to"]')) return backWidth
      if (this.querySelector(':scope > button[aria-label="New chat"]')) return actionWidth
      return 0
    },
  })
  return () => Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original)
}

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length) restores.pop()!()
})

function renderNavBar(props: {
  backWidth: number
  title: string
  backTo?: string
  mobileWorkingSet?: boolean | ReactNode
  actionWidth?: number
}) {
  restores.push(stubClusterWidths(props.backWidth, props.actionWidth ?? ACTIONS_WIDTH))
  const workingSet = props.mobileWorkingSet === true
    ? <div>Working set</div>
    : props.mobileWorkingSet || undefined
  const { container } = render(
    <ChatHeaderPills
      title={props.title}
      onBack={vi.fn()}
      onNew={vi.fn()}
      backTo={props.backTo ? { label: props.backTo, onClick: vi.fn() } : undefined}
      mobileWorkingSet={workingSet}
    />,
  )
  const bar = container.querySelector<HTMLElement>('.lg\\:hidden')
  if (!bar?.firstElementChild) throw new Error('mobile chat nav bar did not render')
  return bar.firstElementChild as HTMLElement
}

function sideTracks(row: HTMLElement): [string, string] {
  const template = row.style.gridTemplateColumns
  const tracks = template.match(/^(\S+)\s+minmax\(0,\s*1fr\)\s+(\S+)$/)
  if (!tracks) throw new Error(`nav bar is not a centred 3-track grid: "${template}"`)
  return [tracks[1], tracks[2]]
}

describe('mobile chat header title centring', () => {
  it('reserves the actions cluster width on both sides of a bare chevron back', () => {
    const row = renderNavBar({ backWidth: BARE_BACK_WIDTH, title: 'Standup' })
    expect(sideTracks(row)).toEqual([`${ACTIONS_WIDTH}px`, `${ACTIONS_WIDTH}px`])
  })

  it('reserves the back control width on both sides when it is the wider cluster', () => {
    const row = renderNavBar({
      backWidth: LABELLED_BACK_WIDTH,
      title: 'Quarterly infrastructure migration planning and rollout review',
      backTo: 'Growth planning thread',
    })
    expect(sideTracks(row)).toEqual([`${LABELLED_BACK_WIDTH}px`, `${LABELLED_BACK_WIDTH}px`])
  })

  it('pins each cluster to its outer edge so the tracks stay content-measurable', () => {
    const row = renderNavBar({ backWidth: BARE_BACK_WIDTH, title: 'Standup' })
    const [back, title, actions] = Array.from(row.children) as HTMLElement[]
    expect(back.className).toContain('justify-self-start')
    expect(actions.className).toContain('justify-self-end')
    expect(title.textContent).toBe('Standup')
    expect(title.className).toContain('truncate')
    expect(title.className).toContain('min-w-0')
    expect(title.className).toContain('text-center')
  })

  it('keeps the title in the middle track and puts the session tabs in their own row under the bar', () => {
    const row = renderNavBar({ backWidth: BARE_BACK_WIDTH, title: 'Standup', mobileWorkingSet: true })
    expect(sideTracks(row)).toEqual([`${ACTIONS_WIDTH}px`, `${ACTIONS_WIDTH}px`])
    expect((row.children[1] as HTMLElement).textContent).toBe('Standup')
    expect(row.querySelector('[data-mobile-session-tabs-row]')).toBeNull()

    const tabsRow = row.nextElementSibling as HTMLElement
    expect(tabsRow.hasAttribute('data-mobile-session-tabs-row')).toBe(true)
    expect(tabsRow.textContent).toBe('Working set')
  })

  it('renders no tabs row without a strip', () => {
    const row = renderNavBar({ backWidth: BARE_BACK_WIDTH, title: 'Standup' })
    expect(row.nextElementSibling).toBeNull()
  })

  it('caps a labelled back control the same with or without the tabs row', () => {
    const back = (mobileWorkingSet: boolean) => (renderNavBar({
      backWidth: LABELLED_BACK_WIDTH,
      title: 'Quarterly infrastructure migration planning and rollout review',
      backTo: 'Parent',
      mobileWorkingSet,
    }).firstElementChild as HTMLElement).className

    expect(back(true)).toContain('max-w-[34vw]')
    expect(back(false)).toContain('max-w-[34vw]')
  })
})
