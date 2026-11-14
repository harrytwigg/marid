import type { Session } from "../../shared/types.js";
import { PluginHostError } from "./errors.js";
import { requirePluginHostGateway } from "./gateway-link.js";
import { assertVerbAllowed } from "./permissions.js";
import { provenanceRef } from "./provenance.js";

export interface PluginSpawnRequest {
  prompt: string;
  employee?: string;
  engine?: string;
  model?: string;
}

export interface PluginHostSessions {
  spawn(request: PluginSpawnRequest): Promise<Session>;
}

export function sessionVerbs(pluginId: string): PluginHostSessions {
  return {
    async spawn(request) {
      assertVerbAllowed(pluginId, "sessions.spawn");
      const outcome = await requirePluginHostGateway("sessions.spawn").spawnSession({
        prompt: request.prompt,
        employee: request.employee ?? null,
        engine: request.engine,
        model: request.model,
        provenance: { source: "plugin", sourceRef: provenanceRef(pluginId) },
      });
      if (!outcome.ok) {
        throw new PluginHostError(
          "sessions.spawn",
          "refused",
          `host.sessions.spawn refused: ${outcome.error}`,
        );
      }
      return outcome.session;
    },
  };
}
