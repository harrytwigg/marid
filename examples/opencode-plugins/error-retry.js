/**
 * opencode-error-retry (OpenCode 2 port): transparent retry of a pre-stream provider 400.
 *
 * The observed failure is an upstream HTTP 400 that arrives *before* the
 * stream starts, with body exactly `{"model":"<id>"}`. OpenCode treats a 400
 * as terminal (`provider.invalid-request`, no retry), so the step fails and
 * the session's execution fails.
 *
 * This plugin retries that one request at the provider HTTP layer, inside the
 * same model call, so the step never fails and no retry event is emitted: a
 * client of the server only sees the step take longer. Re-sending the
 * identical request re-runs the model call, not the turn: earlier tool results
 * are already messages in that body, so no tool can run twice.
 *
 * It holds no per-session state; the per-request retry cap is the whole loop
 * guard.
 *
 * v1 -> v2: v1 wrapped the provider fetch through `auth.loader` returning
 * `{ fetch }`. OpenCode 2 has no auth hook; it exposes the provider's HTTP
 * exchange as the `http.response` session hook, scoped to one provider, whose
 * `response` a plugin may replace. The default export must be a definition
 * `{ id, setup }`; keep it the module's only export.
 *
 * Options (all optional) come from the plugin entry's `options` in the
 * OpenCode config, then from `error-retry.json` in the project's `.opencode/`,
 * `~/.opencode/` or the OpenCode config directory (first found wins, entry
 * options override the file).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "opencode-error-retry";

const DEFAULT_CONFIG = {
  enabled: true,
  /** The provider whose responses are retried. */
  providerID: "opencode-go",
  /** Retries per request (so maxRetries + 1 requests total), capped at 5. */
  maxRetries: 3,
  /** First backoff; doubles each retry. */
  baseDelayMs: 1000,
  /** Fractional jitter, e.g. 0.2 = ±20%. */
  jitter: 0.2,
  /** "silent" | "info" */
  log: "info",
};

/** True when `text` is JSON with exactly one key, `model`, whose value is a string. */
function isModelOnlyBody(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return false;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === "model" && typeof obj.model === "string";
}

/** Abort-aware sleep: resolves after `ms`, or rejects with the signal's reason. */
function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function makeLogger(level) {
  const silent = level === "silent";
  const prefix = `[${PLUGIN_ID}]`;
  return {
    info: silent ? () => {} : (...a) => console.log(prefix, ...a),
    warn: silent ? () => {} : (...a) => console.warn(prefix, ...a),
  };
}

function loadConfig(directory, options) {
  const home = process.env.HOME || homedir();
  const configDir = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const candidates = [];
  if (directory) candidates.push(join(directory, ".opencode", "error-retry.json"));
  candidates.push(join(home, ".opencode", "error-retry.json"), join(configDir, "error-retry.json"));
  let file = {};
  let source = null;
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    const user = readJson(path);
    if (user && typeof user === "object" && !Array.isArray(user)) {
      file = user;
      source = path;
      break;
    }
  }
  return { config: { ...DEFAULT_CONFIG, ...file, ...(options ?? {}) }, source };
}

/**
 * Abort signals per session, fired when that session's execution ends. An
 * interrupt does not abort the provider request the hook holds, so without
 * this a stopped turn would keep retrying in the background.
 */
function makeStops() {
  const live = new Map(); // sessionID -> Set<AbortController>
  return {
    signal(sessionID, requestSignal) {
      const controller = new AbortController();
      const set = live.get(sessionID) ?? new Set();
      set.add(controller);
      live.set(sessionID, set);
      const onAbort = () => controller.abort(requestSignal.reason);
      if (requestSignal?.aborted) onAbort();
      else requestSignal?.addEventListener("abort", onAbort, { once: true });
      return {
        signal: controller.signal,
        done: () => {
          requestSignal?.removeEventListener("abort", onAbort);
          set.delete(controller);
          if (set.size === 0) live.delete(sessionID);
        },
      };
    },
    stop(sessionID, reason) {
      for (const controller of live.get(sessionID) ?? []) controller.abort(new Error(reason));
    },
  };
}

async function watchExecutions(ctx, stops) {
  for await (const event of ctx.event.subscribe()) {
    const match = /^session\.execution\.(succeeded|failed|interrupted)$/.exec(event?.type ?? "");
    if (match && event.data?.sessionID) stops.stop(event.data.sessionID, `execution ${match[1]}`);
  }
}

function makeRetrier({ config, log, stops }) {
  const maxRetries = Math.min(5, Math.max(0, Number(config.maxRetries) || 0));
  const baseDelayMs = Math.max(0, Number(config.baseDelayMs) || 0);
  const jitter = Number.isFinite(Number(config.jitter)) ? Math.max(0, Number(config.jitter)) : 0;
  const delayFor = (attempt) => {
    const base = baseDelayMs * Math.pow(2, attempt);
    if (jitter === 0) return Math.round(base);
    return Math.round(base * (1 - jitter + Math.random() * 2 * jitter));
  };

  /** True when `res` is the retryable pre-stream 400 (a model-only JSON body). */
  async function isRetryable(res) {
    if (res.status !== 400) return false;
    try {
      return isModelOnlyBody(await res.clone().text());
    } catch {
      return false;
    }
  }

  /** The `http.response` hook: replace a retryable 400 with a retried response. */
  return async function onResponse(input) {
    const request = input.request;
    if (request.method.toUpperCase() !== "POST" || request.signal?.aborted) return;
    if (!(await isRetryable(input.response))) return;
    const stop = stops.signal(input.sessionID, request.signal);
    try {
      await retry(input, stop.signal);
    } finally {
      stop.done();
    }
  };

  async function retry(input, signal) {
    const request = input.request;
    const original = input.response; // only ever cloned, so OpenCode can still read it
    let res = original;
    const discard = async (r) => {
      if (r === original) return;
      try {
        await r.body?.cancel();
      } catch {
        /* nothing to release */
      }
    };
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const delay = delayFor(attempt);
      const endpoint = res.headers?.get?.("x-opencode-endpoint-id") || "unknown";
      log.info(`retry ${attempt + 1}/${maxRetries} after ${delay}ms session=${input.sessionID} kind=${input.kind} endpoint=${endpoint}`);
      let next;
      try {
        await sleep(delay, signal);
        next = await fetch(request.clone(), { signal });
      } catch (error) {
        // Stopped (the execution ended) or the network failed: hand back the
        // last 400 and let OpenCode settle the step as it would have.
        log.warn(`retry ${attempt + 1} gave up: ${error?.message ?? error}`);
        input.response = res;
        return;
      }
      await discard(res);
      res = next;
      if (!(await isRetryable(res))) {
        input.response = res; // a success, or some other answer, is OpenCode's again
        return;
      }
    }
    input.response = res;
    log.warn(`still a model-only 400 after ${maxRetries} retries; passing it on`);
  }
}

export default {
  id: PLUGIN_ID,
  setup: async (ctx) => {
    const { config, source } = loadConfig(ctx.location?.directory, ctx.options);
    const log = makeLogger(config.log);
    if (!config.enabled) {
      log.info("disabled by config; provider responses are left untouched");
      return;
    }
    const stops = makeStops();
    await ctx.session.hook("http.response", makeRetrier({ config, log, stops }), { providerID: config.providerID });
    void watchExecutions(ctx, stops).catch((error) => log.warn(`event watch stopped: ${error?.message ?? error}`));
    log.info(
      `armed for provider "${config.providerID}": retry a pre-stream model-only 400 up to ${config.maxRetries}x (base ${config.baseDelayMs}ms)${source ? ` (config ${source})` : ""}`,
    );
  },
};
