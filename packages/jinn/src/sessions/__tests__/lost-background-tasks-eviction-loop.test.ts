import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-lost-background-loop-"));
process.env.JINN_HOME = home;

// node-pty loads a native module at import time; nothing here spawns.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../../shared/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/config.js")>()),
  loadConfig: vi.fn(() => ({ gateway: {} })),
}));
vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://lost-background-loop.invalid" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { InteractiveClaudeEngine } from "../../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";

let registry: typeof import("../registry.js");
let lostBackground: typeof import("../lost-background-tasks.js");
let callbacks: typeof import("../callbacks.js");
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  registry = await import("../registry.js");
  lostBackground = await import("../lost-background-tasks.js");
  callbacks = await import("../callbacks.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM sessions").run();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  callbacks.__resetCallbackRetrySweepForTest();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

describe("lost background tasks over the idle PTY cap", () => {
  it("ends the loop where sessions that keep a background task evict and nudge each other", () => {
    const hooks = new HookRegistry();
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 1 });
    const engine = new InteractiveClaudeEngine(lifecycle, hooks);
    const nudges: string[] = [];
    const pending: string[] = [];
    engine.onLostBackgroundTasks((sessionId, tasks) => {
      if (lostBackground.notifyLostBackgroundTasks(sessionId, tasks).claimed) {
        nudges.push(sessionId);
        pending.push(sessionId);
      }
    });

    let launches = 0;
    // A model that keeps a dev server running: every turn, including the
    // answer to a nudge, launches it again in the background.
    const turnThatRelaunches = (sessionId: string) => {
      lifecycle.adopt(sessionId, fakeHandle(), { turnRunning: true });
      launches += 1;
      (engine as unknown as { handleBackgroundMonitorHook(id: string, hook: HookPayload): void }).handleBackgroundMonitorHook(sessionId, {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm run dev", run_in_background: true },
        tool_response: { backgroundTaskId: `dev-${launches}` },
      });
      lifecycle.turnEnded(sessionId); // the idle cap runs here
    };

    const a = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:a" }).id;
    const b = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:b" }).id;
    turnThatRelaunches(a);
    turnThatRelaunches(b);
    for (let round = 0; round < 20 && pending.length > 0; round += 1) turnThatRelaunches(pending.shift()!);

    // Each session is nudged once; the second eviction of either is left alone.
    expect(pending).toEqual([]);
    expect(nudges).toEqual([a, b]);
    // The cap holds: one PTY is left, and the other session is down.
    expect([a, b].filter((id) => engine.hasWarmPty(id))).toHaveLength(1);
    hooks.dispose();
  });
});
