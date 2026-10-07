import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineLimitEngineSnapshot, EngineLimitsResponse, JinnConfig, Session } from "../../shared/types.js";
import type { WalkTurn } from "../walk.js";

/**
 * One Claude account behaves exactly as before accounts (FR-078). On a fixed
 * clock and fixed fixtures, with no named profile and no remote employee, this
 * builds what the board walk and the Limits page build — the capacity
 * snapshot, the walk's prompt (on a fixed rules file, the same on both sides),
 * the board as the walk's tools show it, the Dispatcher's prompt suffix, the
 * walk's decisions and the `/api/engine-limits` body — and compares them byte
 * for byte with what the code before accounts built. The expected file was
 * produced by running this same file against that code with
 * `PARITY_EMIT=<file>`.
 */

const suffixes = vi.hoisted(() => [] as string[]);
vi.mock("../../gateway/todo-dispatch.js", () => ({
  startTodoDispatcher: (item: { id: string }, _context: unknown, opts: { promptSuffix?: string }) => {
    suffixes.push(opts.promptSuffix ?? "");
    return { ok: true, status: 201, body: { workItemId: item.id, sessionId: `dispatch-${item.id}`, status: "running", reused: false } };
  },
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-single-account-parity-"));
process.env.JINN_HOME = home;
delete process.env.JINN_CLAUDE_USAGE_API;
// Hermetic /api/engine-limits: the Claude collector only calls the (stubbed) usage API when it
// finds an OAuth token, and otherwise reads the host's Claude files (the credentials file under
// the config dir, the macOS Keychain). This pins the one input that decides live vs. static:
// a fake token in the environment, which outranks every file, and an empty config dir so no
// host credentials file or settings are read. The statusline snapshots live under JINN_HOME above.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "parity-test-token";
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-single-account-parity-claude-"));
const EXPECTED = path.join(__dirname, "__fixtures__", "single-account-parity.json");

const NOW = Date.parse("2026-10-06T13:20:00Z");
const RULES_BODY = `# Board walk

## Dispatch

Start backlog work when the Claude five-hour window lapses within two hours under 50%. At most one start per tick.
`;
const secs = (minutes: number) => Math.floor((NOW + minutes * 60_000) / 1000);

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: process.execPath, model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low"] }] } },
  connectors: {},
  logging: {},
} as unknown as JinnConfig;

function claude(): EngineLimitEngineSnapshot {
  return {
    name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [],
    windows: [
      { name: "5h", usedPercent: 22, windowDurationMins: 300, resetsAt: secs(70) },
      { name: "7d", usedPercent: 41, windowDurationMins: 10_080, resetsAt: secs(3 * 24 * 60) },
    ],
  };
}
const limits = (): EngineLimitsResponse => ({ generatedAt: new Date(NOW).toISOString(), default: "claude", engines: { claude: claude() } });

const sessions = [
  { id: "op-1", engine: "claude", status: "idle", source: "web", createdAt: new Date(NOW - 7200_000).toISOString(), lastActivity: new Date(NOW - 50 * 60_000).toISOString() },
] as unknown as Session[];

let outputs: Record<string, unknown>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const store = await import("../../work-items/store.js");
  const transitions = await import("../../work-items/transitions.js");
  const { startBoardWalk } = await import("../walk.js");
  const { buildCapacitySnapshot } = await import("../snapshot.js");
  const { collectEngineLimits } = await import("../../shared/engine-limits.js");

  const first = store.createWorkItem({ title: "Write the release notes", status: "backlog", source: "human", priority: 2 });
  store.createWorkItem({ title: "Tidy the fixtures", status: "backlog", source: "human", priority: 1, assignee: "nobody-on-the-roster" });
  const parked = store.createWorkItem({ title: "Send the invoice", status: "backlog", source: "human", body: "not before 2026-10-10" });
  transitions.transition(parked.id, "blocked", "operator", { human: true });

  const rulesFile = path.join(home, "board-walk.md");
  fs.writeFileSync(rulesFile, RULES_BODY);
  const snapshotDeps = {
    collect: async () => limits(),
    usageHistory: () => [],
    statuslineMtime: () => NOW - 45 * 60_000,
    startedSince: () => [],
    exhausted: () => false,
  };

  const snapshot = await buildCapacitySnapshot({
    config, timezone: "Europe/London", now: NOW, sessions, holdingCapacity: () => [], ...snapshotDeps,
  });

  let prompt = "";
  const board: string[] = [];
  const walk = startBoardWalk({
    getConfig: () => config,
    context: {} as never,
    rulesFile,
    now: () => NOW,
    scheduleJob: () => undefined,
    armedJob: () => undefined,
    templateRules: () => RULES_BODY,
    resolveLink: async (url, kind) => ({ url, kind, state: "unknown" }),
    sessions: () => sessions,
    holdingCapacity: () => [],
    collectClaude: async () => claude(),
    snapshot: snapshotDeps,
    runTurn: async (turn: WalkTurn) => {
      prompt = turn.prompt;
      const list = await turn.tools.call("walk_board", {});
      board.push(list.text);
      const ids = [...list.text.matchAll(/^([A-Z]+-\d+): /gm)].map(([, id]) => id);
      for (const id of ids) board.push((await turn.tools.call("walk_todo", { id })).text);
      for (const id of ids) await turn.tools.call("walk_decide", { id, verdict: "ready", action: "leave", reason: "nothing to do" });
      await turn.tools.call("walk_start", { id: first.id, reason: "the five-hour window lapses in 70 minutes at 22%", engine: "claude" });
      await turn.tools.call("walk_finish", { summary: "one start", dispatchReason: "allowance about to lapse" });
      return { sessionId: "walk-1", reply: "Done." };
    },
  });
  const tick = await walk.tick();

  // The Limits page's body: the default account read from a stubbed usage API.
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ limits: [{ kind: "session", percent: 22, resets_at: new Date(secs(70) * 1000).toISOString() }] }) }) as unknown as Response);
  const limitsBody = await collectEngineLimits(config, { engine: "claude" });

  outputs = {
    snapshot: JSON.stringify(snapshot),
    prompt,
    board,
    dispatcherSuffix: suffixes,
    decisions: tick.entries.map(({ kind, workItemId, outcome }) => ({ kind, workItemId, outcome })),
    limits: JSON.stringify(limitsBody),
  };
  if (process.env.PARITY_EMIT) fs.writeFileSync(process.env.PARITY_EMIT, JSON.stringify(outputs, null, 2));
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a single Claude account matches the code before accounts", () => {
  const expected = () => JSON.parse(fs.readFileSync(EXPECTED, "utf-8")) as Record<string, unknown>;

  it("builds the same capacity snapshot JSON", () => expect(outputs.snapshot).toBe(expected().snapshot));
  it("builds the same walk prompt on the same board-walk.md", () => expect(outputs.prompt).toBe(expected().prompt));
  it("shows the same board through the walk's tools", () => expect(outputs.board).toEqual(expected().board));
  it("hands the Dispatcher the same prompt suffix", () => expect(outputs.dispatcherSuffix).toEqual(expected().dispatcherSuffix));
  it("makes the same decisions", () => expect(outputs.decisions).toEqual(expected().decisions));
  it("answers /api/engine-limits with the same body", () => expect(outputs.limits).toBe(expected().limits));
});
