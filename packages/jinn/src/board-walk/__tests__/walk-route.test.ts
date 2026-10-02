import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";

/**
 * The walk's own turn, through the real session layer: `sessionManager.route`
 * with the walk's locked-down employee, the turn runner, its settle path and
 * the registry the walk reads the answer back from. Only the engine is a
 * stand-in, so what is held here is everything between the tick and the
 * engine, and back.
 *
 * The rules file names an employee whose own engine is opencode, the case
 * that first showed the walk's turn ending as a bare "Interrupted".
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-walk-route-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(path.join(home, "org", "assistant.yaml"), "name: assistant\nengine: opencode\nmodel: some-opencode-model\npersona: General helper\n");

const TEMPLATE = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "template", "board-walk.md"), "utf-8");
const RULES = path.join(home, "board-walk.md");
const NOW = Date.parse("2026-10-02T12:00:00Z");

const config = {
  gateway: {},
  engines: { default: "claude", claude: { bin: process.execPath, model: "sonnet" } },
  sessions: {},
  connectors: {},
  logging: {},
} as unknown as JinnConfig;

const m = {} as {
  walk: typeof import("../walk.js");
  store: typeof import("../../work-items/store.js");
  comments: typeof import("../../work-items/comments.js");
  prompt: typeof import("../prompt.js");
  manager: typeof import("../../sessions/manager.js");
  db: import("better-sqlite3").Database;
};

beforeAll(async () => {
  m.walk = await import("../walk.js");
  m.store = await import("../../work-items/store.js");
  m.comments = await import("../../work-items/comments.js");
  m.prompt = await import("../prompt.js");
  m.manager = await import("../../sessions/manager.js");
  m.db = (await import("../../shared/db.js")).initDb();
  fs.writeFileSync(RULES, TEMPLATE);
});

beforeEach(() => {
  for (const table of ["work_item_comments", "work_item_events", "work_items", "messages", "queue_items", "sessions"]) {
    m.db.exec(`DELETE FROM ${table}`);
  }
});

/** The engine the walk's turn reaches, recording what it was handed. */
function engine(answer: (opts: EngineRunOpts) => EngineResult) {
  const runs: EngineRunOpts[] = [];
  return {
    runs,
    name: "claude",
    async run(opts: EngineRunOpts): Promise<EngineResult> {
      runs.push(opts);
      return answer(opts);
    },
    isAlive: () => false,
    kill: () => {},
    killAll: () => {},
  };
}

const NOTHING = "```json\n" + JSON.stringify({ todos: [], dispatch: { start: [], reason: "nothing is ready" }, summary: "nothing to do" }) + "\n```";

function walkWith(fake: ReturnType<typeof engine>) {
  const manager = new m.manager.SessionManager(config, new Map([["claude", fake]]) as never, "walk-route-boot");
  return m.walk.startBoardWalk({
    getConfig: () => config,
    context: { sessionManager: manager } as never,
    rulesFile: RULES,
    now: () => NOW,
    scheduleJob: () => undefined,
    armedJob: () => undefined,
    templateRules: () => TEMPLATE,
    dispatch: () => ({ ok: true, status: 201, body: { workItemId: "", sessionId: "", status: "running", reused: false } }),
    resolveLink: async (url, kind) => ({ url, kind, state: "unknown" }),
    sessions: () => [],
    holdingCapacity: () => [],
    collectClaude: async () => ({ name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [], windows: [] }),
    snapshot: {
      collect: async () => ({ generatedAt: new Date(NOW).toISOString(), default: "claude", engines: {} }),
      usageHistory: () => [],
      statuslineMtime: () => undefined,
      startedSince: () => [],
      exhausted: () => false,
    },
  });
}

/** A board whose raw text is far past what one prompt can carry: 47 open
 *  Todos, each with a 6,000-character body and six 2,000-character comments. */
function bigBoard(): number {
  let raw = 0;
  for (let i = 0; i < 47; i++) {
    const body = `Item ${i}. ${"Long description of the work. ".repeat(200)}`;
    const item = m.store.createWorkItem({ title: `Board item ${i}`, status: "backlog", source: "human", priority: i % 4, body });
    raw += body.length;
    for (let c = 0; c < 6; c++) {
      const text = `Comment ${c}. ${"A long progress note. ".repeat(90)}`;
      m.comments.addComment({ workItemId: item.id, authorKind: "operator", author: "operator", body: text });
      raw += text.length;
    }
  }
  return raw;
}

describe("the board walk's turn through the session layer", () => {
  it("completes for an opencode-native employee, locked down on Claude, with a prompt inside its budget", async () => {
    const raw = bigBoard();
    expect(raw).toBeGreaterThan(131_072 * 4);
    const fake = engine(() => ({ sessionId: "native-1", result: NOTHING }));
    const tick = await walkWith(fake).tick("manual");

    expect(tick.outcome).toBe("ok");
    expect(tick.summary).toContain("nothing is ready");
    expect(fake.runs).toHaveLength(1);
    const [run] = fake.runs;
    // On Claude, whatever the employee's own engine, with every tool taken away.
    expect(run.cliFlags).toEqual(["--no-chrome", "--tools", "", "--strict-mcp-config"]);
    expect(run.model).toBe("sonnet");
    const bytes = Buffer.byteLength(run.prompt, "utf8");
    expect(bytes).toBeLessThanOrEqual(m.prompt.PROMPT_BUDGET_BYTES);
    // The cut is counted, never silent.
    const heading = /^## The board \((\d+) open Todos, (\d+) more not shown; 0 in review/m.exec(run.prompt);
    expect(heading).not.toBeNull();
    expect(Number(heading![1]) + Number(heading![2])).toBe(47);
    expect(Number(heading![1])).toBeGreaterThanOrEqual(20);
  });

  it("records a turn whose process never started as failed, with the process's own reason", async () => {
    m.store.createWorkItem({ title: "Anything", status: "backlog", source: "human" });
    const reason = "claude did not start: its process exited (code 1, signal 0) before its session began. Its last output: execvp(3) failed.: Argument list too long";
    const tick = await walkWith(engine(() => ({ sessionId: "", result: "", error: reason }))).tick("manual");

    expect(tick.outcome).toBe("failed");
    expect(tick.summary).toBe(`the model turn failed: ${reason}`);
  });

  it("records an interrupted turn with the engine's interruption reason, not a bare Interrupted", async () => {
    m.store.createWorkItem({ title: "Anything", status: "backlog", source: "human" });
    const reason = "Interrupted: claude process exited (code 1, signal 0)";
    const tick = await walkWith(engine(() => ({ sessionId: "", result: "", error: reason }))).tick("manual");

    expect(tick.outcome).toBe("failed");
    expect(tick.summary).toBe(`the model turn failed: ${reason}`);
  });
});
