// Scenario outcomes for fake-opencode.mjs, taken from the same scenario file the fake
// Claude reads (FAKE_PROVIDER_SCENARIO; format and keys in scripts/fake-providers/scenario.mjs).
// An opencode key is the turn's `provider/model`: `-m` on a run turn, the model in the
// prompt body on a server turn.
//
// Server mode turns an outcome into the directive the fixture already knows, so the event
// order is the one the adapter's own tests pin: a rate limit is PROVIDERGIVEUP (retry
// statuses, then session.error, idle and the reply's error), retry-abandon is PROVIDERWAIT
// (a retry an hour off, which the adapter abandons as a rate limit), fail is FAIL.
// Run mode prints the `error` event a real `opencode run --format json` prints, in the 1.x
// shape or, with `"form": "v2"` on the outcome or an OpenCode 2 `FAKE_OPENCODE_VERSION`,
// in 2.x's. While a scenario file is set, a prompt's own words steer nothing.
import { appendLedger, loadScenario, opencodeKeys, pickOutcome, promptHead, promptMarks, promptTag, scenarioMode } from "../../../../../../scripts/fake-providers/scenario.mjs";

export { scenarioMode };

/** What 1.x says when a Go or provider usage limit ends a turn (GoUsageLimitError's message). */
export const RATE_LIMIT_TEXT = "Usage limit reached. It will reset in 3 hours.";
/** What a turn says when opencode abandons a retry it would not make for an hour. */
export const RETRY_ABANDON_TEXT = "Usage limit reached. It will reset in 3 hours; opencode would not retry it for 60 min";

const DIRECTIVES = { ok: "", "rate-limit": "PROVIDERGIVEUP", "retry-abandon": "PROVIDERWAIT", fail: "FAIL", hang: "HANG", "signed-out": "FAIL" };

/** The outcome for one turn, recorded in the ledger. */
export function takeOutcome({ model, resume, text, mode, sessionId }) {
  const scenario = loadScenario();
  const { outcome, scenarioKey, step } = pickOutcome(scenario, "opencode", opencodeKeys(model));
  appendLedger({
    engine: "opencode", mode, profileDir: null, profile: null, model, resume: resume ?? null,
    sessionId: sessionId ?? resume ?? null, promptHead: promptHead(text), tag: promptTag(text), marks: promptMarks(text), outcome: outcome.outcome, scenarioKey, step, generation: scenario._generation ?? null, consumed: true,
  });
  return outcome;
}

/**
 * Server mode: the turn as the fixture sees it. `directive` is the only text its directive
 * checks read, and `shown` is what an answer echoes; `limitMessage` is the limit's wording.
 */
export function serverTurnPlan({ model, resume, text }) {
  const outcome = takeOutcome({ model, resume, text, mode: "server" });
  return {
    directive: DIRECTIVES[outcome.outcome] ?? "",
    shown: text,
    limitMessage: outcome.outcome === "rate-limit" || outcome.outcome === "retry-abandon" ? RATE_LIMIT_TEXT : undefined,
  };
}

/** The model a server prompt names, as `provider/model`, or `default` when it names none. */
export function bodyModel(body) {
  return body?.model?.providerID && body.model.modelID ? `${body.model.providerID}/${body.model.modelID}` : "default";
}

function errorEvent(sessionID, message, form) {
  const error = form === "v2"
    ? { type: "provider.rate-limit", message, status: 429, response: { body: JSON.stringify({ error: { message } }) } }
    : { name: "APIError", data: { message, statusCode: 429, isRetryable: true } };
  return { type: "error", sessionID, error };
}

/** The lines a run turn prints for an outcome, and the exit code that follows them. */
export function runTurnLines(outcome, { sessionID, model, version }) {
  const form = outcome.form ?? (version?.startsWith("v2:") ? "v2" : "v1");
  const accounting = { type: "step_finish", sessionID, part: { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } } } };
  switch (outcome.outcome) {
    case "rate-limit": return { lines: [errorEvent(sessionID, RATE_LIMIT_TEXT, form)], code: 1 };
    case "retry-abandon": return { lines: [errorEvent(sessionID, RETRY_ABANDON_TEXT, form)], code: 1 };
    case "signed-out":
    case "fail": return { lines: [{ type: "error", sessionID, error: { name: "APIError", data: { message: outcome.error ?? "upstream exploded", statusCode: 500 } } }], code: 1 };
    case "hang": return { lines: [], code: null };
    default: return { lines: [{ type: "text", sessionID, part: { type: "text", text: `fc-ok engine=opencode model=${model} mode=run` } }, accounting], code: 0 };
  }
}

/**
 * `opencode models [--verbose]`: the models the instance was seeded with (FAKE_PROVIDER_OPENCODE_MODELS,
 * comma separated) and any the scenario names, so a chain link never reads as unserved because of
 * which scenario happened to be loaded when the gateway last refreshed its listing.
 */
export function modelsListing(verbose) {
  const seeded = (process.env.FAKE_PROVIDER_OPENCODE_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
  const named = Object.keys(loadScenario().opencode ?? {}).filter((key) => key.includes("/") && !key.includes("*"));
  const models = [...new Set([...seeded, ...named, "opencode/fake-default"])];
  return models.map((key) => {
    const [providerID, ...rest] = key.split("/");
    const record = JSON.stringify({ id: rest.join("/"), providerID, name: rest.join("/"), limit: { context: 200000, output: 8192 }, variants: {} }, null, 2);
    return verbose ? `${key}\n${record}` : key;
  }).join("\n");
}
