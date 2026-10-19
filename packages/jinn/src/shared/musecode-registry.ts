import type { EngineModelsConfig, EngineRegistryEntry, JinnConfig, ModelInfo } from "./types.js";
import type { MuseModelCost } from "../engines/musecode-turn-text.js";
import { logger } from "./logger.js";
import { resolveBin } from "./resolve-bin.js";
import { engineAvailable, invalidateModelRegistry, mergeDiscoveredModels } from "./models.js";
import { discoverMusecodeModels, resolveMusecodeCatalog, type MusecodeModelDiscovery } from "./musecode-models.js";
import { writeMusecodeUsage } from "./musecode-usage.js";

/**
 * Muse Code's place in the model registry: the catalog snapshot a discovery
 * left, the refresh that takes it, and the registry entry built from it.
 * `models.ts` re-exports and calls these; they call back into it only at run
 * time, so the import cycle is never read while a module is still loading.
 */

/** Snapshot of the Muse Code catalog (`model/list`; null until a discovery has found models). */
let discovered: MusecodeModelDiscovery | null = null;

/** Discover Muse Code's catalog and refresh the registry. Never throws; no models found keeps the documented ones. */
export async function refreshMusecodeModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "musecode")) {
    discovered = null;
  } else {
    const found = await discoverMusecodeModels(resolveBin("muse", config.engines.musecode?.bin));
    discovered = found.models.length > 0 ? found : null;
    if (discovered) logger.info(`Muse Code model discovery: ${found.models.length} model(s)`);
  }
  invalidateModelRegistry();
}

/** What a model costs per million tokens, when the discovered catalog says. No model id means the catalog's default. */
export function musecodeModelCost(modelId: string | undefined): MuseModelCost | undefined {
  return discovered?.costs[modelId ?? discovered.defaultModel ?? ""];
}

/**
 * Registry entry: the discovered catalog with the config `models.musecode` block
 * merged over it (as codex does) > the block alone (`fromBlock`) > the documented models.
 */
export function buildMusecodeEntry(
  config: JinnConfig,
  block: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
  fromBlock: (block: EngineModelsConfig, pinned: string | undefined) => EngineRegistryEntry,
): EngineRegistryEntry {
  const pinned = config.engines.musecode?.model;
  if (!discovered && block) return fromBlock(block, pinned);
  const catalog = resolveMusecodeCatalog(discovered, pinned);
  const entry = { ...synthEntry, name: "musecode" as const, available, effortMechanism: "musecode-turn" as const };
  return discovered ? { ...entry, ...withConfiguredModels(catalog, block, pinned) } : { ...entry, ...catalog };
}

/** A discovered catalog with the config block merged over it; the default is the pin, the block's, the catalog's, else the first. */
function withConfiguredModels(
  catalog: { defaultModel: string; models: ModelInfo[] },
  block: EngineModelsConfig | undefined,
  pinned: string | undefined,
): { defaultModel: string; models: ModelInfo[] } {
  const models = mergeDiscoveredModels(catalog.models, block, { configuredOverridesDiscovered: true });
  const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
  return { models, defaultModel: valid(pinned) ?? valid(block?.default) ?? valid(catalog.defaultModel) ?? models[0]?.id ?? catalog.defaultModel };
}

/** What the gateway builds its Muse Code engine with: keep each turn's usage report, price turns from the catalog. */
export const musecodeEngineOptions = { onUsage: writeMusecodeUsage, modelCost: musecodeModelCost };
