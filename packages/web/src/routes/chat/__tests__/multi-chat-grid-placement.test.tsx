import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { deriveChatGridIds, MultiChatGrid } from '../multi-chat-grid'

vi.mock('@/components/chat/chat-pane', () => ({
  ChatPane: ({ sessionId }: { sessionId: string | null }) => <output>{sessionId ?? 'new'}</output>,
}))

describe('chat grid placement', () => {
  it.each([
    {
      name: 'primary only', sessionIds: ['a'], primaryPaneKey: 'primary', primarySessionId: 'a',
      expected: ['primary'],
    },
    {
      name: 'picker open', sessionIds: ['a'], primaryPaneKey: 'primary', primarySessionId: 'a',
      pickerPaneKey: 'picker', expected: ['primary', 'picker'],
    },
    {
      name: 'picker and sessions', sessionIds: ['a', 'b'], primaryPaneKey: 'primary', primarySessionId: 'a',
      pickerPaneKey: 'picker', expected: ['primary', 'b', 'picker'],
    },
    {
      name: 'sessionless primary and picker', sessionIds: ['a', 'b'], primaryPaneKey: 'composer', primarySessionId: null,
      pickerPaneKey: 'picker', expected: ['a', 'b', 'composer', 'picker'],
    },
  ])('matches the panes MultiChatGrid renders for $name', (input) => {
    const noop = vi.fn()
    const pickerPane = input.pickerPaneKey ? {
      paneKey: input.pickerPaneKey,
      onPick: noop,
      onSessionCreated: noop,
      onClose: noop,
    } : undefined
    const view = render(
      <MultiChatGrid
        sessionIds={input.sessionIds}
        focusedId={input.primarySessionId}
        primary={{
          paneKey: input.primaryPaneKey,
          sessionId: input.primarySessionId,
          pendingUserMessage: undefined,
          initialEmployee: undefined,
          onSessionCreated: noop,
          viewMode: 'chat',
          focusTrigger: 0,
          delegatedActivity: undefined,
        }}
        viewport={{ width: 1440, height: 900 }}
        metaById={{}}
        sessionTitleFor={() => undefined}
        runtime={{ portalName: 'Gateway', subscribe: () => noop, events: [] }}
        scrollTopFor={() => undefined}
        viewModeFor={() => 'chat'}
        focusTriggerFor={() => 0}
        delegatedActivityFor={() => undefined}
        onFocus={noop}
        onRemove={noop}
        onMeta={noop}
        onNewMeta={noop}
        onPeek={noop}
        onNewChat={noop}
        onRefresh={noop}
        onContentReady={noop}
        onStartFreshChat={async () => {}}
        pickerPane={pickerPane}
      />,
    )

    const derived = deriveChatGridIds(input)
    const rendered = Array.from(view.container.querySelectorAll('[data-chat-grid-pane]'), (pane) => (
      pane.getAttribute('data-chat-grid-pane')
    ))
    expect(derived).toEqual(input.expected)
    expect(rendered).toEqual(derived)
    view.unmount()
  })
})
