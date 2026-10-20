import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { ApiContext } from "../../api.js";
import type { JinnConfig } from "../../../shared/types.js";

/**
 * Shared fixture for the /api/search/global suites. They drive handleApiRequest
 * directly with fake req/res — no HTTP server boot — over a throwaway JINN_HOME
 * seeded with one of every searchable thing, so a single query can be asserted
 * across all seven kinds.
 *
 * The pool is `forks`, so importing this gives each suite its own process, home
 * and SQLite database. JINN_HOME must be set before db.js loads; keep that order.
 */

/** Planted in one entity of every kind that carries free text, so a single word
 *  reaches Todos, sessions, notes, people, cron jobs and skills at once. */
export const RARE_WORD = "zephyr";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-search-route-"));
process.env.JINN_HOME = home;
export const HOME = home;

fs.mkdirSync(path.join(home, "org", "platform"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "platform", "jinn-dev.yaml"),
  "name: jinn-dev\ndisplayName: Platform Engineer\ndepartment: platform\nrank: senior\nengine: codex\nmodel: default\npersona: Keeps the zephyr pipeline healthy.\n",
);
fs.writeFileSync(
  path.join(home, "org", "platform", "second-dev.yaml"),
  "name: second-dev\ndisplayName: Second Engineer\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
);

fs.mkdirSync(path.join(home, "cron"), { recursive: true });
fs.writeFileSync(
  path.join(home, "cron", "jobs.json"),
  JSON.stringify([
    { id: "nightly-sweep", name: "Nightly sweep", enabled: true, schedule: "0 3 * * *", employee: "jinn-dev", prompt: "Sweep the zephyr index." },
  ]),
);

fs.mkdirSync(path.join(home, "skills", "zephyr-tools"), { recursive: true });
fs.writeFileSync(
  path.join(home, "skills", "zephyr-tools", "SKILL.md"),
  "---\nname: zephyr-tools\ndescription: Tools for the zephyr pipeline.\n---\n\n# Zephyr tools\n",
);

fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
fs.writeFileSync(
  path.join(home, "knowledge", "zephyr-brief.md"),
  "# Zephyr brief\n\nThe zephyr pipeline opens a preview pane beside the result list.\n",
);

export const api = await import("../../api.js");
export const registry = await import("../../../sessions/registry.js");
export const store = await import("../../../work-items/store.js");
(await import("../../../shared/db.js")).initDb();

/** The Todo the whole search category is about: `search opens` reaches
 *  it only across title and body, in the wrong order. */
export const redesign = store.createWorkItem({
  title: "Redesign Todos Search & Cmd + K global search",
  body: "Typing a query opens a preview pane beside the result list. Tagged zephyr.",
  status: "blocked",
  assignee: "jinn-dev",
});
/** Mentions `redesign`'s id in its body, so an exact-id query has a text rival. */
export const mentions = store.createWorkItem({
  title: "Wave 2 follow-up",
  body: `Blocked on ${redesign.id} until the index lands.`,
  status: "executing",
  assignee: "jinn-dev",
});
/** Blocked, but on someone else — the assignee facet has to exclude it. */
export const otherOwner = store.createWorkItem({
  title: "Unrelated blocked chore",
  body: "Routine reconciliation.",
  status: "blocked",
  assignee: "second-dev",
});
/** jinn-dev's, but not blocked — the status facet has to exclude it. */
export const otherStatus = store.createWorkItem({
  title: "Unrelated backlog chore",
  body: "Routine reconciliation.",
  status: "backlog",
  assignee: "jinn-dev",
});

export const session = registry.createSession({
  engine: "codex",
  source: "web",
  sourceRef: "web:search-fixture",
  employee: "jinn-dev",
  title: "Zephyr pipeline review",
});

/** Flipped by the suite that checks the Notes feature gate. */
export const features = { notesEnabled: true };

const context = {
  getConfig: () => ({
    gateway: { notesEnabled: features.notesEnabled },
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol" } },
    models: {},
    connectors: {},
    mcp: {},
  } as unknown as JinnConfig),
  jinnHome: home,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => undefined,
    getEngines: () => new Map(),
    getQueue: () => ({ getPendingCount: () => 0, getRowlessWaitingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

/** GET as the operator. `url` is a path plus query string. */
export async function get(url: string): Promise<{ status: number; body: any }> {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url,
    headers: { host: "localhost", authorization: "Bearer test-token" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<typeof api.handleApiRequest>[0], cap.res, context);
  return { status: cap.status, body: cap.body };
}

/** The global-search route with `q` (and anything else) URL-encoded. */
export async function search(query: string, extra = ""): Promise<{ status: number; body: any }> {
  return get(`/api/search/global?q=${encodeURIComponent(query)}${extra}`);
}
