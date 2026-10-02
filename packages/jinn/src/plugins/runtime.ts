import type { ApiContext } from "../gateway/api.js";
import { spawnSession } from "../gateway/spawn-session.js";
import { redactText } from "../shared/redact.js";
import type { JinnConfig } from "../shared/types.js";
import { setPluginHostGateway } from "./host/gateway-link.js";
import { reconcilePluginWatchers, stopAllPluginWatchers } from "./watcher-supervisor.js";

/**
 * Every enabled plugin's runtime, started and stopped as one thing.
 *
 * The order is the point: the typed host verbs get their gateway *before* any
 * plugin module is imported, so a watcher that spawns a session on its first
 * tick finds a gateway rather than an error. Stopping releases it again, so a
 * gateway that has shut down cannot still be spawned into by a plugin that
 * outlived it.
 */
export function startPluginRuntime(
  context: ApiContext,
  getConfig: () => Pick<JinnConfig, "plugins">,
): Promise<void> {
  setPluginHostGateway({
    spawnSession: (input) => spawnSession(context, input),
    emitNotice: (pluginId, message, level) => context.emit("plugin:notice", { pluginId, message, level }),
    sendConnectorMessage: async (connector, message) => {
      const target = context.connectors.get(connector);
      if (!target) return { ok: false, error: `no connector "${connector}" is configured` };
      // The same redaction `POST /api/connectors/:name/send` applies, so a
      // plugin cannot use the in-process path to leak what the route would mask.
      try {
        const to = { channel: message.channel, ...(message.thread ? { thread: message.thread } : {}) };
        await target.sendMessage(to, redactText(message.text));
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true };
    },
  });
  return reconcilePluginWatchers(getConfig);
}

export async function stopPluginRuntime(): Promise<void> {
  await stopAllPluginWatchers();
  setPluginHostGateway(null);
}
