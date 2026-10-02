import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { MultiChatGrid } from '../multi-chat-grid'
import { useChatPaneState, type SessionMeta } from '../use-chat-pane-state'

type MetaEmit = (update: { sessionId?: string; title?: string }) => void

// Every render's callback is kept, so a test can fire the one the pane was
// holding BEFORE its id moved — the real pane emits through a ref refreshed in
// an effect, which is always a flush behind the render that changed the id.
const emits: MetaEmit[] = []

vi.mock('@/components/chat/chat-pane', () => ({
  ChatPane: ({ sessionId, onSessionMetaChange }: { sessionId: string | null; onSessionMetaChange?: MetaEmit }) => {
    if (onSessionMetaChange) emits.push(onSessionMetaChange)
    return <output>{sessionId ?? 'new'}</output>
  },
}))

const noop = vi.fn()

/** One pane whose id can move without the pane remounting, wired to the real
 *  per-id meta store the header reads from. */
function Harness({ paneKey, sessionId, onState }: {
  paneKey: string
  sessionId: string | null
  onState: (metaById: Record<string, SessionMeta>) => void
}) {
  const paneState = useChatPaneState(sessionId, sessionId)
  onState(paneState.metaById)
  return (
    <MultiChatGrid
      sessionIds={sessionId ? [sessionId] : []}
      focusedId={sessionId}
      primary={{
        paneKey,
        sessionId,
        pendingUserMessage: undefined,
        initialEmployee: undefined,
        onSessionCreated: noop,
        viewMode: 'chat',
        focusTrigger: 0,
        delegatedActivity: undefined,
      }}
      viewport={{ width: 390, height: 844 }}
      metaById={paneState.metaById}
      sessionTitleFor={() => undefined}
      runtime={{ portalName: 'Gateway', subscribe: () => noop, events: [] }}
      scrollTopFor={() => undefined}
      viewModeFor={() => 'chat'}
      focusTriggerFor={() => 0}
      delegatedActivityFor={() => undefined}
      onFocus={noop}
      onRemove={noop}
      onMeta={paneState.updateMeta}
      onNewMeta={paneState.updateNewMeta}
      onPeek={noop}
      onNewChat={noop}
      onRefresh={noop}
      onContentReady={noop}
      onStartFreshChat={async () => {}}
    />
  )
}

function mount(paneKey: string, sessionId: string | null) {
  emits.length = 0
  let metaById: Record<string, SessionMeta> = {}
  const view = render(<Harness paneKey={paneKey} sessionId={sessionId} onState={(m) => { metaById = m }} />)
  return {
    move(nextSessionId: string | null) {
      view.rerender(<Harness paneKey={paneKey} sessionId={nextSessionId} onState={(m) => { metaById = m }} />)
    },
    /** Fire the callback the pane held at mount, not the current one. */
    emitFromMountClosure(update: { sessionId?: string; title?: string }) {
      act(() => { emits[0](update) })
    },
    get metaById() { return metaById },
  }
}

describe('session meta attribution', () => {
  it('files an emit under the id its payload names when the pane id moved', () => {
    const pane = mount('a', 'a')
    pane.emitFromMountClosure({ sessionId: 'a', title: 'Chat A' })
    pane.move('b')
    pane.emitFromMountClosure({ sessionId: 'b', title: 'Chat B' })

    expect(pane.metaById.b?.title).toBe('Chat B')
    expect(pane.metaById.a?.title).toBe('Chat A')
  })

  it('files an adopted composer session under its real id, not the composer slot', () => {
    // Composer adoption keeps `__new__:N:` as the pane key while the id flips
    // null → newId, so the pane never remounts (pane-identity.ts).
    const pane = mount('__new__:0:', null)
    pane.move('b')
    pane.emitFromMountClosure({ sessionId: 'b', title: 'Adopted chat' })

    expect(pane.metaById.b?.title).toBe('Adopted chat')
  })

  it('still falls back to the pane closure when a payload carries no id', () => {
    const pane = mount('a', 'a')
    pane.emitFromMountClosure({ title: 'Chat A' })

    expect(pane.metaById.a?.title).toBe('Chat A')
  })
})
