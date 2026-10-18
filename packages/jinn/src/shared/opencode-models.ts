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
 * Only the context window is taken from the record (`limit.context`), for the
 * context meter; plain `opencode models` has none. Nothing else is claimed
 * about capability, and `--variant` (the reasoning-effort flag) is
 * provider-specific with no list to validate against. So no model here
 * declares effort support: an effort picker that silently changes nothing is
 * worse than no picker, and a bad variant is an error the turn discovers at
 * the provider.
 */

/** One `provider/model` line. The model half may itself contain slashes
 *  (`openrouter/meta-llama/llama-4`), so only the FIRST slash is structural —
 *  the same split the engine does when handing `-m` back to opencode. */
const MODEL_LINE = /^([A-Za-z0-9_.-]+)\/(\S+)$/;

/** Strip terminal colour/cursor escapes. */
const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** `limit.context` of one model's `--verbose` JSON, or undefined when it is
 *  missing, not a positive number, or the text is not JSON at all. */
function contextWindowOf(json: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    const limit = (parsed as { limit?: { context?: unknown } } | null)?.limit;
    const context = limit?.context;
    return typeof context === "number" && Number.isFinite(context) && context > 0 ? context : undefined;
  } catch {
    return undefined;
  }
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
 * `}` alone on a line. Its `limit.context` becomes the model's `contextWindow`.
 * A model with no object, a cut-off one or one that is not JSON simply has no
 * window — never a guessed one.
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

/** The object is complete (or cut off): give its model the window it states. */
function closeObject(reader: Reader): void {
  const window = reader.current && reader.json ? contextWindowOf(reader.json.join("\n")) : undefined;
  if (reader.current && window !== undefined) reader.current.contextWindow = window;
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

/** The operator's configured `contextWindow` for a model wins over the one
 *  opencode reports: it is the operator's own statement about a model (a
 *  provider limit opencode does not know, a self-imposed cap). Nothing else of
 *  the `models.opencode` block is applied to a discovered catalog. */
export function withConfiguredWindows(models: ModelInfo[], block: EngineModelsConfig | undefined): ModelInfo[] {
  const configured = new Map<string, number>();
  for (const entry of block?.models ?? []) {
    // A zero, negative or NaN window states nothing: keep the discovered one.
    if (typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0) {
      configured.set(entry.id, entry.contextWindow);
    }
  }
  if (configured.size === 0) return models;
  return models.map((model) => {
    const window = configured.get(model.id);
    return window === undefined ? model : { ...model, contextWindow: window };
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
 *  this directory uses: any failure resolves to an empty run, never a throw.
 *  `env` is the whole environment of the child; absent, it inherits the gateway's. */
function runOpencodeModels(bin: string, args: string[], env: Record<string, string> | undefined): Promise<ModelsRun> {
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
      const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
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

/** The plain list, tried in this order when `--verbose` gave nothing. OpenCode
 *  2.x lists from a private server only with `--standalone` (without it `models`
 *  starts and depends on its background service, which can fail outright);
 *  1.x rejects that flag, so a build that does is asked again without it. */
const PLAIN_MODELS_ARGS: string[][] = [["models", "--standalone"], ["models"]];

/** Run `opencode models --verbose` and return what the installed CLI exposes.
 *
 *  `--verbose` is what carries the context windows, but not every build has it:
 *  OpenCode 2.x exits 1 with "Unrecognized flag: --verbose". When that run
 *  exits non-zero or lists no models, the plain list is used instead, without
 *  windows, so such a build keeps its catalogue.
 *
 *  `env` is the environment of every opencode this starts. `shared/` may not
 *  import `engines/`, where Marid's own opencode variables (`OPENCODE_DISABLE_FFF`)
 *  are defined, so the caller builds it and hands it in; omitted, the gateway's
 *  own environment is inherited. */
export async function discoverOpencodeModels(bin: string, env?: Record<string, string>): Promise<ModelInfo[]> {
  const verbose = await runOpencodeModels(bin, ["models", "--verbose"], env);
  const withWindows = parseOpencodeModels(verbose.stdout);
  if (verbose.code === 0 && withWindows.length > 0) return withWindows;
  for (const args of PLAIN_MODELS_ARGS) {
    const plain = parseOpencodeModels((await runOpencodeModels(bin, args, env)).stdout);
    if (plain.length > 0) return plain;
  }
  return withWindows;
}
