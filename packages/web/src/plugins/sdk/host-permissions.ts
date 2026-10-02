/**
 * The one gate every typed host verb passes through.
 *
 * v1 grants every verb, so nothing is refused today. The gate exists now
 * rather than when the first denial does, because a door that was never narrow
 * cannot be narrowed afterwards without breaking every plugin at once. When a
 * policy arrives it replaces `GRANTED` and nothing else moves.
 */
import { PluginSdkError } from './errors'

/** Every verb the typed door offers, in the spelling a policy will name. The
 *  union is the vocabulary a grant is written in, not documentation. */
export const PLUGIN_HOST_VERBS = [
  'todos.list',
  'todos.create',
  'todos.comment',
  'sessions.spawn',
  'employees.list',
  'notify',
  'notes.list',
  'notes.read',
  'notes.create',
  'connectors.send',
  'cron.jobs',
  'cron.runs',
  'knowledge.search',
] as const

export type PluginHostVerb = (typeof PLUGIN_HOST_VERBS)[number]

/** Thrown when a verb is refused. Separate from every other SDK failure so a
 *  plugin can degrade — hide the button — rather than treat a refusal as a bug. */
export class PluginHostDeniedError extends PluginSdkError {
  readonly verb: PluginHostVerb

  constructor(verb: PluginHostVerb) {
    super(`[plugin-sdk] host.${verb} is not granted to this plugin`)
    this.name = 'PluginHostDeniedError'
    this.verb = verb
  }
}

const GRANTED: ReadonlySet<PluginHostVerb> = new Set(PLUGIN_HOST_VERBS)

export function assertVerbAllowed(verb: PluginHostVerb): void {
  if (!GRANTED.has(verb)) throw new PluginHostDeniedError(verb)
}
