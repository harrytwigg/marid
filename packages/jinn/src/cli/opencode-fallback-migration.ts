import { ENGINE_NAMES } from "../shared/models.js";
import { fallbackChainProblems, type FallbackLink } from "../shared/fallback-chain-wire.js";

/**
 * `jinn fallback migrate-opencode`: the gateway chain equivalent of an opencode
 * `rate-limit-fallback.json` (the settings of the `opencode-rate-limit` plugin
 * and of `model-fallback.js`). Pure: reading the file, the config and the org,
 * and writing the result, are the command's (opencode-fallback-command.ts).
 * See docs/fallback-chains.md, "Migrating a host".
 */

/** A settings key with no gateway setting, and why the gateway already covers it. */
export const UNMAPPED_SETTINGS: Record<string, string> = {
  cooldownMs: "engine health marks a target at its limit until its reset, and a chain passes over a spent link first",
  circuitBreaker: "engine health keeps a spent target out of the walk, and each target is tried at most once per run",
  fallbackMode: "a chain is walked once, in order, and the session waits for its own target's reset when it runs out",
  restoreModel: "the session returns to its own target at its reset, as it does after any fallback",
  retryPolicy: "each target is tried once per run, so a chain's length bounds the hops; opencode's own provider retries are unchanged",
};

const IGNORED_SETTINGS = new Set(["enabled", "fallbackModels", "$schema"]);

export interface OpencodeEmployee {
  name: string;
  engine: string;
  model: string;
}

export interface EmployeeSuggestion {
  /** The `provider/model` key the plugin's per-model chain was written for. */
  model: string;
  chain: FallbackLink[];
  /** Employees on the opencode engine pinned to that model; none when no one is. */
  employees: string[];
}

export interface OpencodeMigration {
  /** `engines.opencode.fallback`, from the plugin's list or its `"*"` chain. Empty when it had none. */
  engineChain: FallbackLink[];
  employeeSuggestions: EmployeeSuggestion[];
  /** Settings keys with no mapping, each with why the gateway covers it. */
  unmapped: Array<{ key: string; reason: string }>;
  /** Things the operator should know about the file, such as entries that could not be read. */
  notes: string[];
  /** Validation problems of the chains above, as `fallbackChainProblems` words them. */
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One plugin entry (`{providerID, modelID}`, or a `provider/model` string) as a model id. */
export function modelOfEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") return /^[^/\s]+\/\S+$/.test(entry.trim()) ? entry.trim() : undefined;
  if (isRecord(entry) && typeof entry.providerID === "string" && typeof entry.modelID === "string" && entry.providerID && entry.modelID) {
    return `${entry.providerID}/${entry.modelID}`;
  }
  return undefined;
}

function chainOf(list: unknown, where: string, notes: string[]): FallbackLink[] {
  if (!Array.isArray(list)) return [];
  const chain: FallbackLink[] = [];
  list.forEach((entry, index) => {
    const model = modelOfEntry(entry);
    if (!model) notes.push(`${where}[${index}] is neither {providerID, modelID} nor "provider/model", so it was left out`);
    else if (!chain.some((link) => link.model === model)) chain.push({ engine: "opencode", model });
  });
  return chain;
}

function matchingEmployees(model: string, employees: readonly OpencodeEmployee[], defaultModel: string | undefined): string[] {
  return employees.filter((e) => e.engine === "opencode" && (e.model || defaultModel) === model).map((e) => e.name);
}

/** The engine chain and the per-model chains of a settings object. */
function chainsOf(settings: Record<string, unknown>, notes: string[]): { engine: FallbackLink[]; perModel: Array<[string, FallbackLink[]]> } {
  const models = settings.fallbackModels;
  if (Array.isArray(models)) return { engine: chainOf(models, "fallbackModels", notes), perModel: [] };
  if (!isRecord(models)) return { engine: [], perModel: [] };
  const perModel = Object.entries(models)
    .filter(([key]) => key !== "*")
    .map(([key, list]): [string, FallbackLink[]] => [key, chainOf(list, `fallbackModels["${key}"]`, notes)]);
  return { engine: chainOf(models["*"], 'fallbackModels["*"]', notes), perModel };
}

function chainProblems(where: string, chain: FallbackLink[], self?: FallbackLink): string[] {
  return fallbackChainProblems(where, chain, { engines: ENGINE_NAMES, profiles: new Set(), ...(self ? { self } : {}) });
}

/**
 * The migration of one settings object. `employees` are the org's employees
 * and `defaultModel` the engine's own (`engines.opencode.model`), which an
 * employee with no model of their own runs on.
 */
export function migrateOpencodeFallback(
  settings: unknown,
  org: { employees: readonly OpencodeEmployee[]; defaultModel?: string },
): OpencodeMigration {
  const notes: string[] = [];
  if (!isRecord(settings)) {
    return { engineChain: [], employeeSuggestions: [], unmapped: [], notes: ["the settings file is not a JSON object"], problems: [] };
  }
  if (settings.enabled === false) notes.push('the file says "enabled": false, so the plugin does nothing with it; there is nothing to migrate');
  const { engine, perModel } = settings.enabled === false ? { engine: [], perModel: [] } : chainsOf(settings, notes);
  const employeeSuggestions = perModel.map(([model, chain]) => ({ model, chain, employees: matchingEmployees(model, org.employees, org.defaultModel) }));
  const unmapped = Object.keys(settings)
    .filter((key) => !IGNORED_SETTINGS.has(key))
    .map((key) => ({ key, reason: UNMAPPED_SETTINGS[key] ?? "the gateway has no setting for it" }));
  const problems = [
    ...chainProblems("engines.opencode.fallback", engine, { engine: "opencode" }),
    ...employeeSuggestions.flatMap((s) => chainProblems(`fallback for ${s.model}`, s.chain, { engine: "opencode", model: s.model })),
  ];
  return { engineChain: engine, employeeSuggestions, unmapped, notes, problems };
}
