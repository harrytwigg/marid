import { describe, expect, it, vi } from 'vitest'
import { isNavLinkActive, openTodosFromLink } from '@/components/nav-surface'
import { navigationFor } from '@/lib/nav'
import { staticPagesFor } from '@/components/global-search'
import { searchDestination } from '@/components/global-search/static-pages'
import { TODOS_TAB_HREF } from '@/lib/todos-tab-entry'

describe('which nav item is current', () => {
  it('follows the path where the chat route says nothing', () => {
    expect(isNavLinkActive('/', '/', null)).toBe(true)
    expect(isNavLinkActive('/todos', '/todos/ACM-1', null)).toBe(true)
    expect(isNavLinkActive('/org', '/org', null)).toBe(true)
  })

  it('is Todos while the Todos tab is the focused one on the chat route, and Chat otherwise', () => {
    expect(isNavLinkActive('/todos', '/', 'todos')).toBe(true)
    expect(isNavLinkActive('/', '/', 'todos')).toBe(false)
    expect(isNavLinkActive('/', '/', 'chat')).toBe(true)
    expect(isNavLinkActive('/todos', '/', 'chat')).toBe(false)
  })

  it('leaves other pages to their path whatever the chat route showed last', () => {
    expect(isNavLinkActive('/org', '/org', 'todos')).toBe(true)
    expect(isNavLinkActive('/todos', '/org', 'todos')).toBe(false)
  })
})

describe('the Todos nav item', () => {
  it('opens the chat route\'s Todos tab on the rail and on the phone bar', () => {
    const { items, mobileItems } = navigationFor(false)
    expect(items.find((item) => item.href === '/todos')?.to).toBe(TODOS_TAB_HREF)
    expect(mobileItems.find((item) => item.href === '/todos')?.to).toBe(TODOS_TAB_HREF)
  })

  it('is the same destination in the command palette, whichever address the result carries', () => {
    expect(staticPagesFor(false).find((page) => page.label === 'Todos')?.href).toBe(TODOS_TAB_HREF)
    expect(searchDestination('/todos')).toBe(TODOS_TAB_HREF)
    expect(searchDestination('/todos/ACM-1')).toBe('/todos/ACM-1')
    expect(searchDestination('/org')).toBe('/org')
  })
})

describe('a click on the Todos link inside the chat page', () => {
  const click = (modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers, preventDefault: vi.fn(),
  })

  it('opens the tab in place instead of navigating', () => {
    const open = vi.fn()
    const event = click()
    openTodosFromLink(event, open)
    expect(open).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)('leaves a %s click to the link (a new browser tab)', (key) => {
    const open = vi.fn()
    const event = click({ [key]: true })
    openTodosFromLink(event, open)
    expect(open).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves the link to navigate on a page with no chat layout around it', () => {
    const event = click()
    openTodosFromLink(event, null)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
