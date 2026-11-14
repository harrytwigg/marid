import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PtyIdleSpawnOpts, PtyViewEngine } from "../../engines/pty-view-engine.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";

/** The dashboard's idle PTY is a launch path too: it must start the session's
 *  claude on the employee's named profile, not the gateway's (FR-051). */

const roster = vi.hoisted(() => ({ employee: {} as Record<string, unknown> }));

vi.mock("../../sessions/registry.js", () => ({
  getSession: vi.fn(() => ({ id: "session-1", employee: "side-dev", model: "opus" })),
  getEngineSessionRef: vi.fn(() => ({ id: "native-1" })),
}));
vi.mock("../org-registry.js", () => ({
  orgRegistry: vi.fn(() => new Map([["side-dev", { name: "side-dev", displayName: "Side Dev", ...roster.employee }]])),
}));

import { attachPtyWebSocket } from "../pty-ws.js";

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  send(): void {}
  close(): void { this.readyState = 3; this.emit("close"); }
  receive(message: unknown): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

class FakeEngine implements PtyViewEngine {
  spawnCalls: PtyIdleSpawnOpts[] = [];
  hasWarmPty(): boolean { return false; }
  ensureIdleSpawn(_id: string, opts: PtyIdleSpawnOpts): void { this.spawnCalls.push(opts); }
  restartPty(_id: string, opts: PtyIdleSpawnOpts): void { this.spawnCalls.push(opts); }
  subscribeWithSnapshot(): any {
    return { snapshot: Promise.resolve({ snapshot: undefined, ready: true }), start: () => {}, stop: () => {} };
  }
  writeStdin(): void {}
  writeRaw(): void {}
  resizePty(): void {}
  setViewing(): void {}
}

function idleSpawn(): PtyIdleSpawnOpts {
  const engine = new FakeEngine();
  const ws = new FakeWebSocket();
  attachPtyWebSocket(ws as any, "session-1", engine, { getConfig: () => ({}) } as any);
  ws.receive({ type: "resize", cols: 100, rows: 30 });
  expect(engine.spawnCalls.length).toBeGreaterThan(0);
  return engine.spawnCalls[0]!;
}

describe("the dashboard PTY and Claude profiles", () => {
  it("carries the employee's named profile into the idle spawn", () => {
    roster.employee = { claudeConfigDir: "/Users/operator/.claude-friend" };
    expect(idleSpawn().claudeProfile).toEqual(claudeProfileFromDir("/Users/operator/.claude-friend"));
  });

  it("carries no profile for an employee on the default one", () => {
    roster.employee = {};
    expect(idleSpawn().claudeProfile).toBeNull();
  });
});
