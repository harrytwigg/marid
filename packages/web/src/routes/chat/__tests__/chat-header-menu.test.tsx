import '@/test/preload-menus'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatHeaderMenu } from '../chat-header-menu'
import { installPlatform } from '@/platform'
import { createPlatform, type Runtime } from '@/platform/contracts'
import { createTestAdapter, type TestAdapter } from '@/platform/adapters/test'

const pinState = vi.hoisted(() => ({
  keys: new Set<string>(),
  mutate: vi.fn(),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: pinState.keys }),
  useTogglePin: () => ({ mutate: pinState.mutate }),
}))

const SESSION_ID = 'session-1'

const runtime: Runtime = {
  container: 'browser',
  os: 'unknown',
  engine: 'unknown',
  secureContext: true,
  appVersion: 'test',
  userAgent: 'chat-header-menu-test',
}

let platform: TestAdapter
let restorePlatform: () => void

function renderMenu(overrides: Partial<Parameters<typeof ChatHeaderMenu>[0]> = {}) {
  return render(
    <ChatHeaderMenu
      open
      onOpenChange={vi.fn()}
      selectedId={SESSION_ID}
      sessionMeta={{ engine: 'claude' }}
      openGlobalSearch={vi.fn()}
      effectiveViewMode="chat"
      cliModeAvailable
      viewSwitchLocked={false}
      cliTitle={undefined}
      setAndPersistViewMode={vi.fn()}
      onDuplicate={vi.fn()}
      duplicatePending={false}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onCopyToClipboard={vi.fn()}
      onShareDebugLog={vi.fn()}
      onClearDebugLog={vi.fn()}
      onDeleteSession={vi.fn()}
      onOpenChatBeside={vi.fn()}
      onCloseAllTabs={vi.fn()}
      closeAllTabsDisabled={false}
      {...overrides}
    />,
  )
}

function itemLabels() {
  const menu = screen.getByRole('menu')
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button')).map((item) => item.textContent?.trim())
}

beforeEach(() => {
  pinState.keys = new Set<string>()
  pinState.mutate = vi.fn()
  platform = createTestAdapter({ results: { 'navigation.open-external': { status: 'performed' } } })
  restorePlatform = installPlatform(createPlatform({ runtime, adapters: [platform] }))
})

afterEach(() => {
  restorePlatform()
})

describe('ChatHeaderMenu', () => {
  it('closes every tab from the menu, and greys the item when nothing is open', () => {
    const onCloseAllTabs = vi.fn()
    renderMenu({ onCloseAllTabs })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close all tabs' }))
    expect(onCloseAllTabs).toHaveBeenCalledTimes(1)
  })

  it('disables Close all tabs when no tab is open', () => {
    const onCloseAllTabs = vi.fn()
    renderMenu({ onCloseAllTabs, closeAllTabsDisabled: true })

    const item = screen.getByRole('menuitem', { name: 'Close all tabs' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item)
    expect(onCloseAllTabs).not.toHaveBeenCalled()
  })

  it('renders Pin directly above Duplicate and pins the selected session', () => {
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChange })

    const labels = itemLabels()
    expect(labels.indexOf('Pin')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Pin')).toBe(labels.indexOf('Duplicate...') - 1)

    fireEvent.click(screen.getByText('Pin'))
    expect(pinState.mutate).toHaveBeenCalledWith({ key: SESSION_ID, pinned: true })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reads Unpin and unpins when the session is already pinned', () => {
    pinState.keys = new Set([SESSION_ID])
    renderMenu()

    expect(screen.queryByText('Pin')).toBeNull()
    fireEvent.click(screen.getByText('Unpin'))
    expect(pinState.mutate).toHaveBeenCalledWith({ key: SESSION_ID, pinned: false })
  })

  it('renders no pin item without a selected session, like Duplicate and Archive', () => {
    renderMenu({ selectedId: null })

    expect(screen.queryByText('Pin')).toBeNull()
    expect(screen.queryByText('Unpin')).toBeNull()
    expect(screen.queryByText('Duplicate...')).toBeNull()
    expect(screen.queryByText('Archive chat')).toBeNull()
    expect(screen.queryByText('Open in new tab')).toBeNull()
  })

  it('opens a picker pane beside the current chat and closes the menu', () => {
    const onOpenChatBeside = vi.fn()
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChatBeside, onOpenChange })

    const labels = itemLabels()
    expect(labels.indexOf('Open beside')).toBe(labels.indexOf('CLI') + 1)
    expect(labels.indexOf('Close all tabs')).toBe(labels.indexOf('Open beside') + 1)
    expect(labels.indexOf('Open in new tab')).toBe(labels.indexOf('Close all tabs') + 1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open beside' }))

    expect(onOpenChatBeside).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the selected chat in its own tab through the platform and closes the menu', async () => {
    const onOpenChange = vi.fn()
    renderMenu({ onOpenChange })

    const labels = itemLabels()
    expect(labels.indexOf('Open in new tab')).toBe(labels.indexOf('Close all tabs') + 1)
    expect(labels.indexOf('Open in new tab')).toBe(labels.indexOf('Pin') - 1)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new tab' }))

    await waitFor(() => expect(platform.calls).toHaveLength(1))
    const [intent] = platform.calls
    expect(intent.kind).toBe('navigation.open-external')
    const target = new URL((intent as Extract<typeof intent, { kind: 'navigation.open-external' }>).url)
    expect(`${target.pathname}${target.search}`).toBe(`/?session=${encodeURIComponent(SESSION_ID)}`)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
  it('switches to the CLI view and closes the menu', () => {
    const setAndPersistViewMode = vi.fn()
    const onOpenChange = vi.fn()
    renderMenu({ setAndPersistViewMode, onOpenChange })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'CLI' }))
    expect(setAndPersistViewMode).toHaveBeenCalledWith('cli')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('leaves the view alone while a switch is locked', () => {
    const setAndPersistViewMode = vi.fn()
    renderMenu({ setAndPersistViewMode, viewSwitchLocked: true, cliTitle: 'Locked for now' })

    expect(screen.getByRole('menuitemradio', { name: 'CLI' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Chat' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'CLI' }))
    expect(setAndPersistViewMode).not.toHaveBeenCalled()
  })

  // A disabled item takes no pointer events, so its title tooltip never shows: the reason has to be on the page.
  it('says in the menu why the view switch is locked or the CLI is unavailable', () => {
    const { unmount } = renderMenu({ viewSwitchLocked: true, cliTitle: 'Muse Code view switching is locked while a turn is running' })
    expect(screen.getByTestId('view-mode-reason').textContent).toBe('Muse Code view switching is locked while a turn is running')
    unmount()

    const unavailable = renderMenu({ cliModeAvailable: false, cliTitle: 'CLI view is not available for this engine' })
    expect(screen.getByTestId('view-mode-reason').textContent).toBe('CLI view is not available for this engine')
    unavailable.unmount()

    renderMenu()
    expect(screen.queryByTestId('view-mode-reason')).toBeNull()
  })

  it('archives, or unarchives an archived chat', () => {
    const onArchive = vi.fn()
    const onUnarchive = vi.fn()
    const { unmount } = renderMenu({ onArchive, onUnarchive })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }))
    expect(onArchive).toHaveBeenCalledWith(SESSION_ID)
    unmount()

    renderMenu({ onArchive, onUnarchive, sessionMeta: { engine: 'claude', archivedAt: '2026-01-01T00:00:00Z' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive chat' }))
    expect(onUnarchive).toHaveBeenCalledWith(SESSION_ID)
  })

  it('deletes only after the confirmation, and offers the engine resume command when there is one', () => {
    const onDeleteSession = vi.fn()
    const onCopyToClipboard = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderMenu({ onDeleteSession, onCopyToClipboard, sessionMeta: { engine: 'codex', engineSessionId: 'engine-1' } })

    fireEvent.click(screen.getByRole('menuitem', { name: /Delete Session/ }))
    expect(onDeleteSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete Session/ }))
    expect(onDeleteSession).toHaveBeenCalledWith(SESSION_ID)
    expect(confirm).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy CLI Resume Command' }))
    expect(onCopyToClipboard).toHaveBeenCalledWith('codex --resume engine-1', 'cli')
    confirm.mockRestore()
  })

  it('does not place a popup against a hidden copy of the trigger', () => {
    render(
      <div style={{ display: 'none' }}>
        <ChatHeaderMenu
          open
          onOpenChange={vi.fn()}
          selectedId={SESSION_ID}
          sessionMeta={null}
          openGlobalSearch={vi.fn()}
          effectiveViewMode="chat"
          cliModeAvailable
          viewSwitchLocked={false}
          cliTitle={undefined}
          setAndPersistViewMode={vi.fn()}
          onDuplicate={vi.fn()}
          duplicatePending={false}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
          onCopyToClipboard={vi.fn()}
          onShareDebugLog={vi.fn()}
          onClearDebugLog={vi.fn()}
          onDeleteSession={vi.fn()}
          onOpenChatBeside={vi.fn()}
          onCloseAllTabs={vi.fn()}
          closeAllTabsDisabled={false}
        />
      </div>,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
