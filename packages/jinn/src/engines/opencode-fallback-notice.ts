import type { V2ModelRef } from "./opencode-variant.js";

/**
 * A 2.x host plugin that switches models inside a turn (see
 * opencode-internal-fallback.ts) answers it from another model, invisibly to
 * the gateway's chain. The turn is left as it ran, and says so.
 */

/** `provider/model` of a `session.step.started` event's model, when it names one. */
export function stepModel(data: Record<string, unknown>): string | undefined {
  const model = data.model;
  if (typeof model !== "object" || model === null) return undefined;
  const { providerID, id } = model as Record<string, unknown>;
  return typeof providerID === "string" && typeof id === "string" && providerID && id ? `${providerID}/${id}` : undefined;
}

/** The model a turn asked for, as `provider/model`. */
export function requestedModel(ref: Pick<V2ModelRef, "providerID" | "id"> | undefined): string | undefined {
  return ref ? `${ref.providerID}/${ref.id}` : undefined;
}

/** The session notice posted once for such a turn. */
export function fallbackModelNotice(ranOn: string): string {
  return `Answered by ${ranOn} through the host's opencode fallback plugin, not the gateway's chain. Run \`jinn doctor\` to remove it.`;
}
