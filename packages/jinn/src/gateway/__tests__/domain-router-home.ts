import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * The temp home the domain-router contract files point their paths mock at.
 *
 * It is deliberately separate from domain-router-harness.ts and imports nothing
 * from the gateway: a `vi.mock("../../shared/paths.js")` factory has to reach this
 * state, and a factory that imported the harness would pull in api.ts, which
 * imports the very module being mocked — a cycle that hangs the run.
 */

/** Mutable so each paths mock can read the current temp home lazily. */
export const home = { root: "", cronRuns: "", cronJobs: "", org: "" };

/** The session the seeded run spawned — run rows link to it. */
export const RUN_SESSION_ID = "3f2b8c1e-9a44-4d7b-8b1a-5c0e7d216f90";

export const JOBS = [
  { id: "nightly", name: "Nightly", enabled: true, schedule: "0 3 * * *", employee: "ops", prompt: "Run." },
];

// The fixture org, spelled out so every field the org routes return is pinned: the
// authored employee, its persona and edges, and the system employee every org carries.
export const WORKER = { name: "worker", displayName: "Worker", department: "platform", rank: "employee", engine: "codex", model: "gpt-5.6-sol", alwaysNotify: true };
export const PERSONA = "Does platform work.";
export const EDGES = { parentName: null, directReports: [], depth: 0, chain: ["worker"] };
export const DISPATCHER = { name: "todo-dispatcher", displayName: "Todo Dispatcher", department: "system", rank: "senior", emoji: "🧭", jinnMcp: true, system: true, engine: "codex", model: "gpt-5.6-sol", alwaysNotify: true, role: "Todo Dispatcher, a system employee that starts tracked Todo work", parentName: null, directReports: [], depth: 0, chain: ["todo-dispatcher"] };
export const SHAPER = { name: "todo-shaper", displayName: "Todo Shaper", department: "system", rank: "senior", emoji: "✍️", jinnMcp: true, system: true, engine: "codex", model: "gpt-5.6-sol", alwaysNotify: true, role: "Todo Shaper, a system employee that shapes rough captures into Todos", parentName: null, directReports: [], depth: 0, chain: ["todo-shaper"] };

/** A fresh temp home carrying the cron job, its run log, and the org fixture. */
export function seedHome(): void {
  home.root = fs.mkdtempSync(path.join(os.tmpdir(), "domain-router-"));
  home.cronRuns = path.join(home.root, "cron", "runs");
  home.cronJobs = path.join(home.root, "cron", "jobs.json");
  home.org = path.join(home.root, "org");
  fs.mkdirSync(home.cronRuns, { recursive: true });
  fs.mkdirSync(path.join(home.org, "platform"), { recursive: true });
  fs.writeFileSync(home.cronJobs, JSON.stringify(JOBS));
  fs.writeFileSync(
    path.join(home.cronRuns, "nightly.jsonl"),
    JSON.stringify({ timestamp: "2026-08-01T03:00:00.000Z", status: "success", sessionId: RUN_SESSION_ID, result: "ok" }) + "\n",
  );
  fs.writeFileSync(
    path.join(home.org, "platform", "worker.yaml"),
    `name: ${WORKER.name}\ndisplayName: ${WORKER.displayName}\ndepartment: ${WORKER.department}\nrank: ${WORKER.rank}\nengine: ${WORKER.engine}\nmodel: ${WORKER.model}\npersona: ${PERSONA}\n`,
  );
}

// A home exists from the moment this module loads, so a paths getter read before
// the first beforeEach still answers with a temp directory.
seedHome();
