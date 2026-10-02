import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_HOST_VERBS, PluginHostDeniedError, type PluginHostVerb } from '../host-permissions'
import { registerHostNotificationSink, clearHostBridge } from '../host-bridge'

/**
 * The permission seam, proved by denying one verb at a time.
 *
 * The gate is mocked rather than configured because v1 ships no denial policy —
 * the seam is the deliverable, not the policy. Mocking it is also what makes
 * this test load-bearing: a verb that never called the gate would sail straight
 * through its own denial, and the expectation below would fail. That is the
 * property under test, not the throw itself.
 */
const denied = vi.hoisted(() => ({ verb: null as string | null }))

vi.mock('../host-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-permissions')>()
  return {
    ...actual,
    assertVerbAllowed: (verb: PluginHostVerb) => {
      if (verb === denied.verb) throw new actual.PluginHostDeniedError(verb)
      actual.assertVerbAllowed(verb)
    },
  }
})

// After the mock, so `host` is built against the gate the mock installed.
const { host } = await import('../host')

/** One call per verb, so every verb in the union is exercised by name. */
const CALL: Record<PluginHostVerb, () => unknown> = {
  'todos.list': () => host.todos.list(),
  'todos.create': () => host.todos.create({ title: 'a todo' }),
  'todos.comment': () => host.todos.comment('AAA-1', 'noted'),
  'sessions.spawn': () => host.sessions.spawn({ prompt: 'draft a reply' }),
  'employees.list': () => host.employees.list(),
  notify: () => host.notify('something happened'),
  'notes.list': () => host.notes.list(),
  'notes.read': () => host.notes.read('knowledge/a.md'),
  'notes.create': () => host.notes.create({ title: 'a note', body: 'a body' }),
  'connectors.send': () => host.connectors.send('slack', { channel: 'C1', text: 'hello' }),
  'cron.jobs': () => host.cron.jobs(),
  'cron.runs': () => host.cron.runs('digest'),
  'knowledge.search': () => host.knowledge.search('kestrel'),
}

beforeEach(() => {
  denied.verb = null
  clearHostBridge()
  registerHostNotificationSink(() => {})
  // One body carrying every envelope, so whichever verb is under test finds the
  // key it unwraps. The cron routes answer a bare array, so they get one.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        json: async () =>
          url.includes('/api/cron')
            ? []
            : {
                workItems: [],
                workItem: {},
                comment: {},
                employees: [],
                items: [],
                notes: [],
                note: {},
                results: [],
                status: 'sent',
              },
      } as unknown as Response),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearHostBridge()
})

describe('denying one verb', () => {
  it.each(PLUGIN_HOST_VERBS)('refuses %s and leaves the other twelve working', async (target) => {
    denied.verb = target

    for (const verb of PLUGIN_HOST_VERBS) {
      const attempt = () => CALL[verb]()
      if (verb === target) {
        await expect(Promise.resolve().then(attempt)).rejects.toBeInstanceOf(PluginHostDeniedError)
        // Naming the verb is the assertion: a refusal that carried someone
        // else's verb would still be the right class.
        await expect(Promise.resolve().then(attempt)).rejects.toMatchObject({
          name: 'PluginHostDeniedError',
          verb: target,
        })
      } else {
        // Settling at all is the assertion: a refusal would reject, and
        // `notify` legitimately resolves to nothing.
        await expect(Promise.resolve().then(attempt)).resolves.not.toBeInstanceOf(Error)
      }
    }
  })

  it('names the refused verb on the error', async () => {
    denied.verb = 'sessions.spawn'

    await expect(CALL['sessions.spawn']()).rejects.toMatchObject({
      name: 'PluginHostDeniedError',
      verb: 'sessions.spawn',
    })
  })
})

describe('the v1 policy', () => {
  it('grants every verb, so nothing is refused today', async () => {
    const { assertVerbAllowed } = await vi.importActual<typeof import('../host-permissions')>(
      '../host-permissions',
    )

    for (const verb of PLUGIN_HOST_VERBS) {
      expect(() => assertVerbAllowed(verb)).not.toThrow()
    }
  })
})
