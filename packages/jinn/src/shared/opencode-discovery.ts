import { spawn, type ChildProcess } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";
import { parseOpencodeModels } from "./opencode-models.js";
import { parseOpencodeApiModels } from "./opencode-model-records.js";

/** Discovery must never take the gateway with it: it runs on a timer, and an
 *  opencode that hangs is a reason to have no catalog, not a reason to stall. */
const DISCOVERY_TIMEOUT_MS = 14_000;

/** How long a `--verbose` run still going at the discovery timeout may keep
 *  running behind the plain list. The first run on a fresh opencode home
 *  bootstraps its instance before it lists anything, and has been seen to take
 *  about a minute; killing it there cost the windows and effort levels until the
 *  next periodic refresh, hours later. */
export const DETAILS_TIMEOUT_MS = 120_000;

/** What one discovery found. */
export interface OpencodeDiscovery {
  /** The catalogue to serve now. */
  models: ModelInfo[];
  /** Whether `models` came from `--verbose`, with its windows and effort levels. */
  detailed: boolean;
  /** Set when `--verbose` outlived the discovery timeout and `models` is the
   *  plain list: resolves to that run's catalogue once it finishes, or to
   *  undefined when it fails or outlives {@link DETAILS_TIMEOUT_MS} too. */
  details?: Promise<ModelInfo[] | undefined>;
}

/** What shapes one discovery: the two budgets, overridable so tests need not
 *  wait for real ones, and the environment every opencode it starts gets.
 *
 *  `shared/` may not import `engines/`, where Marid's own opencode variables
 *  (`OPENCODE_DISABLE_FFF`) are defined, so the caller builds `env` and hands it
 *  in. It is the whole environment of the child; omitted, the gateway's own is
 *  inherited. */
export interface DiscoveryOptions {
  timeoutMs?: number;
  detailsTimeoutMs?: number;
  env?: Record<string, string>;
}

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

interface RunningModels {
  done: Promise<ModelsRun>;
  /** Stop the run holding the process open: a CLI that served the plain list
   *  exits instead of waiting out a slow `--verbose`. The gateway is kept alive
   *  by its server, so there the run still finishes and lands. */
  detach: () => void;
  /** End the run now; `done` resolves when the process closes. */
  stop: () => void;
}

/** Run `opencode <args>` once. Best-effort, the shape every other discovery in
 *  this directory uses: any failure resolves to an empty run, never a throw.
 *  `env` is the child's whole environment; absent, it inherits the gateway's. */
function startOpencodeModels(bin: string, args: string[], timeoutMs: number, env: Record<string, string> | undefined): RunningModels {
  let proc: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<ModelsRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (stderr.trim()) logger.debug(`opencode ${args.join(" ")} stderr: ${stderr.trim().slice(0, 500)}`);
      resolve({ stdout, code });
    };
    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
      const child = proc;
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      timer = setTimeout(() => {
        killTimer = killGracefully(child);
        finish(null);
      }, timeoutMs);
      child.on("close", (code) => {
        stopTimers();
        finish(code);
      });
      child.on("error", (e) => {
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
  return { done, detach: () => detachRun(proc, timer), stop: () => proc && killGracefully(proc).unref() };
}

function detachRun(proc: ChildProcess | undefined, timer: NodeJS.Timeout | undefined): void {
  proc?.unref();
  for (const stream of [proc?.stdout, proc?.stderr]) (stream as { unref?: () => void } | null | undefined)?.unref?.();
  timer?.unref();
}

/** `done`'s value, or undefined when it has not settled within `ms`. */
export function settledWithin<T>(done: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    void done.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
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

/** What to serve when `--verbose` gave nothing (yet): 2.x's API records, with
 *  their windows and variants, else the plain list without them. */
async function fallbackModels(bin: string, timeoutMs: number, env: Record<string, string> | undefined): Promise<{ models: ModelInfo[]; detailed: boolean }> {
  const api = await startOpencodeModels(bin, API_MODELS_ARGS, timeoutMs, env).done;
  const fromApi = api.code === 0 ? parseOpencodeApiModels(api.stdout) : [];
  if (fromApi.length > 0) return { models: fromApi, detailed: true };
  for (const args of PLAIN_MODELS_ARGS) {
    const plain = parseOpencodeModels((await startOpencodeModels(bin, args, timeoutMs, env).done).stdout);
    if (plain.length > 0) return { models: plain, detailed: false };
  }
  return { models: [], detailed: false };
}

/** A finished `--verbose` run's catalogue, or undefined when it failed. */
function verboseModels(run: ModelsRun): ModelInfo[] | undefined {
  const models = parseOpencodeModels(run.stdout);
  return run.code === 0 && models.length > 0 ? models : undefined;
}

/** Run `opencode models --verbose` and return what the installed CLI exposes.
 *
 *  `--verbose` is what carries the context windows and variants on 1.x, but
 *  OpenCode 2.x exits 1 with "Unrecognized flag: --verbose". When that run
 *  exits non-zero or lists no models, the same records are asked of 2.x's API.
 *  Only when that gives nothing either is the plain list used, without windows
 *  or variants, so such a build still keeps its catalogue. A `--verbose` that is
 *  merely slow is not given up on: the fallback is served at the discovery
 *  timeout and the run goes on, its catalogue arriving through `details`. */
export async function discoverOpencodeModels(bin: string, options: DiscoveryOptions = {}): Promise<OpencodeDiscovery> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const { env } = options;
  const verbose = startOpencodeModels(bin, ["models", "--verbose"], options.detailsTimeoutMs ?? DETAILS_TIMEOUT_MS, env);
  const finished = await settledWithin(verbose.done, timeoutMs);
  if (!finished) {
    verbose.detach();
    const fallback = await fallbackModels(bin, timeoutMs, env);
    if (fallback.detailed) {
      verbose.stop(); // the API's records answered for it
      return fallback;
    }
    logger.info(`opencode models --verbose is still running after ${timeoutMs} ms; serving the plain list until it finishes`);
    return { ...fallback, details: verbose.done.then(verboseModels) };
  }
  const withWindows = verboseModels(finished);
  if (withWindows) return { models: withWindows, detailed: true };
  const fallback = await fallbackModels(bin, timeoutMs, env);
  return fallback.models.length > 0 ? fallback : { models: parseOpencodeModels(finished.stdout), detailed: false };
}
