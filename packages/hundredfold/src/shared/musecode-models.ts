import type { ModelInfo } from "./types.js";
import { MUSECODE_EFFORT_LEVELS } from "./musecode-effort.js";
import { askMuseHost } from "../engines/musecode-probe.js";
import type { MuseModelCost } from "../engines/musecode-turn-text.js";

/**
 * Muse Code's model catalog, read from the host itself (`model/list` on a
 * short-lived `muse serve`), with the four documented models as the offline
 * fallback.
 */

const DISCOVERY_TIMEOUT_MS = 15_000;

export interface MusecodeModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
  /** Per-million-token rates, for the models whose catalog row declares them. */
  costs: Record<string, MuseModelCost>;
}

const KNOWN_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
  { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 (contributor)" },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2" },
  { id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 (contributor)" },
];
const KNOWN_DEFAULT = "muse-spark-1.2";

/** The documented catalog, for when the CLI cannot be asked. A pinned id it does not list is kept selectable. */
export function knownMusecodeModels(pinned?: string): MusecodeModelDiscovery {
  const rows = KNOWN_MODELS.map(({ id, label }) => ({ id, label }));
  if (pinned && !rows.some((row) => row.id === pinned)) rows.unshift({ id: pinned, label: pinned });
  return {
    defaultModel: pinned || KNOWN_DEFAULT,
    models: rows.map(({ id, label }) => ({ id, label, supportsEffort: true, effortLevels: [...MUSECODE_EFFORT_LEVELS] })),
    costs: {},
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A catalog's decimal string (`"0.30"`) as a non-negative number, or undefined. */
function rate(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The row's rates when it declares all three in USD; a partial or foreign-currency block prices nothing. */
function costOf(value: unknown): MuseModelCost | undefined {
  const cost = record(value);
  if (!cost) return undefined;
  if (typeof cost.currency === "string" && cost.currency.toUpperCase() !== "USD") return undefined;
  const input = rate(cost.input);
  const cached = rate(cost.cached);
  const output = rate(cost.output);
  return input === undefined || cached === undefined || output === undefined ? undefined : { input, cached, output };
}

/** Efforts a model accepts: `variants` without `none`, which the provider rejects. An absent list is the default vocabulary; `"unknown"` offers none. */
function effortLevelsOf(variants: unknown): string[] {
  if (variants === undefined) return [...MUSECODE_EFFORT_LEVELS];
  if (!Array.isArray(variants)) return [];
  return variants.filter((v): v is string => typeof v === "string" && v !== "none");
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One catalog row as a model, or undefined when it has no usable id. */
function modelOf(row: Record<string, unknown> | undefined): ModelInfo | undefined {
  const id = text(row?.modelId);
  if (!row || !id) return undefined;
  const effortLevels = effortLevelsOf(row.variants);
  const contextWindow = positive(row.contextLimit);
  return {
    id,
    label: text(row.displayLabel) ?? id,
    supportsEffort: effortLevels.length > 0,
    effortLevels,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

/** `model/list`'s result as models. Rows without a usable id, and repeats of one, are skipped. */
export function parseMusecodeModelList(result: unknown): MusecodeModelDiscovery {
  const rows = record(result)?.models;
  const models: ModelInfo[] = [];
  const costs: Record<string, MuseModelCost> = {};
  let defaultModel: string | undefined;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = record(raw);
    const model = modelOf(row);
    if (!model || models.some((m) => m.id === model.id)) continue;
    models.push(model);
    const cost = costOf(row!.cost);
    if (cost) costs[model.id] = cost;
    if (row!.isDefault === true) defaultModel ??= model.id;
  }
  return { ...(defaultModel === undefined ? {} : { defaultModel }), models, costs };
}

export interface DiscoverMusecodeModelsOptions {
  /** Flags appended to `muse serve`, as on a turn. */
  cliFlags?: string[];
  timeoutMs?: number;
}

/**
 * Ask a short-lived `muse serve` for its catalog. Never throws: a binary that
 * will not start, a host that does not answer in time or an empty catalog all
 * come back as no models, and the caller keeps its fallback.
 */
export async function discoverMusecodeModels(bin: string, opts: DiscoverMusecodeModelsOptions = {}): Promise<MusecodeModelDiscovery> {
  const result = await askMuseHost(
    bin,
    { cliFlags: opts.cliFlags, timeoutMs: opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS },
    (client) => client.request("model/list", {}, { timeoutMs: opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS }),
  );
  return parseMusecodeModelList(result);
}

/**
 * The models and default the registry offers: the discovered catalog when
 * there is one, otherwise the documented four. A model the operator pinned
 * that the catalog does not list stays selectable, and a pinned model wins
 * as the default.
 */
export function resolveMusecodeCatalog(
  discovered: MusecodeModelDiscovery | null,
  pinned: string | undefined,
): { defaultModel: string; models: ModelInfo[] } {
  if (!discovered || discovered.models.length === 0) {
    const known = knownMusecodeModels(pinned);
    return { defaultModel: known.defaultModel ?? KNOWN_DEFAULT, models: known.models };
  }
  const models = pinned && !discovered.models.some((m) => m.id === pinned)
    ? [{ id: pinned, label: pinned, supportsEffort: true, effortLevels: [...MUSECODE_EFFORT_LEVELS] }, ...discovered.models]
    : discovered.models;
  const listed = (id: string | undefined) => (id && models.some((m) => m.id === id) ? id : undefined);
  return { defaultModel: listed(pinned) ?? listed(discovered.defaultModel) ?? models[0]!.id, models };
}
