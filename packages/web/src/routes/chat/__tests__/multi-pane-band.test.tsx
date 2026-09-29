import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installVirtualLayout, type VirtualLayout } from '@/test/virtual-layout'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

function openChatBeside() {
  const desktopNewChat = screen.getAllByRole('button', { name: 'New chat' })[0]
  const actionsPill = desktopNewChat.parentElement!
  fireEvent.click(within(actionsPill).getByRole('button', { name: 'More options' }))
  fireEvent.click(within(actionsPill).getByRole('button', { name: 'Open beside' }))
}

describe('the routed chat band', () => {
  let pickerLayout: VirtualLayout | null = null

  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a'],
      focusedId: 'a',
      focusHistory: ['a'],
    }))
    pickerLayout = installVirtualLayout(44, 360, {
      scroller: '[data-testid="session-picker-scroll"]',
      row: '[data-session-picker-row]',
      rowId: 'data-session-picker-row',
    })
  })

  afterEach(() => {
    pickerLayout?.release()
    pickerLayout = null
  })

  it('keeps the single-pane band but removes every desktop resident at two panes', async () => {
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const thread = document.querySelector('.chat-pills-layout')!
    const mobileNav = thread.querySelector('[data-chat-mobile-header]')
    expect(thread.querySelector('[data-chat-desktop-title]')).toBeTruthy()
    expect(thread.querySelector('[data-chat-desktop-actions]')).toBeTruthy()
    expect(thread.querySelector('[data-chat-top-scrim]')).toBeTruthy()
    expect(mobileNav).toBeTruthy()

    openChatBeside()

    await waitFor(() => expect(document.querySelectorAll('[data-chat-grid-pane]')).toHaveLength(2))
    expect(thread.querySelector('[data-chat-desktop-title]')).toBeNull()
    expect(thread.querySelector('[data-chat-desktop-actions]')).toBeNull()
    expect(thread.querySelector('[data-chat-top-scrim]')).toBeNull()
    expect(thread.querySelector('[data-chat-mobile-header]')).toBe(mobileNav)
  })

  it('asks a CLI or terminal view to clear the floating header only while that header is drawn (JIN-2)', async () => {
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const thread = document.querySelector<HTMLElement>('.chat-pills-layout')!
    const rule = [...document.querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n')
    // The inset is built from the transcript's clearance + band and the scrim's
    // own height — the tokens that draw them, not a second set of numbers.
    expect(rule.replace(/\s+/g, ' ')).toContain(
      '.chat-pills-layout[data-floating-header] { --cli-terminal-top-inset: max(calc(var(--chat-top-clearance) + var(--chat-header-band)), var(--chat-top-scrim)); }',
    )
    expect(thread.querySelector('[data-chat-top-scrim]')!.className).toContain('h-[var(--chat-top-scrim)]')
    expect(thread.hasAttribute('data-floating-header')).toBe(true)

    openChatBeside()

    // Two panes: no pills, no scrim, and each pane's own title bar is in flow.
    await waitFor(() => expect(document.querySelectorAll('[data-chat-grid-pane]')).toHaveLength(2))
    expect(thread.querySelector('[data-chat-top-scrim]')).toBeNull()
    expect(thread.hasAttribute('data-floating-header')).toBe(false)
  })
})
