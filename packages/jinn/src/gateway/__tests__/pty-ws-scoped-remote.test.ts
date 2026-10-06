import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyIdleSpawnOpts, PtyViewEngine } from "../../engines/pty-view-engine.js";

/**
 * The dashboard terminal of a department-scoped remote employee attaches in the
 * department's stage directory on the host, not the employee's own remoteCwd (FR-061);
 * an unscoped remote employee still attaches in its own.
 */

const SLUG = "pty-remote-dept";
const hoisted = vi.hoisted(() => ({ session: undefined as undefined | Record<string, unknown> }));

vi.mock("../../sessions/registry.js", () => ({
  getSession: vi.fn(() => hoisted.session),
  getEngineSessionRef: vi.fn(() => ({ id: "native-1" })),
}));
vi.mock("../org-registry.js", () => ({
  orgRegistry: vi.fn(() => new Map([["remote-dev", {
    name: "remote-dev", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work", remoteClaudeConfigDir: "/srv/profiles/a",
  }]])),
}));

import { departmentStageDir } from "../department-scope/paths.js";
import { refreshDepartments, resetDepartmentRegistryForTests } from "../department-registry.js";
import { attachPtyWebSocket } from "../pty-ws.js";
import { JINN_HOME } from "../../shared/paths.js";

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

const CONFIG = { remote: { root: "/srv/root", mount: "/mnt/jinn" } } as any;

function attach(): FakeEngine {
  const engine = new FakeEngine();
  const ws = new FakeWebSocket();
  attachPtyWebSocket(ws as any, "session-1", engine, { getConfig: () => CONFIG } as any);
  ws.receive({ type: "resize", cols: 100, rows: 30 });
  return engine;
}

beforeEach(() => {
  resetDepartmentRegistryForTests();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  const dir = path.join(JINN_HOME, "org", SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "department.yaml"), `name: ${SLUG}\nscope: scoped\n`);
  refreshDepartments();
});

describe("the dashboard terminal's idle spawn for a remote employee", () => {
  it("attaches a scoped session in the department's stage directory on the host", () => {
    hoisted.session = { id: "session-1", employee: "remote-dev", scopeDepartment: SLUG, model: "opus" };
    const opts = attach().spawnCalls[0]!;
    expect(opts).toMatchObject({
      remoteHost: "build-box", remoteUser: "ci", remoteCwd: `/srv/root/.jinn-departments/${SLUG}`,
      remoteDepartment: SLUG, remoteWorkArea: "/srv/root/work", remoteClaudeConfigDir: "/srv/profiles/a",
    });
  });

  it("attaches an unscoped session in the employee's own remote cwd", () => {
    hoisted.session = { id: "session-1", employee: "remote-dev", scopeDepartment: null, model: "opus" };
    const opts = attach().spawnCalls[0]!;
    expect(opts).toMatchObject({ remoteHost: "build-box", remoteCwd: "/srv/root/work" });
    expect(opts.remoteDepartment).toBeUndefined();
  });
});
