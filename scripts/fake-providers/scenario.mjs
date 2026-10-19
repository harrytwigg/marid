// Scripted outcomes and the invocation ledger shared by the fake provider binaries
// (fake-claude.mjs here, the opencode fixture next to the gateway's engine tests).
//
// A scenario file (FAKE_PROVIDER_SCENARIO=<path>) maps an invocation to what the
// fake provider does with it:
//
//   {
//     "claude": {
//       "profile-a|opus": ["rate-limit", "ok"],      // limited the first time, ok after
//       "profile-b|*": "ok",
//       "*": { "outcome": "rate-limit", "resetsAt": 4102444800 }
//     },
//     "opencode": {
//       "x-provider/model-x": "rate-limit",
//       "*": "ok"
//     }
//   }
//
// Claude keys are `<profile>|<model>`: the profile is the base name of CLAUDE_CONFIG_DIR
// (`default` for the gateway's own profile) and the model is the `--model` value. Opencode
// keys are `provider/model`. Lookup tries the exact key, `<profile>|*`, `*|<model>`, then
// `*`. A value is an outcome name, an outcome object, or a list of either: the nth
// invocation that matched the key takes the nth item, and the last one repeats.
//
// Outcomes: ok, rate-limit (optional resetsAt, in epoch seconds), hang, fail (optional
// error), signed-out (claude only), retry-abandon (opencode only: a retry due far off,
// which server mode turns into a rate limit). An unmatched invocation is `ok`.
//
// Every invocation that takes an outcome is appended to the JSONL ledger
// (FAKE_PROVIDER_LEDGER=<path>), which is also how the nth invocation is counted, so the
// ledger is the single source of truth for what ran. A scenario file may carry a
// `_generation` marker: rows are stamped with it and only rows of the current generation
// are counted, so a rewritten scenario starts every sequence over.
import fs from "node:fs";
import path from "node:path";

/** The marker a scenario file may carry to start every sequence over. */
export const GENERATION_KEY = "_generation";

export const OUTCOMES = ["ok", "rate-limit", "hang", "fail", "signed-out", "retry-abandon"];

/** The tag a scenario puts in its prompts so a ledger row can be tied to its session, and the marks it puts in messages to see them carried. */
const TAG_PATTERN = /fc-tag-[a-z0-9]+/;
const MARK_PATTERN = /fc-mark-[a-z0-9]+/g;

/** A value in a scenario file as an outcome object, or a problem sentence. */
export function parseOutcome(raw) {
  const outcome = typeof raw === "string" ? { outcome: raw } : raw;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return { problem: `not an outcome: ${JSON.stringify(raw)}` };
  if (!OUTCOMES.includes(outcome.outcome)) return { problem: `unknown outcome "${outcome.outcome}" (${OUTCOMES.join(", ")})` };
  if (outcome.resetsAt !== undefined && !(Number.isFinite(outcome.resetsAt) && outcome.resetsAt > 0)) {
    return { problem: `resetsAt must be a Unix time in seconds: ${JSON.stringify(outcome.resetsAt)}` };
  }
  return { outcome: { ...outcome } };
}

const isMapping = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Problems with one section of a scenario document. */
function sectionProblems(engine, section) {
  if (engine !== "claude" && engine !== "opencode") return [`unknown section "${engine}" (claude, opencode)`];
  if (!isMapping(section)) return [`${engine} must map keys to outcomes`];
  return Object.entries(section).flatMap(([key, value]) => {
    const items = Array.isArray(value) ? value : [value];
    const empty = items.length === 0 ? [`${engine}["${key}"] lists no outcome`] : [];
    return [...empty, ...items.map((item) => parseOutcome(item).problem).filter(Boolean).map((problem) => `${engine}["${key}"]: ${problem}`)];
  });
}

/** Problems with a scenario document (empty = valid). */
export function scenarioProblems(scenario) {
  if (!isMapping(scenario)) return ["a scenario is an object with a claude and an opencode section"];
  return Object.entries(scenario).filter(([engine]) => engine !== GENERATION_KEY).flatMap(([engine, section]) => sectionProblems(engine, section));
}

/** The scenario file named by the environment, or an empty scenario when none is. */
export function loadScenario(file = process.env.FAKE_PROVIDER_SCENARIO) {
  if (!file) return {};
  const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = scenarioProblems(scenario);
  if (problems.length > 0) throw new Error(`bad scenario ${file}: ${problems.join("; ")}`);
  return scenario;
}

/** The label a Claude profile directory goes by in scenario keys. */
export function profileLabel(configDir, defaultLabels = [".claude", ".claude-sandbox"]) {
  if (!configDir) return "default";
  const base = path.basename(configDir.replace(/\/+$/, ""));
  return defaultLabels.includes(base) ? "default" : base;
}

/** Keys a Claude invocation matches, most specific first. */
export function claudeKeys(profile, model) {
  return [`${profile}|${model}`, `${profile}|*`, `*|${model}`, "*"];
}

/** Keys an opencode invocation matches, most specific first. */
export function opencodeKeys(model) {
  return [model, `${model.split("/")[0]}/*`, "*"];
}

/** Every ledger row, oldest first. A missing ledger is an empty one. */
export function readLedger(file = process.env.FAKE_PROVIDER_LEDGER) {
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * The outcome for this invocation, and the key of the scenario entry that gave it. The nth
 * invocation of an entry takes the nth item of its list (counted from the ledger), the
 * last item repeats, and an invocation no entry matches is `ok`.
 */
export function pickOutcome(scenario, engine, keys, ledger = readLedger()) {
  const section = scenario[engine] ?? {};
  const key = keys.find((candidate) => Object.hasOwn(section, candidate));
  if (key === undefined) return { outcome: { outcome: "ok" }, scenarioKey: null, step: 0 };
  const items = Array.isArray(section[key]) ? section[key] : [section[key]];
  const generation = scenario[GENERATION_KEY] ?? null;
  const step = ledger.filter((row) => row.engine === engine && row.scenarioKey === key && row.consumed && (row.generation ?? null) === generation).length;
  const parsed = parseOutcome(items[Math.min(step, items.length - 1)]);
  if (parsed.problem) throw new Error(`${engine}["${key}"]: ${parsed.problem}`);
  return { outcome: parsed.outcome, scenarioKey: key, step };
}

/** The scenario tag inside a prompt, if the prompt carries one. */
export function promptTag(text) {
  return String(text ?? "").match(TAG_PATTERN)?.[0] ?? null;
}

/** Every message mark inside a prompt, once each: how a scenario sees the conversation carried into a fresh run. */
export function promptMarks(text) {
  return [...new Set(String(text ?? "").match(MARK_PATTERN) ?? [])];
}

/** The start of a prompt as the ledger keeps it: one line, bounded. */
export function promptHead(text, limit = 160) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Append one invocation to the ledger. A fake without a ledger path writes none. */
export function appendLedger(row, file = process.env.FAKE_PROVIDER_LEDGER) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...row })}\n`);
}

/** Whether a fake provider is in scenario mode, in which prompt text carries no directives. */
export function scenarioMode() {
  return Boolean(process.env.FAKE_PROVIDER_SCENARIO);
}
