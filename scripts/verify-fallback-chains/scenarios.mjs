// Drives the fallback chain scenarios against a running throwaway instance (started by
// scripts/verify-fallback-chains.sh) through the real HTTP API, and prints PASS, FAIL or
// PENDING for each. A pending scenario waits on runtime work not yet merged: its result is
// reported but never fails the run (a pending scenario that passes is called out, and
// --strict fails the run on it). A connection the network guard refused fails any scenario.
import fs from "node:fs";
import { Harness, parseArgs } from "./lib.mjs";
import { SCENARIOS } from "./scenario-defs.mjs";

const args = parseArgs(process.argv.slice(2));
const csv = (value) => new Set(String(value ?? "").split(",").map((id) => id.trim()).filter(Boolean));
const pending = csv(args.pending);
const only = args.only ? csv(args.only) : undefined;
for (const id of [...pending, ...(only ?? [])]) {
  if (!SCENARIOS.some((scenario) => scenario.id === id)) throw new Error(`unknown scenario id "${id}" (${SCENARIOS.map((scenario) => scenario.id).join(", ")})`);
}

const harness = new Harness(args);
const results = [];

/** What went wrong in one scenario, or undefined: its own assertions, then the network guard's log. */
async function failureOf(scenario) {
  try {
    await harness.reset();
    await scenario.run(harness);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const refused = harness.networkRefusals();
  return refused.length > 0 ? `network guard refused ${refused.length} connection(s): ${refused.map((row) => row.target).join(", ")}` : undefined;
}

/** PASS or FAIL, or for a pending scenario PENDING (not yet) or PENDING-PASSED. A refused connection is never pending. */
function statusOf(scenario, failure) {
  const waiting = pending.has(scenario.id);
  if (failure === undefined) return waiting ? "PENDING-PASSED" : "PASS";
  return waiting && !failure.startsWith("network guard") ? "PENDING" : "FAIL";
}

async function runOne(scenario) {
  const started = Date.now();
  const failure = await failureOf(scenario);
  const status = statusOf(scenario, failure);
  results.push({ id: scenario.id, title: scenario.title, status, detail: failure ?? null, mode: harness.layout.mode, ms: Date.now() - started });
  const label = status === "PENDING-PASSED" ? "PENDING" : status;
  const note = status === "PENDING-PASSED" ? " (passed: it no longer needs to be pending)" : failure ? `\n         ${failure}` : "";
  console.log(`${label.padEnd(7)} ${scenario.id}  ${scenario.title}${note}`);
}

console.log(`Scenarios against ${args.baseUrl} (opencode mode: ${harness.layout.mode})`);
for (const scenario of SCENARIOS) {
  if (!only || only.has(scenario.id)) await runOne(scenario);
}
await harness.reset().catch(() => {});

fs.mkdirSync(new URL(".", `file://${args.results}`).pathname, { recursive: true });
fs.writeFileSync(args.results, `${JSON.stringify(results, null, 2)}\n`);
const count = (status) => results.filter((result) => result.status === status).length;
console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("PENDING")} pending, ${count("PENDING-PASSED")} pending but passing`);
process.exit(count("FAIL") > 0 || (args.strict && count("PENDING-PASSED") > 0) ? 1 : 0);
