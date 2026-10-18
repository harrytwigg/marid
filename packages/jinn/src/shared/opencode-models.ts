import { spawn, type ChildProcess } from "node:child_process";
import type { EngineModelsConfig, ModelInfo } from "./types.js";
import { logger } from "./logger.js";

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

/** One `provider/model` line. The model half may itself contain slashes
 *  (`openrouter/meta-llama/llama-4`), so only the FIRST slash is structural —
 *  the same split the engine does when handing `-m` back to opencode. */
const MODEL_LINE = /^([A-Za-z0-9_.-]+)\/(\S+)$/;

/** Strip terminal colour/cursor escapes. */
const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** One model's `--verbose` JSON as an object, or undefined when the text is
 *  not JSON or not an object. */
function parseRecord(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `limit.context` of a record, or undefined when it is missing or not a
 *  positive number. */
function contextWindowOf(record: Record<string, unknown>): number | undefined {
  const limit = record.limit as { context?: unknown } | null | undefined;
  const context = limit?.context;
  return typeof context === "number" && Number.isFinite(context) && context > 0 ? context : undefined;
}

/** The effort levels a record's `variants` name, in the order opencode lists
 *  them. 1.x gives an object keyed by level; 2.x's API gives an array of
 *  `{id}`. Missing, null, empty or any other shape names none. */
function effortLevelsOf(record: Record<string, unknown>): string[] {
  const variants = record.variants;
  let names: unknown[] = [];
  if (Array.isArray(variants)) names = variants.map((v) => (v as { id?: unknown } | null)?.id);
  else if (variants && typeof variants === "object") names = Object.keys(variants);
  return [...new Set(names.filter((n): n is string => typeof n === "string" && n.trim() !== ""))];
}

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

/** Discovery must never take the gateway with it: it runs on a timer, and an
 *  opencode that hangs is a reason to have no catalog, not a reason to stall. */
const DISCOVERY_TIMEOUT_MS = 14_000;

/** SIGTERM now, SIGKILL a second later if that was not enough. Returns the
 *  pending kill so a close that arrives first can cancel it. */
function killGracefully(proc: ChildProcess): NodeJS.Timeout {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  return setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 1000);
}

/** What one `opencode models` run printed on stdout and how it exited. stderr
 *  is for the log only: it is not model output, and a stderr line landing
 *  inside a multi-line JSON record would cost that model its window. */
interface ModelsRun {
  stdout: string;
  /** Exit code, or null when the process was killed or never started. */
  code: number | null;
}

/** Run `opencode <args>` once. Best-effort, the shape every other discovery in
 *  this directory uses: any failure resolves to an empty run, never a throw. */
function runOpencodeModels(bin: string, args: string[]): Promise<ModelsRun> {
  return new Promise<ModelsRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (stderr.trim()) logger.debug(`opencode ${args.join(" ")} stderr: ${stderr.trim().slice(0, 500)}`);
      resolve({ stdout, code });
    };
    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    try {
      const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      timer = setTimeout(() => {
        killTimer = killGracefully(proc);
        finish(null);
      }, DISCOVERY_TIMEOUT_MS);
      proc.on("close", (code) => {
        stopTimers();
        finish(code);
      });
      proc.on("error", (e) => {
        stopTimers();
        logger.warn(`opencode models failed: ${e.message}`);
        stdout = "";
        finish(null);
      });
    } catch (e) {
      stopTimers();
      logger.warn(`opencode models spawn failed: ${e instanceof Error ? e.message : e}`);
      stdout = "";
      finish(null);
    }
  });
}

/** OpenCode 2.x's records, from its server API. 1.x has no `api` command and
 *  exits 1 within a second, so a 1.x build that got this far loses nothing. */
const API_MODELS_ARGS = ["api", "model.list", "--standalone"];

/** The plain list, tried in this order when neither run above gave anything.
 *  OpenCode 2.x lists from a private server only with `--standalone` (without
 *  it `models` starts and depends on its background service, which can fail
 *  outright); 1.x rejects that flag, so a build that does is asked again
 *  without it. */
const PLAIN_MODELS_ARGS: string[][] = [["models", "--standalone"], ["models"]];

/** Run `opencode models --verbose` and return what the installed CLI exposes.
 *
 *  `--verbose` is what carries the context windows and variants on 1.x, but
 *  OpenCode 2.x exits 1 with "Unrecognized flag: --verbose". When that run
 *  exits non-zero or lists no models, the same records are asked of 2.x's API.
 *  Only when that gives nothing either is the plain list used, without windows
 *  or variants, so such a build still keeps its catalogue. */
export async function discoverOpencodeModels(bin: string): Promise<ModelInfo[]> {
  const verbose = await runOpencodeModels(bin, ["models", "--verbose"]);
  const withWindows = parseOpencodeModels(verbose.stdout);
  if (verbose.code === 0 && withWindows.length > 0) return withWindows;
  const api = await runOpencodeModels(bin, API_MODELS_ARGS);
  const fromApi = api.code === 0 ? parseOpencodeApiModels(api.stdout) : [];
  if (fromApi.length > 0) return fromApi;
  for (const args of PLAIN_MODELS_ARGS) {
    const plain = parseOpencodeModels((await runOpencodeModels(bin, args)).stdout);
    if (plain.length > 0) return plain;
  }
  return withWindows;
}
