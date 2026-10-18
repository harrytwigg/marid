import type { EngineModelsConfig, ModelInfo } from "./types.js";
import { contextWindowOf, effortLevelsOf, MODEL_LINE, parseRecord } from "./opencode-model-records.js";

/**
 * Dynamic model discovery for the opencode engine.
 *
 * `opencode models --verbose` prints one `provider/model` per line, each
 * followed by that model's record as JSON — every model the INSTALLED CLI can
 * actually reach, which is whichever providers the operator authenticated
 * (`opencode auth login`) plus whatever their config adds. Asking opencode
 * rather than any provider directly is what keeps the catalog honest: a model
 * never appears here for credentials this host does not hold.
 *
 * Two things are taken from the record: the context window (`limit.context`),
 * for the context meter, and the model's variants. A variant is opencode's
 * reasoning-effort control (`run --variant`, the prompt body's `variant`), and
 * the record lists exactly which ones THIS model has — `{high}` for one model,
 * `{low, medium, high, xhigh, max}` for another, `{}` for one with none. Those
 * keys, in opencode's order, are the model's effort levels, so the picker offers
 * what the model accepts and nothing it would reject. A model with no variants
 * (or a record without the field, as plain `opencode models` has none) declares
 * no effort support. Plain `opencode models` carries neither window nor variants.
 *
 * OpenCode 2.x has no `--verbose`. Its records come from the server's
 * `GET /api/model` instead, asked through `opencode api model.list
 * --standalone`: the CLI starts a private server, prints the answer as JSON and
 * stops it. That keeps discovery a one-shot command like every other step here,
 * independent of whether Marid runs a server of its own (run mode has none, and
 * server mode's servers are per session and come and go).
 */


/** Strip terminal colour/cursor escapes. */
const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/**
 * Parse `opencode models` / `opencode models --verbose` output.
 *
 * Deliberately strict about what counts as a model line. Anything opencode
 * prints alongside the list — an update notice, a provider warning, a stray
 * absolute path — either carries whitespace or does not start with a bare
 * provider segment, and is dropped rather than surfaced to the model picker as
 * a model nobody can select.
 *
 * `--verbose` follows each model line with that model's record as a
 * pretty-printed JSON object: `{` alone on a line, every inner line indented,
 * `}` alone on a line. Its `limit.context` becomes the model's `contextWindow`
 * and its `variants` the model's `effortLevels`. A model with no object, a
 * cut-off one or one that is not JSON simply has neither — never a guessed one.
 */
export function parseOpencodeModels(output: string): ModelInfo[] {
  const reader: Reader = { models: [], seen: new Set() };
  for (const raw of output.split("\n")) readLine(reader, stripAnsi(raw).replace(/\r$/, ""));
  closeObject(reader);
  return reader.models;
}

interface Reader {
  models: ModelInfo[];
  seen: Set<string>;
  /** The model the JSON object being read belongs to. */
  current?: ModelInfo;
  /** The lines of that object so far; undefined between objects. */
  json?: string[];
}

/** The object is complete (or cut off): give its model the window and the
 *  effort levels it states. */
function closeObject(reader: Reader): void {
  const record = reader.current && reader.json ? parseRecord(reader.json.join("\n")) : undefined;
  if (reader.current && record) {
    const window = contextWindowOf(record);
    if (window !== undefined) reader.current.contextWindow = window;
    const levels = effortLevelsOf(record);
    if (levels.length > 0) {
      reader.current.supportsEffort = true;
      reader.current.effortLevels = levels;
    }
  }
  reader.json = undefined;
}

function readLine(reader: Reader, text: string): void {
  if (reader.json) {
    // Inside an object every line is indented except the closing brace, so a
    // model line at column 0 can only mean the object was cut off.
    if (!MODEL_LINE.test(text)) {
      reader.json.push(text);
      if (text === "}") closeObject(reader);
      return;
    }
    closeObject(reader);
  }
  const line = text.trim();
  const match = MODEL_LINE.exec(line);
  if (match) {
    const fresh = !reader.seen.has(line);
    reader.seen.add(line);
    reader.current = fresh ? { id: line, label: match[2], supportsEffort: false, effortLevels: [] } : undefined;
    if (reader.current) reader.models.push(reader.current);
  } else if (text === "{" && reader.current) {
    reader.json = [text];
  }
}

/** What an entry of the `models.opencode` block overrides on a discovered model. */
interface ModelOverride {
  contextWindow?: number;
  /** `false`: switch the model's effort off. */
  supportsEffort?: false;
  /** The levels the entry lists, and whether it turned effort on itself. */
  levels?: { list: string[]; explicit: boolean };
}

/** The part of a configured entry that states something. A zero, negative or
 *  NaN window states nothing, nor does an effort list that names no level:
 *  the discovered value stays. `supportsEffort: false` is the one way to switch
 *  a discovered model's effort off. */
function overrideOf(entry: NonNullable<EngineModelsConfig["models"]>[number]): ModelOverride {
  const override: ModelOverride = {};
  if (typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0) {
    override.contextWindow = entry.contextWindow;
  }
  const list = (Array.isArray(entry.effortLevels) ? entry.effortLevels : []).filter((l) => typeof l === "string" && l.trim() !== "");
  if (entry.supportsEffort === false) override.supportsEffort = false;
  else if (list.length > 0) override.levels = { list, explicit: entry.supportsEffort === true };
  return override;
}

/** One model with its entry applied. Levels follow the block's own convention
 *  (a model has effort when the entry says `supportsEffort: true`, as in a block
 *  with no discovery), except that a list for a model discovery already gave
 *  effort replaces its levels without that flag. */
function applyOverride(model: ModelInfo, override: ModelOverride): ModelInfo {
  const out: ModelInfo = { ...model };
  if (override.contextWindow !== undefined) out.contextWindow = override.contextWindow;
  if (override.supportsEffort === false) return { ...out, supportsEffort: false, effortLevels: [] };
  if (override.levels && (override.levels.explicit || model.supportsEffort)) {
    return { ...out, supportsEffort: true, effortLevels: override.levels.list };
  }
  return out;
}

/** The operator's configured `contextWindow` and `effortLevels` for a model win
 *  over what opencode reports: they are the operator's own statement about a
 *  model (a provider limit opencode does not know, a self-imposed cap, the
 *  variants of a build whose discovery lists none). Nothing else of the
 *  `models.opencode` block is applied to a discovered catalog. */
export function withConfiguredOverrides(models: ModelInfo[], block: EngineModelsConfig | undefined): ModelInfo[] {
  const configured = new Map<string, ModelOverride>();
  for (const entry of block?.models ?? []) {
    const override = overrideOf(entry);
    if (Object.keys(override).length > 0) configured.set(entry.id, override);
  }
  if (configured.size === 0) return models;
  return models.map((model) => {
    const override = configured.get(model.id);
    return override ? applyOverride(model, override) : model;
  });
}
