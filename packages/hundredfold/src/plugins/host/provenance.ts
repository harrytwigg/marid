import { randomUUID } from "node:crypto";

/**
 * How a row records the plugin that caused it.
 *
 * The random tail matters: `createWorkItem` is idempotent on
 * `(source, sourceRef)`, so a constant ref would silently collapse every Todo a
 * plugin ever mints into the first one.
 */
export function provenanceRef(pluginId: string): string {
  return `plugin:${pluginId}:${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
