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
  engines: { default: "claude", claude: { bin: process.execPath, model: "sonnet" }, opencode: { bin: process.execPath, model: "opencode-go/deepseek-v4.1-flash" } },
  sessions: {},
  connectors: {},
  logging: {},
} as unknown as JinnConfig;

const m = {} as {
  walk: typeof import("../walk.js");
  store: typeof import("../../work-items/store.js");
  comments: typeof import("../../work-items/comments.js");
  manager: typeof import("../../sessions/manager.js");
  db: import("better-sqlite3").Database;
};

beforeAll(async () => {
  m.walk = await import("../walk.js");
  m.store = await import("../../work-items/store.js");
  m.comments = await import("../../work-items/comments.js");
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
function engine(answer: (opts: EngineRunOpts) => EngineResult | Promise<EngineResult>, name = "claude") {
  const runs: EngineRunOpts[] = [];
  return {
    runs,
    name,
    async run(opts: EngineRunOpts): Promise<EngineResult> {
      runs.push(opts);
      return await answer(opts);
    },
    isAlive: () => false,
    kill: () => {},
    killAll: () => {},
  };
}

function walkWith(fake: ReturnType<typeof engine>) {
  const manager = new m.manager.SessionManager(config, new Map([[fake.name, fake]]) as never, "walk-route-boot");
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
  it("goes through a big board one Todo at a time for an opencode-native employee, on Claude with only the walk's tools", async () => {
    const raw = bigBoard();
    expect(raw).toBeGreaterThan(131_072 * 4);
    let walk: ReturnType<typeof walkWith> | undefined;
    // The model: read the board through the tools, as the session the gateway
    // bound them to, and leave every Todo with a reason.
    const fake = engine(async (opts) => {
      const call = async (name: string, args: Record<string, unknown> = {}) => (await walk!.turnTool(opts.sessionId!, name, args)).body as { ok: boolean; text: string };
      const ids: string[] = [];
      for (let offset = 0; ; offset += 50) {
        const page = await call("walk_board", { offset });
        ids.push(...[...page.text.matchAll(/^([A-Z]+-\d+): /gm)].map(([, id]) => id));
        if (!page.text.includes("More: call walk_board")) break;
      }
      for (const id of ids) await call("walk_decide", { id, verdict: "ready", action: "leave", reason: "nothing to do yet" });
      await call("walk_finish", { summary: "all left", dispatchReason: "nothing is ready" });
      return { sessionId: "native-1", result: "Done." };
    });
    walk = walkWith(fake);
    const tick = await walk.tick("manual");

    expect(tick.outcome).toBe("ok");
    expect(tick.summary).toBe("nothing to do. Dispatch: nothing is ready");
    expect(tick.modelSummary).toBe("all left");
    expect(tick.entries.filter((entry) => entry.kind === "ready" && entry.outcome === "left alone")).toHaveLength(47);
    const [run] = fake.runs;
    // On Claude, whatever the employee's own engine, with every built-in tool off
    // and one MCP server: the jinn server serving the walk's toolset, bound to
    // this session.
    expect(run.cliFlags).toEqual(["--no-chrome", "--tools", "", "--strict-mcp-config"]);
    expect(run.model).toBe("sonnet");
    expect(Object.keys(run.resolvedMcp!.mcpServers)).toEqual(["jinn"]);
    const server = run.resolvedMcp!.mcpServers.jinn as { args: string[]; env: Record<string, string> };
    expect(server.args).toEqual(expect.arrayContaining(["--jinn-toolset", "board-walk"]));
    expect(server.env).toMatchObject({ JINN_SESSION_ID: run.sessionId });
    expect(JSON.parse(fs.readFileSync(run.mcpConfigPath!, "utf-8"))).toEqual(run.resolvedMcp);
    // The board is not in the prompt, so a big board leaves it the same size.
    expect(run.prompt).not.toContain("Long description of the work");
    expect(Buffer.byteLength(run.prompt, "utf8")).toBeLessThan(20_000);
  });

  it("takes a walk that ends without a closing word as done, its decisions all logged", async () => {
    const item = m.store.createWorkItem({ title: "Anything", status: "backlog", source: "human" });
    let walk: ReturnType<typeof walkWith> | undefined;
    walk = walkWith(engine(async (opts) => {
      await walk!.turnTool(opts.sessionId!, "walk_decide", { id: item.id, verdict: "ready", action: "leave", reason: "nothing to do" });
      await walk!.turnTool(opts.sessionId!, "walk_finish", { summary: "done", dispatchReason: "none ready" });
      return { sessionId: "native-1", result: "" };
    }));
    const tick = await walk.tick("manual");
    expect(tick.outcome).toBe("ok");
    expect(tick.entries).toContainEqual(expect.objectContaining({ kind: "ready", workItemId: item.id, outcome: "left alone" }));
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

  it("runs the turn on a configured non-Claude engine (opencode), confined to its agent and the walk's own tools", async () => {
    m.store.createWorkItem({ title: "Anything", status: "backlog", source: "human" });
    // The runner fields on the walk's cron job override the file's default
    // Claude runner; only an engine that can be clamped may be named.
    fs.writeFileSync(RULES, TEMPLATE.replace("engine: claude", "engine: opencode").replace(/^model: sonnet$/m, "model: opencode-go/deepseek-v4.1-flash"));
    let walk: ReturnType<typeof walkWith> | undefined;
    const fake = engine(async (opts) => {
      await walk!.turnTool(opts.sessionId!, "walk_decide", { id: m.store.listWorkItems({ status: "backlog" })[0]!.id, verdict: "ready", action: "leave", reason: "nothing to do" });
      await walk!.turnTool(opts.sessionId!, "walk_finish", { summary: "left", dispatchReason: "none ready" });
      return { sessionId: "oc-1", result: "" };
    }, "opencode");
    walk = walkWith(fake);
    const tick = await walk.tick("manual");

    expect(tick.outcome).toBe("ok");
    const [run] = fake.runs;
    // Routed on opencode, as the confined agent: no built-ins, only the jinn
    // server's toolset, and none of the employee's own flags.
    expect(run.cliFlags).toEqual(["--agent", "jinn-walk"]);
    expect(run.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(run.resolvedMcp).toBeDefined();
  });
});
