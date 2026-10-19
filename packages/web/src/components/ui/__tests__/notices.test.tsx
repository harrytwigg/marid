import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNoticeSink, raiseNotice } from '@/lib/notices'
import { clearHostBridge, hostNotificationSink } from '@/plugins/sdk/host-bridge'
import { Notices } from '../notices'

function pluginNotice(title: string) {
  hostNotificationSink()!({ title, level: 'info' })
}

beforeEach(() => {
  clearNoticeSink()
  clearHostBridge()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Notices', () => {
  it('shows an app notice with its level and description', () => {
    render(<Notices />)

    act(() => raiseNotice({ title: 'The dialog couldn’t load.', description: 'Reload the page.', level: 'error' }))

    expect(screen.getByRole('status').textContent).toContain('The dialog couldn’t load.')
    expect(screen.getByRole('status').textContent).toContain('Reload the page.')
  })

  it('shows app and plugin notices in the one stack', () => {
    render(<Notices />)

    act(() => {
      raiseNotice({ title: 'from the app', level: 'error' })
      pluginNotice('from a plugin')
    })

    const stacks = document.querySelectorAll('[data-notices]')
    expect(stacks).toHaveLength(1)
    expect(stacks[0]!.textContent).toContain('from the app')
    expect(stacks[0]!.textContent).toContain('from a plugin')
  })

  it('does not let a plugin flood push an app notice off the screen', () => {
    render(<Notices />)
    act(() => raiseNotice({ title: 'the app is telling you something', level: 'error' }))

    act(() => {
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) pluginNotice(`plugin ${n}`)
    })

    expect(screen.getByText('the app is telling you something')).not.toBeNull()
    expect(screen.queryByText('plugin 5')).toBeNull()
    expect(screen.getByText('plugin 8')).not.toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(4)
  })

  it('keeps only the newest few app notices, as it does for plugins', () => {
    render(<Notices />)

    act(() => {
      for (const n of [1, 2, 3, 4]) raiseNotice({ title: `app ${n}` })
    })

    expect(screen.queryByText('app 1')).toBeNull()
    expect(screen.getByText('app 4')).not.toBeNull()
  })

  it('clears a notice once its reading time is up, and when it is dismissed', async () => {
    vi.useFakeTimers()
    render(<Notices />)
    act(() => raiseNotice({ title: 'transient' }))

    act(() => void vi.advanceTimersByTime(6_000))

    expect(screen.queryByText('transient')).toBeNull()

    vi.useRealTimers()
    act(() => raiseNotice({ title: 'read me' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByText('read me')).toBeNull()
  })
})

describe('raiseNotice', () => {
  it('says it in the console when no surface is mounted, instead of dropping it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    raiseNotice({ title: 'nobody is listening', level: 'warning' })

    expect(warn).toHaveBeenCalledWith('[notice] warning: nobody is listening')
  })
})
