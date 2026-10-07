import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every engine spawn for a session that has an employee carries `JINN_EMPLOYEE=<slug>` in the
 * child's environment, and one without an employee carries none, whatever the gateway's own
 * environment holds. Each case drives a real session row through the engine's own env builder.
 * The remote session-env.sh is covered in remote-employee-env.test.ts.
 */

const spawned = vi.hoisted(() => [] as Array<{ bin: string; args: string[]; env: Record<string, string> }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[], options: { env?: Record<string, string> }) => {
      spawned.push({ bin, args, env: options.env ?? {} });
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(proc, {
        stdin: Object.assign(new PassThrough(), { end() {} }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4242, exitCode: null, killed: false, kill: () => true, unref() {},
      });
      return proc;
    }),
  };
});

import { createSession, deleteSession } from "../../sessions/registry.js";
import { employeeSessionEnv } from "../../sessions/employee-env.js";
import { buildEngineChildEnv } from "../../shared/child-env.js";
import { cleanEnv, localOpencodeLaunch } from "../opencode-launch.js";
import { codexChildEnv } from "../codex.js";
import { CodexInteractiveEngine } from "../codex-interactive.js";
import { GrokEngine } from "../grok.js";
import { GrokInteractiveEngine } from "../grok-interactive.js";
import { HermesInteractiveEngine } from "../hermes-interactive.js";
import { HermesAcpEngine } from "../hermes-acp.js";
import { PiEngine } from "../pi.js";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { buildAntigravityPtyEnv } from "../antigravity.js";
import { AntigravityHeadlessEngine } from "../antigravity-headless.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

const sessionIds: string[] = [];
let lifecycle: PtyLifecycleManager;

/** A session of `engine`, with the employee `slug` or none. */
function session(engine: string, employee?: string): string {
  const created = createSession({ engine, source: "web", sourceRef: `web:${employee ?? "none"}`, ...(employee ? { employee } : {}) });
  sessionIds.push(created.id);
  return created.id;
}

/** `build` run for a session with an employee and for one without. */
function expectEmployeeEnv(engine: string, build: (sessionId: string) => Record<string, string>): void {
  const withEmployee = session(engine, "build-dev");
  expect(build(withEmployee).JINN_EMPLOYEE).toBe("build-dev");
  expect(build(withEmployee).JINN_SESSION_ID).toBe(withEmployee);
  const without = session(engine);
  expect(build(without)).not.toHaveProperty("JINN_EMPLOYEE");
}

beforeEach(() => {
  spawned.length = 0;
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
});

afterEach(() => {
  lifecycle.killAll();
  for (const id of sessionIds.splice(0)) deleteSession(id);
  vi.unstubAllEnvs();
});

describe("employeeSessionEnv", () => {
  it("names the session's employee, and nothing for no employee, no session or an unknown one", () => {
    expect(employeeSessionEnv(session("claude", "build-dev"))).toEqual({ JINN_EMPLOYEE: "build-dev" });
    expect(employeeSessionEnv(session("claude"))).toEqual({});
    expect(employeeSessionEnv(undefined)).toEqual({});
    expect(employeeSessionEnv("no-such-session")).toEqual({});
  });
});

describe("a gateway that itself runs inside an employee's session", () => {
  beforeEach(() => vi.stubEnv("JINN_EMPLOYEE", "someone-else"));

  it("does not hand its own employee to a child", () => {
    expect(buildEngineChildEnv(process.env)).not.toHaveProperty("JINN_EMPLOYEE");
    expect(buildEngineChildEnv(process.env, { scopedSession: true })).not.toHaveProperty("JINN_EMPLOYEE");
  });

  it("gives each engine's session its own employee, or none", () => {
    expectEmployeeEnv("opencode", cleanEnv);
    expectEmployeeEnv("codex", (id) => codexChildEnv(process.env, id));
    expectEmployeeEnv("claude", (id) => (new InteractiveClaudeEngine(lifecycle, { register() {}, unregister() {} } as never) as any).buildPtyEnv(id));
  });
});

describe("the environment each engine spawns with", () => {
  it("opencode (turn, server and terminal view start from this)", () => {
    expectEmployeeEnv("opencode", cleanEnv);
    const id = session("opencode", "build-dev");
    const plan = localOpencodeLaunch({ prompt: "hi", cwd: process.cwd(), sessionId: id } as never, id);
    expect(plan.env.JINN_EMPLOYEE).toBe("build-dev");
  });

  it("claude, local (and the ssh client of a remote one)", () => {
    const engine = new InteractiveClaudeEngine(lifecycle, { register() {}, unregister() {} } as never);
    expectEmployeeEnv("claude", (id) => (engine as any).buildPtyEnv(id));
    expectEmployeeEnv("claude", (id) => (engine as any).buildPtyEnv(id, { sshClient: true }));
  });

  it("codex, headless", () => {
    expectEmployeeEnv("codex", (id) => codexChildEnv(process.env, id));
  });

  it("codex, interactive", () => {
    const engine = new CodexInteractiveEngine(lifecycle);
    expectEmployeeEnv("codex", (id) => (engine as any).buildEnv(id));
  });

  it("pi", () => {
    const engine = new PiEngine();
    expectEmployeeEnv("pi", (id) => (engine as any).buildCleanEnv(id));
  });

  it("grok, headless", () => {
    const engine = new GrokEngine();
    expectEmployeeEnv("grok", (id) => (engine as any).buildCleanEnv(id));
  });

  it("grok, interactive", () => {
    const engine = new GrokInteractiveEngine(lifecycle);
    expectEmployeeEnv("grok", (id) => (engine as any).buildEnv(id));
  });

  it("hermes, interactive", () => {
    const engine = new HermesInteractiveEngine(lifecycle);
    expectEmployeeEnv("hermes", (id) => (engine as any).buildEnv(id));
  });

  it("hermes, ACP", () => {
    vi.stubEnv("JINN_EMPLOYEE", "someone-else");
    const engine = new HermesAcpEngine();
    expectEmployeeEnv("hermes", (id) => {
      spawned.length = 0;
      (engine as any).spawnProc("hermes", process.cwd(), id);
      return spawned[0]!.env;
    });
  });

  it("antigravity, interactive", () => {
    expectEmployeeEnv("antigravity", (id) => buildAntigravityPtyEnv(id));
  });

  it("antigravity, headless", async () => {
    const engine = new AntigravityHeadlessEngine();
    const envOf = async (id: string) => {
      spawned.length = 0;
      void engine.run({ prompt: "hi", cwd: process.cwd(), sessionId: id } as never).catch(() => {});
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      engine.kill(id);
      return spawned[0]!.env;
    };
    const withEmployee = session("antigravity", "build-dev");
    expect((await envOf(withEmployee)).JINN_EMPLOYEE).toBe("build-dev");
    expect(await envOf(session("antigravity"))).not.toHaveProperty("JINN_EMPLOYEE");
  });
});
