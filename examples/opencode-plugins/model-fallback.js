/**
 * opencode-model-fallback (OpenCode 2): switch a session to a fallback model
 * when its provider rate-limits it. Replaces `opencode-rate-limit` (an
 * OpenCode 1 plugin that cannot load on 2.x) and reads the same
 * `rate-limit-fallback.json`.
 *
 * How it works. OpenCode 2 asks the `retry` session hook before it retries a
 * failed model call. On a rate-limit or quota error this plugin switches the
 * session to the next usable fallback model and lets the retry go ahead. The
 * retried step runs on the fallback model, inside the same assistant message
 * of the same execution: there is no abort and no re-sent user message (the
 * OpenCode 1 plugin aborted the session and re-posted the prompt). Clients see
 * `session.model.selected`, `session.retry.scheduled`, then a
 * `session.step.started` naming the fallback model.
 *
 * When the execution ends, the session is switched back to the model it had
 * before the fallback (`restoreModel`, default on), so the next prompt starts
 * on the primary again, as each OpenCode 1 prompt did. A model that was
 * rate-limited stays in cooldown for `cooldownMs`; an error on a model that is
 * still cooling down falls back with no delay.
 *
 * Config (`rate-limit-fallback.json`, first found in the project's
 * `.opencode/`, `~/.opencode/`, the OpenCode config directory; then the
 * plugin entry's `options`):
 *   enabled          default true
 *   fallbackModels   [{ providerID, modelID }], tried in order, for every model;
 *                    or one such list per model the session started on:
 *                    { "<provider>/<model>": [...], "*": [...] }, where "*"
 *                    is the list for a model not named (none: no fallback),
 *                    and [] turns fallback off for that model
 *   fallbackMode     "stop" (default): when no fallback is usable, leave
 *                    OpenCode's own retry decision alone; "cycle": start again
 *                    from the first fallback that is not cooling down;
 *                    "retry-last": try the last fallback once more
 *   cooldownMs       how long a rate-limited model is skipped (default 60000)
 *   retryPolicy      { maxRetries (fallbacks per execution, default 3),
 *                      strategy "immediate"|"linear"|"exponential",
 *                      baseDelayMs, maxDelayMs, jitterEnabled, jitterFactor }
 *   circuitBreaker   { enabled, failureThreshold, recoveryTimeoutMs }: a model
 *                    with that many rate limits in a row is not chosen as a
 *                    fallback until recoveryTimeoutMs has passed
 *   restoreModel     default true
 *   verbose          log every decision
 * Other `opencode-rate-limit` keys (health tracking, metrics, dynamic
 * prioritisation, statistics) are ignored.
 *
 * It adds the `/rate-limit-status` command, which posts the cooldown and
 * circuit state into the session as a synthetic message (the model then runs
 * on it, as the OpenCode 1 command had the model call a status tool).
 *
 * The default export is the plugin definition `{ id, setup }`; keep it the
 * module's only export.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "opencode-model-fallback";
const CONFIG_FILE = "rate-limit-fallback.json";

const DEFAULTS = {
  enabled: true,
  fallbackModels: [],
  fallbackMode: "stop",
  cooldownMs: 60_000,
  retryPolicy: { maxRetries: 3, strategy: "immediate", baseDelayMs: 1000, maxDelayMs: 30_000, jitterEnabled: false, jitterFactor: 0.1 },
  circuitBreaker: { enabled: false, failureThreshold: 5, recoveryTimeoutMs: 60_000 },
  restoreModel: true,
  verbose: false,
};

const RATE_LIMIT_TYPES = new Set(["provider.rate-limit", "provider.quota"]);
const RATE_LIMIT_TEXT = [/\b429\b/, /rate[\s_-]?limit/i, /quota exceeded/i, /usage limit/i, /too many requests/i, /resource[\s_-]?exhausted/i];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function loadConfig(directory, options) {
  const home = process.env.HOME || homedir();
  const configDir = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const candidates = [];
  if (directory) candidates.push(join(directory, ".opencode", CONFIG_FILE));
  candidates.push(join(home, ".opencode", CONFIG_FILE), join(configDir, CONFIG_FILE));
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
  const merged = { ...DEFAULTS, ...file, ...(options ?? {}) };
  merged.retryPolicy = { ...DEFAULTS.retryPolicy, ...(file.retryPolicy ?? {}), ...(options?.retryPolicy ?? {}) };
  merged.circuitBreaker = { ...DEFAULTS.circuitBreaker, ...(file.circuitBreaker ?? {}), ...(options?.circuitBreaker ?? {}) };
  merged.chains = fallbackChains(merged.fallbackModels);
  return { config: merged, source };
}

const keyOf = (providerID, modelID) => `${providerID}/${modelID}`;
const isModel = (m) => m && typeof m.providerID === "string" && typeof m.modelID === "string";

/**
 * `fallbackModels` as chains, by the model a session started on: a list is
 * the chain for every model ("*"); an object names a chain per
 * `provider/model`, with "*" for the rest. Entries that are not
 * `{ providerID, modelID }` are dropped. A model named with an empty chain
 * (or one with nothing valid in it) keeps it: no fallback for that model,
 * rather than the "*" chain.
 */
function fallbackChains(fallbackModels) {
  const chains = new Map();
  const models = (list) => (Array.isArray(list) ? list.filter(isModel) : []);
  if (Array.isArray(fallbackModels)) {
    if (models(fallbackModels).length) chains.set("*", models(fallbackModels));
  } else if (fallbackModels && typeof fallbackModels === "object") {
    for (const [key, list] of Object.entries(fallbackModels)) chains.set(key, models(list));
  }
  return chains;
}

/** Whether any model has somewhere to fall back to. */
function hasFallbacks(chains) {
  return [...chains.values()].some((list) => list.length > 0);
}

/** The chain for a session that started on `origin`: its own (empty: none), else "*". */
function chainFor(config, origin) {
  return config.chains.get(origin) ?? config.chains.get("*") ?? [];
}

/** All the chains, for a log line: "origin → a, b; …". */
function describeChains(chains) {
  return [...chains].map(([origin, list]) => `${origin} → ${list.map((m) => keyOf(m.providerID, m.modelID)).join(", ") || "(none)"}`).join("; ");
}

/** True when a session error is a provider rate limit or quota error. */
function isRateLimitError(error) {
  if (!error) return false;
  if (RATE_LIMIT_TYPES.has(error.type) || error.status === 429) return true;
  const text = `${error.message ?? ""} ${error.response?.body ?? ""}`;
  return RATE_LIMIT_TEXT.some((re) => re.test(text));
}

function delayFor(policy, n) {
  const base = Math.max(0, Number(policy.baseDelayMs) || 0);
  let delay = policy.strategy === "exponential" ? base * Math.pow(2, n) : policy.strategy === "linear" ? base * (n + 1) : 0;
  delay = Math.min(delay, Math.max(0, Number(policy.maxDelayMs) || delay));
  if (policy.jitterEnabled && delay > 0) {
    const f = Number.isFinite(Number(policy.jitterFactor)) ? Number(policy.jitterFactor) : 0.1;
    delay = delay * (1 - f + Math.random() * 2 * f);
  }
  return Math.round(delay);
}

function createState(config, now = () => Date.now()) {
  const cooldown = new Map(); // model key -> rate-limited at
  const circuit = new Map(); // model key -> { failures, openedAt }
  const sessions = new Map(); // sessionID -> { origin, attempted:Set, fallbacks, restore }
  let totalFallbacks = 0;

  const inCooldown = (key) => {
    const at = cooldown.get(key);
    if (at === undefined) return false;
    if (now() - at > config.cooldownMs) {
      cooldown.delete(key);
      return false;
    }
    return true;
  };
  const circuitOpen = (key) => {
    if (!config.circuitBreaker.enabled) return false;
    const c = circuit.get(key);
    if (!c?.openedAt) return false;
    if (now() - c.openedAt > config.circuitBreaker.recoveryTimeoutMs) {
      circuit.set(key, { failures: 0, openedAt: undefined }); // half-open: the next failure counts from zero
      return false;
    }
    return true;
  };
  const usable = (m, attempted) => {
    const k = keyOf(m.providerID, m.modelID);
    return !attempted.has(k) && !inCooldown(k) && !circuitOpen(k);
  };

  return {
    session(id) {
      let s = sessions.get(id);
      if (!s) sessions.set(id, (s = { origin: undefined, attempted: new Set(), fallbacks: 0, restore: undefined }));
      return s;
    },
    endSession(id) {
      const s = sessions.get(id);
      sessions.delete(id);
      return s;
    },
    rateLimited(key) {
      const was = inCooldown(key);
      cooldown.set(key, now());
      const c = circuit.get(key) ?? { failures: 0, openedAt: undefined };
      c.failures += 1;
      if (config.circuitBreaker.enabled && c.failures >= config.circuitBreaker.failureThreshold && !c.openedAt) c.openedAt = now();
      circuit.set(key, c);
      return was;
    },
    succeeded(key) {
      circuit.delete(key);
    },
    /** The next model in `list` (the session's chain) after `currentKey`. */
    select(list, currentKey, attempted) {
      const at = list.findIndex((m) => keyOf(m.providerID, m.modelID) === currentKey);
      const ordered = [...list.slice(at + 1), ...list.slice(0, Math.max(0, at + 1))];
      const next = ordered.find((m) => usable(m, attempted));
      if (next) return next;
      if (config.fallbackMode === "cycle") {
        return list.find((m) => keyOf(m.providerID, m.modelID) !== currentKey && !inCooldown(keyOf(m.providerID, m.modelID)) && !circuitOpen(keyOf(m.providerID, m.modelID)));
      }
      if (config.fallbackMode === "retry-last") {
        const last = list.at(-1);
        if (last && keyOf(last.providerID, last.modelID) !== currentKey && !circuitOpen(keyOf(last.providerID, last.modelID))) return last;
      }
      return undefined; // "stop"
    },
    countFallback() {
      totalFallbacks += 1;
    },
    report() {
      const lines = [`### ${PLUGIN_ID}`, "", `Fallbacks since start: ${totalFallbacks}`, "", "| model | cooling down | rate limits in a row | circuit |", "|---|---|---|---|"];
      const chained = [...config.chains.values()].flat().map((m) => keyOf(m.providerID, m.modelID));
      const keys = new Set([...cooldown.keys(), ...circuit.keys(), ...chained]);
      for (const k of keys) {
        const at = cooldown.get(k);
        const left = at === undefined || !inCooldown(k) ? "no" : `${Math.ceil((config.cooldownMs - (now() - at)) / 1000)} s left`;
        const c = circuit.get(k);
        lines.push(`| ${k} | ${left} | ${c?.failures ?? 0} | ${circuitOpen(k) ? "open" : "closed"} |`);
      }
      return lines.join("\n");
    },
  };
}

function makeLogger(verbose) {
  const prefix = `[${PLUGIN_ID}]`;
  return {
    info: (...a) => console.log(prefix, ...a),
    debug: verbose ? (...a) => console.log(prefix, ...a) : () => {},
    warn: (...a) => console.warn(prefix, ...a),
  };
}

async function watchExecutions(ctx, state, log) {
  // Restore the pre-fallback model and close the per-execution state when an execution ends.
  const lastModel = new Map();
  for await (const event of ctx.event.subscribe()) {
    const sessionID = event?.data?.sessionID;
    if (!sessionID) continue;
    if (event.type === "session.step.started" && event.data.model) lastModel.set(sessionID, event.data.model);
    if (event.type === "session.step.ended") {
      const m = lastModel.get(sessionID);
      if (m) state.succeeded(keyOf(m.providerID, m.id));
    }
    if (!/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) continue;
    lastModel.delete(sessionID);
    const s = state.endSession(sessionID);
    if (!s?.restore) continue;
    try {
      const session = await ctx.session.get({ sessionID });
      const now = session?.model ?? session?.data?.model;
      if (now && keyOf(now.providerID, now.id) !== s.restore.switchedTo) {
        log.debug(`session ${sessionID} changed model since the fallback; leaving it`);
        continue;
      }
      await ctx.session.switchModel({ sessionID, model: s.restore.model });
      log.info(`session ${sessionID}: back on ${keyOf(s.restore.model.providerID, s.restore.model.id)} after the fallback`);
    } catch (error) {
      log.warn(`could not restore the model of ${sessionID}: ${error?.message ?? error}`);
    }
  }
}

export default {
  id: PLUGIN_ID,
  setup: async (ctx) => {
    const { config, source } = loadConfig(ctx.location?.directory, ctx.options);
    const log = makeLogger(Boolean(config.verbose));
    if (!config.enabled || !hasFallbacks(config.chains)) {
      log.info(config.enabled ? "no fallbackModels configured; inactive" : "disabled by config");
      return;
    }
    const state = createState(config);
    const controller = new AbortController();

    await ctx.session.hook("retry", async (input) => {
      if (!isRateLimitError(input.error)) return;
      const current = keyOf(input.model.providerID, input.model.id);
      const s = state.session(input.sessionID);
      const wasCooling = state.rateLimited(current);
      // The chain follows the model the session was on when this execution
      // first hit a limit, through every fallback after it.
      s.origin ??= current;
      s.attempted.add(current);
      if (s.fallbacks >= config.retryPolicy.maxRetries) {
        log.info(`session ${input.sessionID}: ${s.fallbacks} fallbacks already this execution; leaving the retry to OpenCode`);
        return;
      }
      const next = state.select(chainFor(config, s.origin), current, s.attempted);
      if (!next) {
        log.info(`session ${input.sessionID}: no usable fallback for ${current} (chain of ${s.origin}, mode ${config.fallbackMode}); leaving the retry to OpenCode`);
        return;
      }
      const model = { providerID: next.providerID, id: next.modelID };
      try {
        await ctx.session.switchModel({ sessionID: input.sessionID, model });
      } catch (error) {
        log.warn(`session ${input.sessionID}: switching to ${keyOf(model.providerID, model.id)} failed: ${error?.message ?? error}`);
        return;
      }
      if (config.restoreModel && !s.restore) s.restore = { model: { ...input.model }, switchedTo: keyOf(model.providerID, model.id) };
      else if (s.restore) s.restore.switchedTo = keyOf(model.providerID, model.id);
      s.attempted.add(keyOf(model.providerID, model.id));
      const delay = wasCooling ? 0 : delayFor(config.retryPolicy, s.fallbacks);
      s.fallbacks += 1;
      state.countFallback();
      input.decision = { retry: true, delay };
      log.info(`session ${input.sessionID}: ${current} rate-limited (${input.error.type}); falling back to ${keyOf(model.providerID, model.id)} in ${delay}ms`);
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "rate-limit-status",
        description: "Show fallback cooldowns and circuit-breaker state",
        execute: async ({ sessionID }) => {
          await ctx.session.synthetic({ sessionID, text: state.report(), description: "rate-limit-status", resume: true });
        },
      });
    });

    void watchExecutions(ctx, state, log).catch((error) => {
      if (!controller.signal.aborted) log.warn(`event watch stopped: ${error?.message ?? error}`);
    });

    log.info(
      `armed: ${describeChains(config.chains)} (mode ${config.fallbackMode}, cooldown ${config.cooldownMs}ms)${source ? ` (config ${source})` : ""}`,
    );
    return () => controller.abort();
  },
};
