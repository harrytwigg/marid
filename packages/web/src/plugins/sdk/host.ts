import {
  hostNavigator,
  hostNotificationSink,
  type HostNotice,
  type HostNotifyLevel,
} from './host-bridge'
import { PluginSdkError } from './errors'
import { onHostEvent, type HostEventHandler } from './host-events'
import { assertVerbAllowed } from './host-permissions'
import { getHostState, subscribeHostState, type HostState } from './host-state'
import {
  connectors,
  cron,
  employees,
  knowledge,
  notes,
  sessions,
  todos,
  type PluginHostConnectors,
  type PluginHostCron,
  type PluginHostEmployees,
  type PluginHostKnowledge,
  type PluginHostNotes,
  type PluginHostSessions,
  type PluginHostTodos,
} from './host-verbs'

export { PluginSdkError }

/**
 * The host API, in the three tiers the plugin spec describes: readonly state,
 * curated actions, then the typed verbs. Every verb below `state` passes the
 * permission gate, so each one can be refused on its own later.
 */
export interface PluginHost {
  readonly state: {
    getSnapshot(): HostState
    subscribe(listener: (state: HostState) => void): () => void
  }
  onEvent(type: string, handler: HostEventHandler): () => void
  navigate(path: string): void
  notify(message: string, level?: HostNotifyLevel): void
  notify(notice: HostNotice): void
  todos: PluginHostTodos
  sessions: PluginHostSessions
  employees: PluginHostEmployees
  notes: PluginHostNotes
  connectors: PluginHostConnectors
  cron: PluginHostCron
  knowledge: PluginHostKnowledge
}

function navigate(path: string): void {
  const navigateTo = hostNavigator()
  if (!navigateTo) {
    throw new PluginSdkError(
      `[plugin-sdk] host.navigate(${JSON.stringify(path)}) has nowhere to go: the app registers its ` +
        'navigator as it mounts, and it has not mounted yet. Navigate from an effect or an event handler, not ' +
        'from module scope.',
    )
  }
  navigateTo(path)
}

/**
 * One entry point rather than two, because a title with a description is the
 * same notification with more to say. A second verb would grow a second surface
 * the day someone forgot the two were meant to be one stack.
 */
function notify(input: string | HostNotice, level: HostNotifyLevel = 'info'): void {
  assertVerbAllowed('notify')
  const notice =
    typeof input === 'string' ? { title: input, level } : { ...input, level: input.level ?? 'info' }

  const sink = hostNotificationSink()
  if (!sink) {
    // Not silent, and not fatal either: a dropped notification is worth a line
    // in the console, but it is never worth taking a plugin down over.
    console.warn(
      `[plugin-sdk] no notification surface is mounted; dropping ${notice.level}: ${notice.title}`,
    )
    return
  }
  try {
    sink(notice)
  } catch (error) {
    // A notification surface that throws is the host's bug, and the plugin that
    // asked for the notification is the wrong place for it to land.
    console.error(
      `[plugin-sdk] the notification surface threw on ${notice.level}: ${notice.title}`,
      error,
    )
  }
}

export const host: PluginHost = {
  state: {
    getSnapshot: getHostState,
    subscribe: subscribeHostState,
  },
  onEvent: onHostEvent,
  navigate,
  notify,
  todos,
  sessions,
  employees,
  notes,
  connectors,
  cron,
  knowledge,
}
