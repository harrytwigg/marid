import { PluginHostError } from "./errors.js";
import { requirePluginHostGateway } from "./gateway-link.js";
import { assertVerbAllowed } from "./permissions.js";

export interface PluginConnectorMessage {
  /** The channel as that connector spells it — a Slack channel id, a chat id. */
  channel: string;
  text: string;
  /** Reply into a thread rather than to the channel, where the connector has
   *  threads at all. */
  thread?: string;
}

export interface PluginHostConnectors {
  /** Send through a configured connector, named as `config.yaml` names it. */
  send(connector: string, message: PluginConnectorMessage): Promise<void>;
}

export function connectorVerbs(pluginId: string): PluginHostConnectors {
  return {
    async send(connector, message) {
      assertVerbAllowed(pluginId, "connectors.send");
      const outcome = await requirePluginHostGateway("connectors.send").sendConnectorMessage(
        connector,
        message,
      );
      if (!outcome.ok) {
        throw new PluginHostError(
          "connectors.send",
          "refused",
          `host.connectors.send refused: ${outcome.error}`,
        );
      }
    },
  };
}
