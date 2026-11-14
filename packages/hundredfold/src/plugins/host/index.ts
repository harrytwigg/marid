import { connectorVerbs, type PluginHostConnectors } from "./connectors.js";
import { cronVerbs, type PluginHostCron } from "./cron.js";
import { employeeVerbs, type PluginHostEmployees } from "./employees.js";
import { emitPluginNotice, type PluginNoticeLevel } from "./gateway-link.js";
import { knowledgeVerbs, type PluginHostKnowledge } from "./knowledge.js";
import { noteVerbs, type PluginHostNotes } from "./notes.js";
import { assertVerbAllowed } from "./permissions.js";
import { sessionVerbs, type PluginHostSessions } from "./sessions.js";
import { todoVerbs, type PluginHostTodos } from "./todos.js";

/**
 * The typed verb tier as a plugin's *backend* sees it — the same thirteen verbs
 * the browser SDK offers, over the gateway's own in-process functions rather
 * than over HTTP.
 *
 * Inside this process the HTTP hop would be wrong twice: it would need a token
 * to call the gateway it is already running in, and it would turn one
 * transactional write into a request that can fail halfway. The delegation
 * transaction composes its writes in-process for the same reason.
 *
 * One module per domain, each one passing the permission gate before it acts. A
 * verb that skipped the gate would be a verb no policy could ever refuse.
 */

export type { PluginTodoDraft } from "./todos.js";
export type { PluginSpawnRequest } from "./sessions.js";
export type { PluginNoteDraft } from "./notes.js";
export type { PluginConnectorMessage } from "./connectors.js";
export type { PluginCronJob } from "./cron.js";

export interface PluginHost {
  todos: PluginHostTodos;
  sessions: PluginHostSessions;
  employees: PluginHostEmployees;
  notes: PluginHostNotes;
  connectors: PluginHostConnectors;
  cron: PluginHostCron;
  knowledge: PluginHostKnowledge;
  /** Say something on the dashboard. Never throws: a dropped notice is not
   *  worth taking a plugin's watcher down over. */
  notify(message: string, level?: PluginNoticeLevel): void;
}

export function createPluginHost(pluginId: string): PluginHost {
  const author = `plugin:${pluginId}`;

  return {
    todos: todoVerbs(pluginId, author),
    sessions: sessionVerbs(pluginId),
    employees: employeeVerbs(pluginId),
    notes: noteVerbs(pluginId),
    connectors: connectorVerbs(pluginId),
    cron: cronVerbs(pluginId),
    knowledge: knowledgeVerbs(pluginId),

    notify(message, level = "info") {
      assertVerbAllowed(pluginId, "notify");
      emitPluginNotice(pluginId, message, level);
    },
  };
}
