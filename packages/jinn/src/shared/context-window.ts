import type { ModelInfo, ModelRegistry } from "./types.js";

/**
 * What the context meter needs to know about the model a session runs: its id,
 * its label and its context window, read from the model registry the gateway
 * already serves at `GET /api/engines`. A window the registry does not state is
 * `null` — the meter then shows the size alone rather than a guessed ratio.
 */
export interface ResolvedContextWindow {
  /** The model the session runs: its own, else the engine's default. */
  model: string | null;
  modelLabel: string | null;
  contextWindow: number | null;
}

/** Claude Code's extended-context variants: `opus[1m]`, `claude-sonnet-5[1m]`. */
const EXTENDED_CONTEXT_SUFFIX = /\[1m\]$/i;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

type RegistryEntry = ModelRegistry[string] | undefined;

const modelOf = (entry: RegistryEntry, id: string): ModelInfo | undefined => entry?.models.find((candidate) => candidate.id === id);

/** `opus[1m]`: always the extended window, labelled from the base model's entry. */
function extendedContext(id: string, entry: RegistryEntry): ResolvedContextWindow {
  const exact = modelOf(entry, id);
  const base = modelOf(entry, id.replace(EXTENDED_CONTEXT_SUFFIX, ""));
  const modelLabel = exact?.label ?? (base ? `${base.label} (1M)` : null);
  return { model: id, modelLabel, contextWindow: EXTENDED_CONTEXT_WINDOW };
}

/**
 * The window of `model` on `engine`. `model` null/empty means the engine's
 * default, which is what a turn without a model of its own runs. The `[1m]`
 * suffix is Claude Code's alias for the 1M-token variant of a model, so it is
 * 1_000_000 whatever the base model's own entry says. Anything else is looked up
 * by exact id (an alias is an entry of its own) and is `null` when the registry
 * has no entry or no window for it.
 */
export function resolveContextWindow(
  engine: string,
  model: string | null | undefined,
  registry: ModelRegistry,
): ResolvedContextWindow {
  const entry: RegistryEntry = registry[engine];
  const id = model?.trim() || entry?.defaultModel;
  if (!id) return { model: null, modelLabel: null, contextWindow: null };
  if (engine === "claude" && EXTENDED_CONTEXT_SUFFIX.test(id)) return extendedContext(id, entry);
  return registeredModel(id, modelOf(entry, id));
}

function registeredModel(id: string, known: ModelInfo | undefined): ResolvedContextWindow {
  const window = known?.contextWindow;
  return { model: id, modelLabel: known?.label ?? null, contextWindow: positive(window) ? window : null };
}
