import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyIdleSpawnOpts, PtyViewEngine } from "../../engines/pty-view-engine.js";

/**
 * The dashboard terminal of a department-scoped session attaches in the department's
 * stage directory, never in the Jinn home (FR-020b); anyone else's still attaches in
 * the Jinn home.
 */

const SLUG = "pty-scoped-dept";
const hoisted = vi.hoisted(() => ({ session: undefined as undefined | Record<string, unknown> }));

vi.mock("../../sessions/registry.js", () => ({
  getSession: vi.fn(() => hoisted.session),
  getEngineSessionRef: vi.fn(() => ({ id: "native-1" })),
}));
vi.mock("../org-registry.js", () => ({ orgRegistry: vi.fn(() => new Map()) }));

import { departmentStageDir } from "../department-scope/paths.js";
import { refreshDepartments, resetDepartmentRegistryForTests } from "../department-registry.js";
import { resolvedStageDir } from "../department-stage/stage.js";
import { attachPtyWebSocket } from "../pty-ws.js";
import { JINN_HOME } from "../../shared/paths.js";

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: Array<string | Buffer> = [];
  send(data: string | Buffer): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit("close"); }
  receive(message: unknown): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
  controls(): Array<Record<string, unknown>> { return this.sent.flatMap((s) => { try { return [JSON.parse(String(s))]; } catch { return []; } }); }
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

function attach(engine: FakeEngine): FakeWebSocket {
  const ws = new FakeWebSocket();
  attachPtyWebSocket(ws as any, "session-1", engine, { getConfig: () => ({}) } as any);
  ws.receive({ type: "resize", cols: 100, rows: 30 });
  return ws;
}

beforeEach(() => {
  resetDepartmentRegistryForTests();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  const dir = path.join(JINN_HOME, "org", SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "department.yaml"), `name: ${SLUG}\nscope: scoped\n`);
  refreshDepartments();
});

describe("the dashboard terminal's idle spawn", () => {
  it("attaches a scoped session in its stage directory", () => {
    hoisted.session = { id: "session-1", employee: "pty-dev", scopeDepartment: SLUG, model: "opus" };
    const engine = new FakeEngine();
    attach(engine);
    expect(engine.spawnCalls[0]!.cwd).toBe(resolvedStageDir(SLUG));
    expect(engine.spawnCalls[0]!.cwd).not.toBe(JINN_HOME);
    expect(fs.existsSync(path.join(engine.spawnCalls[0]!.cwd!, "CLAUDE.md"))).toBe(true);
  });

  it("attaches anyone else in the Jinn home", () => {
    hoisted.session = { id: "session-1", employee: null, scopeDepartment: null, model: "opus" };
    const engine = new FakeEngine();
    attach(engine);
    expect(engine.spawnCalls[0]!.cwd).toBe(JINN_HOME);
  });

  it("starts no terminal for a scoped session whose stage directory cannot be prepared, rather than attach in the Jinn home", () => {
    hoisted.session = { id: "session-1", employee: "pty-dev", scopeDepartment: SLUG, model: "opus" };
    const root = path.dirname(departmentStageDir(SLUG));
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "not a directory");
    try {
      const engine = new FakeEngine();
      const ws = attach(engine);
      expect(engine.spawnCalls).toEqual([]);
      expect(ws.controls().some((c) => c.type === "error" && String(c.message).includes("could not be prepared"))).toBe(true);
    } finally {
      fs.rmSync(root, { force: true });
    }
  });
});
