/**
 * The public type contract of `@jinn/plugin-sdk`, version 1.2.0.
 *
 * Hand-authored, and deliberately never generated from `index.ts`. A derived
 * `.d.ts` inlines the app's own import paths into the public API, so renaming
 * an internal module becomes a silent breaking change for every plugin built
 * against it. The only modules named here are ones a plugin author can install.
 *
 * A test holds the contract in exact two-way sync with the runtime barrel:
 * every name it declares is exported by `index.ts`, and every name `index.ts`
 * exports is declared by it. The contract is this file plus the `sdk-ui.d.ts`
 * and `sdk-host.d.ts` halves it re-exports, and the test reads all three.
 */
import type * as ReactModule from 'react'
import type { ElementType, ReactElement } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { ClassValue } from 'clsx'
import type {
  PluginHostConnectors,
  PluginHostCron,
  PluginHostEmployees,
  PluginHostKnowledge,
  PluginHostNotes,
  PluginHostSessions,
  PluginHostTodos,
} from './sdk-host'

/** The app's components, which are their own half of the contract. */
export * from './sdk-ui'

/** The contract this file describes. A plugin can refuse to load against a
 *  version it predates. */
export declare const SDK_CONTRACT_VERSION: '1.2.0'

/* React, the app's own instances. A plugin that resolved a second React would
 * get a second dispatcher and every hook it called would throw, so these are
 * the mechanism rather than a convenience. */
export declare const React: typeof ReactModule
export declare function jsx(type: ElementType, props: unknown, key?: string): ReactElement
export declare function jsxs(type: ElementType, props: unknown, key?: string): ReactElement
export declare const Fragment: ElementType

/** The app's single query client, with its cache and defaults already set. */
export declare const queryClient: QueryClient

/** Merge Tailwind class names; the last conflicting utility wins. */
export declare function cn(...inputs: ClassValue[]): string

/** The v1 areas. The values are the contract — they appear in manifests and in
 *  the registry's keys — and the property names are only an alias. */
export declare const AREAS: {
  readonly routes: 'routes'
  readonly sidebarNav: 'sidebar.nav'
  readonly statusBarRight: 'statusbar.right'
  readonly todoDetailActions: 'todo.detail.actions'
  readonly todoDetailSections: 'todo.detail.sections'
  readonly chatComposer: 'chat.composer'
  readonly homeWidgets: 'home.widgets'
}

/** Derived from the const above rather than spelled a second time: a union
 *  restated by hand is one an added area can silently fall out of. */
export type AreaId = (typeof AREAS)[keyof typeof AREAS]

/** What the current `routes` contribution's path captured, keyed by the names
 *  it declared: `{ id: '42' }` at `/x/42` for a `data.path` of `/x/:id`. Empty
 *  outside a contributed route. The host parses the URL, so a page never has to
 *  read `window.location` and guess at the grammar. */
export declare function useRouteParams(): Record<string, string>

export type GatewayStatus = 'connected' | 'disconnected'

/** The readonly tier: what the app is currently showing. */
export interface HostState {
  readonly activeSession: string | null
  readonly gatewayStatus: GatewayStatus
}

/** A gateway frame as a plugin sees it. Narrow `payload` yourself; the host's
 *  typed event union lives in a package a plugin cannot install. */
export interface HostEvent {
  readonly event: string
  readonly payload: unknown
}

export type HostEventHandler = (frame: HostEvent) => void

export type HostNotifyLevel = 'info' | 'warning' | 'error'

/** A notification with more to say than one line: the title carries the event
 *  and the description the detail. `level` defaults to `info`. */
export interface HostNotice {
  title: string
  description?: string
  level?: HostNotifyLevel
}

/* The typed verb tier is split out so this entry point stays below the size
 * ratchet while plugin authors still read one public module. */
export type {
  HostConnectorMessage,
  HostCronJob,
  HostCronRun,
  HostEmployee,
  HostKnowledgeResult,
  HostNote,
  HostNoteContent,
  HostNoteDraft,
  HostSession,
  HostSessionSpawn,
  HostTodo,
  HostTodoComment,
  HostTodoDraft,
  HostTodoFilter,
  HostTodoStatus,
  PluginHostConnectors,
  PluginHostCron,
  PluginHostEmployees,
  PluginHostKnowledge,
  PluginHostNotes,
  PluginHostSessions,
  PluginHostTodos,
  PluginHostVerb,
} from './sdk-host'

export interface PluginHost {
  readonly state: {
    /** Stable identity between publishes, so it can back `useSyncExternalStore`. */
    getSnapshot(): HostState
    subscribe(listener: (state: HostState) => void): () => void
  }
  /** Subscribe to one gateway event type; returns the unsubscribe. Handlers are
   *  isolated from each other: one that throws does not stop the rest. */
  onEvent(type: string, handler: HostEventHandler): () => void
  /** Navigate the app. Throws a `PluginSdkError` if called before the app has
   *  mounted, rather than dropping the call. */
  navigate(path: string): void
  /** Show a notification, or log it when no surface is mounted. Throws only
   *  when the verb itself is refused, never for want of a surface. Pass a
   *  `HostNotice` for a title with a description under it; both forms land on
   *  the one stack. */
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

export declare const host: PluginHost

/** Every failure the SDK raises, so a plugin can tell an SDK problem from one
 *  of its own. */
export declare class PluginSdkError extends Error {
  constructor(message: string)
}

/** Thrown when a verb is refused, so a plugin can degrade rather than break. */
export declare class PluginHostDeniedError extends PluginSdkError {
  readonly verb: PluginHostVerb
  constructor(verb: PluginHostVerb)
}
