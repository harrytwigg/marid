import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/**
 * The board walk's tool surface, end to end short of a real engine: which
 * tools a jinn server serves when its spec names the walk's toolset, what each
 * one sends the gateway, which MCP servers a turn with that toolset gets, and
 * who the gateway's route answers.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-walk-toolset-"));
process.env.JINN_HOME = home;

const m = {} as {
  server: typeof import("../server.js");
  toolsets: typeof import("../toolsets.js");
  tools: typeof import("../board-walk-tools.js");
  identity: typeof import("../identity.js");
  runMcp: typeof import("../../sessions/engine-run-mcp.js");
  api: typeof import("../../gateway/board-walk-api.js");
  registry: typeof import("../../sessions/registry.js");
};

beforeAll(async () => {
  m.server = await import("../server.js");
  m.toolsets = await import("../toolsets.js");
  m.tools = await import("../board-walk-tools.js");
  m.identity = await import("../identity.js");
  m.runMcp = await import("../../sessions/engine-run-mcp.js");
  m.api = await import("../../gateway/board-walk-api.js");
  m.registry = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
});

const WALK_TOOLS = ["walk_board", "walk_todo", "walk_decide", "walk_start", "walk_finish"];

describe("the jinn server's toolset", () => {
  it("serves the walk's five tools, and nothing of the company belt, when its spec names the board-walk toolset", () => {
    const fullBelt = () => m.server.buildTools();
    expect(m.toolsets.toolsFor("board-walk", fullBelt).map((tool) => tool.name)).toEqual(WALK_TOOLS);
    const belt = m.toolsets.toolsFor(undefined, fullBelt).map((tool) => tool.name);
    expect(belt).toContain("update_work_item");
    expect(belt.some((name) => WALK_TOOLS.includes(name))).toBe(false);
  });

  it("serves nothing at all for a toolset it does not know, never the belt", () => {
    expect(m.toolsets.toolsFor("everything", () => m.server.buildTools())).toEqual([]);
  });
});

describe("a walk tool's call", () => {
  const ctx = (fetchFn: typeof fetch) => ({ gatewayUrl: "http://gw", callerSessionId: "walk-session", sessionCapability: "cap", fetchFn });

  it("posts its arguments to its own gateway route and returns the gateway's text", async () => {
    const sent: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ ok: true, text: "T-1: moved to backlog" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const decide = m.tools.buildBoardWalkTools().find((tool) => tool.name === "walk_decide")!;
    const args = { id: "T-1", verdict: "ready", action: "release", reason: "met" };

    expect(await decide.handler(args, ctx(fetchFn))).toBe("T-1: moved to backlog");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://gw/api/board-walk/turn/walk_decide");
    expect(sent[0].body).toEqual(args);
    expect(sent[0].headers).toMatchObject({ "x-jinn-caller-session": "walk-session", "x-jinn-session-capability": "cap" });
  });

  it("turns a refusal into an error the model reads, with the gateway's reason", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ ok: false, text: "refused for T-1: release is switched off. Nothing changed; you may decide again." }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const decide = m.tools.buildBoardWalkTools().find((tool) => tool.name === "walk_decide")!;
    await expect(decide.handler({ id: "T-1", verdict: "ready", action: "release", reason: "met" }, ctx(fetchFn))).rejects.toThrow("release is switched off");
    const forbidden = (async () => new Response(JSON.stringify({ error: "only the running board walk's own turn may use the walk's tools" }), { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(decide.handler({ id: "T-1", verdict: "ready", action: "leave", reason: "x" }, ctx(forbidden))).rejects.toThrow("only the running board walk's own turn");
  });
});

describe("a turn whose employee names the walk's toolset", () => {
  const config = {
    engines: { claude: {} },
    mcp: { gateway: { enabled: true }, custom: { everything: { command: "some-server" } } },
  } as unknown as JinnConfig;

  it("gets the jinn server serving that toolset, bound to its session, and no other server", () => {
    const { resolvedMcp, mcpConfigPath } = m.runMcp.resolveEngineRunMcp({
      config, engine: "claude", sessionId: "walk-session",
      employee: { name: "walker", persona: "", toolset: "board-walk", mcp: false, jinnMcp: false } as never,
    });
    expect(Object.keys(resolvedMcp!.mcpServers)).toEqual(["jinn"]);
    const server = resolvedMcp!.mcpServers.jinn as { env: Record<string, string>; args: string[] };
    expect(server.env).toMatchObject({ JINN_MCP_TOOLSET: "board-walk", JINN_SESSION_ID: "walk-session" });
    expect(server.env.JINN_SESSION_CAPABILITY).toBe(m.identity.ensureSessionCapability("walk-session"));
    expect(JSON.parse(fs.readFileSync(mcpConfigPath!, "utf-8"))).toEqual(resolvedMcp);
  });

  it("leaves every other employee's servers as they were", () => {
    const { resolvedMcp } = m.runMcp.resolveEngineRunMcp({
      config, engine: "claude", sessionId: "other-session",
      employee: { name: "worker", persona: "", mcp: true } as never,
    });
    expect(Object.keys(resolvedMcp?.mcpServers ?? {})).toContain("everything");
    expect((resolvedMcp?.mcpServers.jinn as { env?: Record<string, string> } | undefined)?.env?.JINN_MCP_TOOLSET).toBeUndefined();
  });
});

describe("POST /api/board-walk/turn/<tool>", () => {
  /** One request through the board-walk handler, as the gateway routes it. */
  async function post(tool: string, body: unknown, headers: Record<string, string>) {
    const calls: Array<{ caller: string; name: string; args: unknown }> = [];
    const walk = {
      turnTool: async (caller: string, name: string, args: unknown) => {
        calls.push({ caller, name, args });
        return { status: 200, body: { ok: true, text: "fine" } };
      },
    };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers, method: "POST" }) as unknown as IncomingMessage;
    let status = 0;
    let raw = "";
    const res = {
      writeHead: (code: number) => { status = code; return res; },
      setHeader: () => {},
      end: (chunk?: Buffer | string) => { raw = chunk ? chunk.toString() : ""; },
    } as unknown as ServerResponse;
    const pathname = `/api/board-walk/turn/${tool}`;
    await m.api.handleBoardWalkApi(req, res, { method: "POST", pathname, url: new URL(`http://gw${pathname}`) }, { boardWalk: walk } as never);
    return { status, body: JSON.parse(raw), calls };
  }

  it("refuses a caller that does not prove which session it is, before the walk sees the call", async () => {
    const session = m.registry.createSession({ engine: "claude", source: "cron", sourceRef: "walk" } as never);
    const unbound = await post("walk_board", {}, { "x-jinn-tool-call": "jinn-mcp", "x-jinn-caller-session": session.id });
    const forged = await post("walk_board", {}, { "x-jinn-tool-call": "jinn-mcp", "x-jinn-caller-session": session.id, "x-jinn-session-capability": "forged" });
    for (const answer of [unbound, forged]) {
      expect(answer.status).toBe(403);
      expect(answer.calls).toEqual([]);
    }
  });

  it("hands a bound session's call to the walk, with the tool named by the path", async () => {
    const session = m.registry.createSession({ engine: "claude", source: "cron", sourceRef: "walk" } as never);
    const answer = await post("walk_decide", { id: "T-1" }, {
      "x-jinn-tool-call": "jinn-mcp",
      "x-jinn-caller-session": session.id,
      "x-jinn-session-capability": m.identity.ensureSessionCapability(session.id),
    });
    expect(answer).toEqual({ status: 200, body: { ok: true, text: "fine" }, calls: [{ caller: session.id, name: "walk_decide", args: { id: "T-1" } }] });
  });
});
