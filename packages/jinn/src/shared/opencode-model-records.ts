import type { ModelInfo } from "./types.js";

/**
 * What opencode says about one model, as `opencode-models.ts` reads it: the
 * JSON record 1.x prints under each `models --verbose` line, and the records
 * 2.x's server returns from `GET /api/model`. Both carry the same
 * `limit.context` and `variants`; only their framing differs.
 */

/** One `provider/model` line. The model half may itself contain slashes
 *  (`openrouter/meta-llama/llama-4`), so only the FIRST slash is structural —
 *  the same split the engine does when handing `-m` back to opencode. */
export const MODEL_LINE = /^([A-Za-z0-9_.-]+)\/(\S+)$/;

/** One model's record (or the API's whole answer) as an object, or undefined
 *  when the text is not JSON or not an object. */
export function parseRecord(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `limit.context` of a record, or undefined when it is missing or not a
 *  positive number. */
export function contextWindowOf(record: Record<string, unknown>): number | undefined {
  const limit = record.limit as { context?: unknown } | null | undefined;
  const context = limit?.context;
  return typeof context === "number" && Number.isFinite(context) && context > 0 ? context : undefined;
}

/** The effort levels a record's `variants` name, in the order opencode lists
 *  them. 1.x gives an object keyed by level; 2.x's API gives an array of
 *  `{id}`. Missing, null, empty or any other shape names none. */
export function effortLevelsOf(record: Record<string, unknown>): string[] {
  const variants = record.variants;
  let names: unknown[] = [];
  if (Array.isArray(variants)) names = variants.map((v) => (v as { id?: unknown } | null)?.id);
  else if (variants && typeof variants === "object") names = Object.keys(variants);
  return [...new Set(names.filter((n): n is string => typeof n === "string" && n.trim() !== ""))];
}

/**
 * Parse `opencode api model.list` output (OpenCode 2.x): `{data: [record…]}`,
 * where each record names its model as `providerID` plus `id` and carries the
 * same `limit.context` and `variants` (an array of `{id}`) as a 1.x record.
 *
 * The ids are the `provider/model` lines plain `opencode models` prints, and
 * the list is put in that command's order (by id) so a host's picker reads the
 * same whichever way it was discovered; the API's own order is by release date.
 * A record opencode marks `enabled: false` is left out, as its own clients do.
 * Output that is not that shape gives no models.
 */
export function parseOpencodeApiModels(output: string): ModelInfo[] {
  const data = parseRecord(output.trim())?.data;
  if (!Array.isArray(data)) return [];
  const models = new Map<string, ModelInfo>();
  for (const item of data) {
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
    if (!record || record.enabled === false) continue;
    const { providerID, id: modelId } = record;
    if (typeof providerID !== "string" || typeof modelId !== "string") continue;
    const id = `${providerID}/${modelId}`;
    if (!MODEL_LINE.test(id) || models.has(id)) continue;
    const model: ModelInfo = { id, label: modelId, supportsEffort: false, effortLevels: [] };
    const window = contextWindowOf(record);
    if (window !== undefined) model.contextWindow = window;
    const levels = effortLevelsOf(record);
    if (levels.length > 0) {
      model.supportsEffort = true;
      model.effortLevels = levels;
    }
    models.set(id, model);
  }
  return [...models.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
