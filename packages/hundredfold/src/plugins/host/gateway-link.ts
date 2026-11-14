import type { SpawnSessionInput, SpawnSessionOutcome } from "../../gateway/spawn-session.js";
import { PluginHostError } from "./errors.js";
import type { PluginHostVerb } from "./permissions.js";

/**
 * What a plugin's backend needs from a *running* gateway, registered once at
 * boot — the same shape `work-items/live-events.ts` uses, and for the same
 * reason: a plugin's server module is loaded by the plugin loader, which has no
 * request and no `ApiContext` to thread through it.
 *
 * Null is the honest state in tests and in CLI runs with no server. The members
 * answer it differently on purpose: a notice that nobody can show is dropped,
 * because a plugin should not fall over for want of a toast, while a spawn or
 * a connector send that cannot happen throws, because silently
 * not doing the thing is the failure a caller must never have to discover for
 * itself.
 */

export type PluginNoticeLevel = "info" | "warning" | "error";

/** Mirrors `SpawnSessionOutcome`: a refusal a caller must read, not an exception
 *  the registration seam decides the wording of. */
export type PluginConnectorSendOutcome = { ok: true } | { ok: false; error: string };

export interface PluginHostGateway {
  spawnSession: (input: SpawnSessionInput) => Promise<SpawnSessionOutcome>;
  emitNotice: (pluginId: string, message: string, level: PluginNoticeLevel) => void;
  sendConnectorMessage: (
    connector: string,
    message: { channel: string; thread?: string; text: string },
  ) => Promise<PluginConnectorSendOutcome>;
}

let gateway: PluginHostGateway | null = null;

export function setPluginHostGateway(next: PluginHostGateway | null): void {
  gateway = next;
}

/** Throws rather than returning null, so every caller that needs the gateway
 *  says why it could not act instead of returning an empty success. */
export function requirePluginHostGateway(verb: PluginHostVerb): PluginHostGateway {
  if (!gateway) {
    throw new PluginHostError(
      verb,
      "no-gateway",
      `host.${verb} needs a running gateway, and none is registered in this process`,
    );
  }
  return gateway;
}

export function emitPluginNotice(pluginId: string, message: string, level: PluginNoticeLevel): void {
  if (!gateway) return;
  try {
    gateway.emitNotice(pluginId, message, level);
  } catch {
    // A broken notification surface is the gateway's bug, and the plugin that
    // asked for the notice is the wrong place for it to land.
  }
}
