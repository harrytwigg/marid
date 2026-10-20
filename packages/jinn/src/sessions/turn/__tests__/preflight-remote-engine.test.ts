import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, JinnConfig, Session } from "../../../shared/types.js";
import type { TurnInput } from "../types.js";

/**
 * Turn preflight judges an engine's install where the turn runs. A remote
 * session whose engine can run on its host needs the CLI on that host, not on
 * the gateway; every other session needs it on the gateway.
 */

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn(() => undefined) }));
vi.mock("../../../gateway/budgets.js", () => ({ isBudgetExhausted: vi.fn(() => false) }));

/** Engines whose CLI the gateway has. */
let onGateway = new Set<string>();
vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: (_config: unknown, name: string) => onGateway.has(name),
  effortLevelsForModel: vi.fn(() => []),
}));
/** What the host's facts say is installed there, by engine; unset is a host not probed yet. */
let onHost: Record<string, boolean> = {};
const asked: string[] = [];
vi.mock("../../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../engines/remote-stage.js")>()),
  remoteEngineAvailable: (destination: string, engine: string) => {
    asked.push(`${destination}:${engine}`);
    return onHost[engine];
  },
}));

import { preflightTurn } from "../preflight.js";

const ENGINES = ["claude", "pi", "opencode", "musecode", "freebuff", "codex"];
const config = { engines: { default: "claude", claude: {}, musecode: {} } } as unknown as JinnConfig;
const REMOTE = { remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/agents/main" };

function input(engine: string, employee?: Partial<Employee>): TurnInput {
  const session = { id: "s1", engine, source: "web", status: "running", attemptToken: "t" } as unknown as Session;
  return {
    session, attemptToken: "t", prompt: "hello", attachments: [], config,
    employee: employee ? { name: "worker", engine, ...employee } as Employee : undefined,
    engines: new Map(ENGINES.map((e) => [e, {} as never])), gatewayBootId: "boot",
    connectorNames: [], channel: "web", user: "operator",
  } as TurnInput;
}

beforeEach(() => {
  onGateway = new Set();
  onHost = {};
  asked.length = 0;
});

describe("preflightTurn — where the engine must be installed", () => {
  it("lets a remote session run when its host has the CLI and the gateway does not", () => {
    onHost = { musecode: true, pi: true, opencode: true };
    for (const engine of ["musecode", "pi", "opencode"]) {
      expect(preflightTurn(input(engine, REMOTE)).ok, engine).toBe(true);
    }
    expect(asked).toContain("builder@build-box:musecode");
  });

  it("lets a remote session run when its host has not been probed yet, as the spawn will say", () => {
    expect(preflightTurn(input("musecode", REMOTE)).ok).toBe(true);
  });

  it("refuses a remote session whose host is known to lack the CLI, naming the host and the binary", () => {
    onGateway = new Set(["musecode"]);
    onHost = { musecode: false };
    const plan = preflightTurn(input("musecode", REMOTE));
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.error).toMatch(/^builder@build-box has no `muse` on the non-interactive PATH/);
  });

  it("does not count the gateway's CLI for a remote engine that can run on its host", () => {
    onGateway = new Set(["pi"]);
    onHost = { pi: false };
    expect(preflightTurn(input("pi", REMOTE)).ok).toBe(false);
  });

  it("judges Freebuff on its host too: a host that lacks it is refused cleanly, one that has it runs the turn", () => {
    onHost = { freebuff: false };
    const refused = preflightTurn(input("freebuff", REMOTE));
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/^builder@build-box has no `freebuff` on the non-interactive PATH/);
    expect(asked).toContain("builder@build-box:freebuff");

    onGateway = new Set();
    onHost = { freebuff: true };
    expect(preflightTurn(input("freebuff", REMOTE)).ok).toBe(true);
    // A host nobody has probed yet is left for the spawn to report.
    onHost = {};
    expect(preflightTurn(input("freebuff", REMOTE)).ok).toBe(true);
  });

  it("still asks the gateway for a local session", () => {
    onHost = { musecode: true };
    const refused = preflightTurn(input("musecode", { name: "local-worker" }));
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/Engine "musecode" is not available — the "muse" CLI was not found on your PATH/);
    expect(asked).toEqual([]);

    onGateway = new Set(["musecode"]);
    expect(preflightTurn(input("musecode", { name: "local-worker" })).ok).toBe(true);
    expect(preflightTurn(input("musecode")).ok).toBe(true);
  });

  it("still asks the gateway when a remote employee's engine cannot run on a host", () => {
    onHost = { codex: true };
    const refused = preflightTurn(input("codex", REMOTE));
    expect(refused.ok === false && refused.error).toMatch(/Engine "codex" is not available/);
    expect(asked).toEqual([]);
  });
});
