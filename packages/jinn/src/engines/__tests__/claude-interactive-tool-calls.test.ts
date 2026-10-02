import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

/**
 * Every tool call a claude session makes is recorded as a `tool_call` row.
 *
 * The SSE proxy reports a call as it streams, but it only tees the main
 * agent's stream, and a remote session has no proxy at all. Those calls are
 * reported by their PreToolUse hooks instead (a sub-agent's carry `agent_id`;
 * verified on Claude Code 2.1.286), and a main-agent call that both report is
 * recorded once.
 *
 * Deltas go through the real partial-stream writer and settlement into a
 * throwaway registry, so the assertions are on the rows themselves.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-claude-tool-calls-"));
process.env.JINN_HOME = home;

const REMOTE_STAGE = "/mnt/jinn-home/.jinn-remote-stage";

const hoisted = vi.hoisted(() => ({
  ptys: [] as Array<{ bin: string }>,
  /** The per-PTY SSE proxy's event sink, captured so a test can stream model output. */
  sseSinks: [] as Array<(e: unknown) => void>,
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string) => {
    hoisted.ptys.push({ bin });
    return {
      pid: 5000 + hoisted.ptys.length,
      _exitCode: null,
      onData() { return { dispose() {} }; },
      onExit() {},
      kill() {},
      write() {},
      resize() {},
      on() {},
    };
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, onEvent: (e: unknown) => void) { hoisted.sseSinks.push(onEvent); }
    async start() { return 41500; }
    stop() {}
  },
}));
vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async () => ({
      ready: true,
      facts: {
        home: "/home/builder",
        stageDir: REMOTE_STAGE,
        nodeBin: "/usr/bin/node",
        claudeBin: "/usr/local/bin/claude",
        jinnVersion: "0.32.0",
        entryDir: "/usr/lib/jinn/src/mcp",
      },
    })),
    prepareRemoteSession: vi.fn(async () => ({
      destination: "builder@build-box",
      tunnelPort: 44321,
      sessionHome: `${REMOTE_STAGE}/sessions/remote`,
      settingsPath: `${REMOTE_STAGE}/sessions/remote/tmp/settings.json`,
      envFilePath: `${REMOTE_STAGE}/sessions/remote/tmp/session-env.sh`,
    })),
  };
});

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";
import type { StreamDelta } from "../../shared/types.js";

type Registry = typeof import("../../sessions/registry.js");
type PartialStream = typeof import("../../sessions/partial-stream.js");
type StreamedBlocks = typeof import("../../gateway/streamed-blocks.js");
let registry: Registry;
let partialStream: PartialStream;
let streamedBlocks: StreamedBlocks;

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  partialStream = await import("../../sessions/partial-stream.js");
  streamedBlocks = await import("../../gateway/streamed-blocks.js");
});

const REMOTE_TARGET = { remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/work/proj" };

const preTool = (name: string, id: string, agentId?: string): HookPayload => ({
  hook_event_name: "PreToolUse",
  tool_name: name,
  tool_use_id: id,
  tool_input: {},
  ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
});
const postTool = (name: string, id: string, agentId?: string): HookPayload => ({
  hook_event_name: "PostToolUse",
  tool_name: name,
  tool_use_id: id,
  tool_input: {},
  tool_response: { stdout: "ok" },
  ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
});
const sseToolStart = (name: string, id: string) => ({
  type: "content_block_start",
  content_block: { type: "tool_use", id, name },
});

interface ToolRow { tool_call: string; tool_id: string | null; content: string; partial: number | null; meta: string | null }

describe("InteractiveClaudeEngine — tool calls reach the registry", () => {
  let hooks: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let lifecycle: PtyLifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.ptys.length = 0;
    hoisted.sseSinks.length = 0;
    hooks = new HookRegistry();
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
    engine = new InteractiveClaudeEngine(lifecycle, hooks, {
      remote: () => ({ root: "/srv/work", mount: "/mnt/jinn-home" }),
      gatewayPort: () => 8722,
    });
  });
  afterEach(() => {
    lifecycle.killAll();
    hooks.dispose();
    vi.useRealTimers();
  });

  /** Start a turn whose deltas are persisted exactly as the turn runner does. */
  async function startTurn(sid: string, target: Record<string, unknown> = {}) {
    const writer = partialStream.createPartialStreamWriter(sid);
    const deltas: StreamDelta[] = [];
    const turn = engine.run({
      sessionId: sid,
      prompt: "go",
      cwd: "/tmp",
      ...target,
      onStream: (d: StreamDelta) => { deltas.push(d); writer.persist(d); },
    } as any);
    await vi.advanceTimersByTimeAsync(20);
    hooks.deliver(sid, { hook_event_name: "SessionStart", session_id: `claude-${sid}` });
    hooks.deliver(sid, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    return {
      deltas,
      /** Finish the turn and settle its partial rows as the runner would. */
      async finish(answer: string) {
        hooks.deliver(sid, { hook_event_name: "Stop", session_id: `claude-${sid}`, last_assistant_message: answer });
        const result = await turn;
        writer.finish();
        const streamed = registry.getPartialMessages(sid);
        registry.settlePartialMessages(sid, streamedBlocks.completedStreamedBlockIds({
          quietPreempted: false,
          rateLimited: false,
          result: result.result,
          error: result.error,
          streamedBlocks: streamed,
        }));
        return result;
      },
    };
  }

  function toolRows(sid: string): ToolRow[] {
    return (registry.getMessages(sid) as Array<{ toolCall?: string; toolId?: string; content: string; partial?: boolean; meta?: unknown }>)
      .filter((m) => m.toolCall)
      .map((m) => ({
        tool_call: m.toolCall!,
        tool_id: m.toolId ?? null,
        content: m.content,
        partial: m.partial ? 1 : null,
        meta: m.meta ? JSON.stringify(m.meta) : null,
      }));
  }

  it("a remote session's N tool calls produce N tool_call rows", async () => {
    const sid = "remote-tools";
    const turn = await startTurn(sid, REMOTE_TARGET);
    expect(hoisted.ptys[0]?.bin).toMatch(/ssh$/);
    // No SSE proxy runs for a remote session: the hooks are the only report.
    expect(hoisted.sseSinks).toHaveLength(0);
    for (const [name, id] of [["Read", "tu-r1"], ["Bash", "tu-r2"], ["Grep", "tu-r3"]] as const) {
      hooks.deliver(sid, preTool(name, id));
      hooks.deliver(sid, postTool(name, id));
    }
    expect((await turn.finish("done")).result).toBe("done");

    const rows = toolRows(sid);
    expect(rows.map((r) => [r.tool_call, r.tool_id, r.content])).toEqual([
      ["Read", "tu-r1", "Used Read"],
      ["Bash", "tu-r2", "Used Bash"],
      ["Grep", "tu-r3", "Used Grep"],
    ]);
    expect(rows.every((r) => r.partial === null && r.meta === null)).toBe(true);
  });

  it("a main-agent call reported by both the SSE proxy and its hook is recorded once", async () => {
    const sid = "local-dedupe";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    sse({ type: "message_start" });
    sse(sseToolStart("Read", "tu-l1"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, preTool("Read", "tu-l1"));
    hooks.deliver(sid, postTool("Read", "tu-l1"));
    // And the other order: the hook lands before the proxy has parsed the block.
    hooks.deliver(sid, preTool("Bash", "tu-l2"));
    sse({ type: "message_start" });
    sse(sseToolStart("Bash", "tu-l2"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, postTool("Bash", "tu-l2"));
    await turn.finish("done");

    expect(turn.deltas.filter((d) => d.type === "tool_use").map((d) => d.toolId)).toEqual(["tu-l1", "tu-l2"]);
    expect(toolRows(sid).map((r) => [r.tool_call, r.content])).toEqual([
      ["Read", "Used Read"],
      ["Bash", "Used Bash"],
    ]);
  });

  it("a sub-agent's tool calls are recorded on the parent session, marked as sidechain", async () => {
    const sid = "local-subagent";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    // The main agent calls the Agent tool; the proxy tees only this stream.
    sse({ type: "message_start" });
    sse(sseToolStart("Agent", "tu-agent"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, preTool("Agent", "tu-agent"));
    // The sub-agent's own calls arrive only as hooks carrying agent_id.
    hooks.deliver(sid, preTool("Bash", "tu-sub1", "agent-1"));
    hooks.deliver(sid, postTool("Bash", "tu-sub1", "agent-1"));
    hooks.deliver(sid, preTool("mcp__example__lookup", "tu-sub2", "agent-1"));
    hooks.deliver(sid, postTool("mcp__example__lookup", "tu-sub2", "agent-1"));
    hooks.deliver(sid, postTool("Agent", "tu-agent"));
    await turn.finish("done");

    const rows = toolRows(sid);
    expect(rows.map((r) => [r.tool_call, r.content, r.meta])).toEqual([
      ["Agent", "Used Agent", null],
      ["Bash", "Used Bash", JSON.stringify({ sidechain: true })],
      ["mcp__example__lookup", "Used mcp__example__lookup", JSON.stringify({ sidechain: true })],
    ]);
  });

  it("a PreToolUse replayed from before the turn is not reported again", async () => {
    const sid = "local-replay";
    // Buffered with no turn registered: it belongs to whatever ran before.
    hooks.deliver(sid, preTool("Read", "tu-old"));
    const turn = await startTurn(sid);
    await turn.finish("done");
    expect(turn.deltas.filter((d) => d.type === "tool_use")).toEqual([]);
    expect(toolRows(sid)).toEqual([]);
  });
});
