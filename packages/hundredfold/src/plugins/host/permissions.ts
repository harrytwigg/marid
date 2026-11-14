/**
 * The gateway's half of the typed door's permission gate, mirroring
 * `packages/web/src/plugins/sdk/host-permissions.ts`.
 *
 * The two are deliberately separate modules rather than one shared one: they
 * guard different authority. A browser verb runs as whoever is signed in and is
 * bounded by the HTTP routes it calls; a backend verb runs in the gateway
 * process with no route in front of it. v1 grants every verb on both sides, and
 * the gate exists now because a door that was never narrow cannot be narrowed
 * afterwards without breaking every plugin at once.
 */

/** Every verb the typed door offers, in the spelling a policy will name. */
export const PLUGIN_HOST_VERBS = [
  "todos.list",
  "todos.create",
  "todos.comment",
  "sessions.spawn",
  "employees.list",
  "notify",
  "notes.list",
  "notes.read",
  "notes.create",
  "connectors.send",
  "cron.jobs",
  "cron.runs",
  "knowledge.search",
] as const;

export type PluginHostVerb = (typeof PLUGIN_HOST_VERBS)[number];

/** Thrown when a verb is refused, naming the plugin and the verb so the line in
 *  the log says which grant is missing rather than that something went wrong. */
export class PluginHostDeniedError extends Error {
  readonly pluginId: string;
  readonly verb: PluginHostVerb;

  constructor(pluginId: string, verb: PluginHostVerb) {
    super(`plugin "${pluginId}" is not granted host.${verb}`);
    this.name = "PluginHostDeniedError";
    this.pluginId = pluginId;
    this.verb = verb;
  }
}

const GRANTED: ReadonlySet<PluginHostVerb> = new Set(PLUGIN_HOST_VERBS);

export function assertVerbAllowed(pluginId: string, verb: PluginHostVerb): void {
  if (!GRANTED.has(verb)) throw new PluginHostDeniedError(pluginId, verb);
}
