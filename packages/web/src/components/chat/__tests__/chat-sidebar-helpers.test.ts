import { describe, expect, it } from 'vitest'
import { isFocusedSession } from '../chat-route-helpers'
import { isDirectSession, isVisibleSource, pickDeleteFallbackId, pickNeighborSessionId, resolveRowIdentity, shouldFloatPinned } from '../chat-sidebar'

describe('chat sidebar grouping helpers', () => {
  it('treats only employee-less, non-cron sessions as direct', () => {
    expect(isDirectSession({ source: 'web', sourceRef: 'web:1' })).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:2', employee: 'jinn' })).toBe(false)
    expect(isDirectSession({ source: 'cron', sourceRef: 'cron:daily' })).toBe(false)
    expect(isDirectSession({ source: 'web', sourceRef: 'cron:daily' })).toBe(false)
  })

  it('treats a session tagged with the portal slug as direct (case-insensitive)', () => {
    // ~30 child sessions were created with employee === portal slug; there is no
    // org employee by that name, so they must bucket into the direct/COO group
    // rather than spawn a phantom duplicate group.
    expect(isDirectSession({ source: 'web', sourceRef: 'web:3', employee: 'jimbo' }, 'jimbo')).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:4', employee: 'Jimbo' }, 'jimbo')).toBe(true)
    // a real org employee is never folded into direct
    expect(isDirectSession({ source: 'web', sourceRef: 'web:5', employee: 'jinn' }, 'jimbo')).toBe(false)
    // a portal-slug row is still a separate group when no slug is supplied
    expect(isDirectSession({ source: 'web', sourceRef: 'web:6', employee: 'jimbo' })).toBe(false)
  })
})

describe('historical Talk sessions in generic chat discovery', () => {
  it('keeps Talk provenance visible through the shared sidebar and search source gate', () => {
    const historical = { id: 'legacy-talk', source: 'talk' }
    const sidebarRows = [historical].filter(isVisibleSource)
    const searchRows = [historical].filter(isVisibleSource)

    expect(sidebarRows.map((session) => session.id)).toEqual(['legacy-talk'])
    expect(searchRows.map((session) => session.id)).toEqual(['legacy-talk'])
  })
})

describe('historical workflow sessions in the chat sidebar', () => {
  it('keeps workflow sessions visible under their employee group and out of direct/focused lanes', () => {
    const session = {
      source: 'workflow',
      sourceRef: 'workflow:daily-report:run-42:writer:1',
      employee: 'writer',
    }

    expect(isVisibleSource(session)).toBe(true)
    expect(isDirectSession(session, 'jimbo')).toBe(false)
    expect(isFocusedSession(session)).toBe(false)
  })
})

describe('plugin-spawned sessions in the chat sidebar', () => {
  // Regression: plugin spawns (host.sessions.spawn) are stamped source "plugin";
  // the sidebar's source gate omitted it, so those chats never rendered — and a
  // pin on one stayed invisible too, since pinned rows only float within the
  // already-visible set.
  const pluginSession = { id: 'life-genie', source: 'plugin', sourceRef: 'plugin:life:09f8059ad0ba' }

  it('renders a plugin session in the sidebar list and in search results', () => {
    expect(isVisibleSource(pluginSession)).toBe(true)
    expect([pluginSession].filter(isVisibleSource).map((s) => s.id)).toEqual(['life-genie'])
  })

  it('floats a pinned plugin session to the Pinned section', () => {
    expect(shouldFloatPinned(pluginSession, new Set(['life-genie']))).toBe(true)
    expect(shouldFloatPinned(pluginSession, new Set())).toBe(false)
  })

  it('gives an employee-less plugin session the portal identity', () => {
    // Plugin spawns carry no employee, so they belong in the direct/COO lane
    // and must resolve to the portal identity rather than a phantom group.
    expect(isDirectSession(pluginSession, 'jimbo')).toBe(true)
    expect(
      resolveRowIdentity(pluginSession, {
        portalSlug: 'jimbo',
        portalName: 'Jimbo',
        employeeData: new Map(),
      }),
    ).toEqual({ avatarName: 'jimbo', displayName: 'Jimbo' })
  })
})

describe('chat sidebar search row identity', () => {
  const opts = {
    portalSlug: 'jimbo',
    portalName: 'Jimbo',
    employeeData: new Map([
      [
        'jinn',
        {
          name: 'jinn',
          displayName: 'Jinn Dev',
          department: 'platform',
          rank: 'employee' as const,
          engine: 'claude',
          model: 'opus',
          persona: '',
        },
      ],
    ]),
  }

  // The API types employee as `string | null`, but the local Session interface
  // narrows it to `string | undefined`; the server can still send null at
  // runtime. Cast to reproduce that real-world shape in the test.
  const cron = { source: 'cron', sourceRef: 'cron:nightly', employee: null } as unknown as Parameters<
    typeof resolveRowIdentity
  >[0]

  // Regression: search flattens cron rows (which the grouped view renders in a
  // separate cron section). isDirectSession returns false for cron sessions, so
  // the old `s.employee!` assertion fed `null` to titleCase → `null.split('-')`
  // → "Cannot read properties of null (reading 'split')". Must not throw.
  it('does not crash on a cron session with a null employee', () => {
    expect(() => resolveRowIdentity(cron, opts)).not.toThrow()
    expect(resolveRowIdentity(cron, opts)).toEqual({ avatarName: 'jimbo', displayName: 'Jimbo' })
  })

  it('does not crash on a session with an undefined employee', () => {
    expect(() => resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).not.toThrow()
    expect(resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).toEqual({
      avatarName: 'jimbo',
      displayName: 'Jimbo',
    })
  })

  it('resolves a real employee to its org display name', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:2', employee: 'jinn' }, opts),
    ).toEqual({ avatarName: 'jinn', displayName: 'Jinn Dev' })
  })

  it('title-cases an employee with no org profile rather than crashing', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:3', employee: 'magic-switch-lead' }, opts),
    ).toEqual({ avatarName: 'magic-switch-lead', displayName: 'Magic Switch Lead' })
  })
})

describe('chat sidebar pinned floating', () => {
  it('floats pinned non-cron sessions to the Pinned section', () => {
    const pinned = new Set(['s1'])
    expect(shouldFloatPinned({ id: 's1', source: 'web', sourceRef: 'web:1' }, pinned)).toBe(true)
  })

  it('leaves unpinned sessions in their recency buckets', () => {
    const pinned = new Set(['s1'])
    expect(shouldFloatPinned({ id: 's2', source: 'web', sourceRef: 'web:2' }, pinned)).toBe(false)
    expect(shouldFloatPinned({ id: 's3', source: 'web', sourceRef: 'web:3' }, new Set())).toBe(false)
  })

  it('floats pinned cron sessions too — the sidebar no longer paginates a Scheduled group', () => {
    const pinned = new Set(['c1', 'c2'])
    expect(shouldFloatPinned({ id: 'c1', source: 'cron', sourceRef: 'cron:daily' }, pinned)).toBe(true)
    expect(shouldFloatPinned({ id: 'c2', source: 'web', sourceRef: 'cron:daily' }, pinned)).toBe(true)
    expect(shouldFloatPinned({ id: 'c3', source: 'cron', sourceRef: 'cron:daily' }, new Set())).toBe(false)
  })
})

describe('pickNeighborSessionId (post-delete fallback)', () => {
  it('prefers the next visible session, then the previous', () => {
    expect(pickNeighborSessionId(['a', 'b', 'c'], 'b')).toBe('c')
    expect(pickNeighborSessionId(['a', 'b', 'c'], 'c')).toBe('b')
    expect(pickNeighborSessionId(['a', 'b', 'c'], 'a')).toBe('b')
  })

  it('returns null when the list is a singleton or the id is not visible', () => {
    expect(pickNeighborSessionId(['only'], 'only')).toBeNull()
    expect(pickNeighborSessionId(['a', 'b'], 'zzz')).toBeNull()
    expect(pickNeighborSessionId([], 'a')).toBeNull()
  })
})

describe('pickDeleteFallbackId (the ONE post-delete fallback decision)', () => {
  it('prefers the visible-order neighbour', () => {
    expect(pickDeleteFallbackId(['a', 'b', 'c'], ['z', 'a', 'b', 'c'], 'b')).toBe('c')
    expect(pickDeleteFallbackId(['a', 'b', 'c'], ['z'], 'c')).toBe('b')
  })

  it('falls back to the most recent OTHER session when the deleted id is not in the visible order (collapsed Older group)', () => {
    expect(pickDeleteFallbackId(['a', 'b'], ['hidden-1', 'hidden-2'], 'hidden-1')).toBe('hidden-2')
    expect(pickDeleteFallbackId(['a', 'b'], ['hidden-1', 'a', 'b'], 'hidden-1')).toBe('a')
    // deleted first in recency: skip itself
    expect(pickDeleteFallbackId([], ['x', 'y'], 'x')).toBe('y')
  })

  it('returns null only when no other session exists (composer)', () => {
    expect(pickDeleteFallbackId(['only'], ['only'], 'only')).toBeNull()
    expect(pickDeleteFallbackId([], [], 'gone')).toBeNull()
    expect(pickDeleteFallbackId([], ['gone'], 'gone')).toBeNull()
  })
})
