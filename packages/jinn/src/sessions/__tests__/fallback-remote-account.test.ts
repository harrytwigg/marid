import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An unprofiled Claude link in a remote employee's chain runs as that employee's
 * remote login, so its limit is recorded, read and shown under that account and
 * never under the gateway's own `claude`: in the walk, in the reroute at
 * creation and in the chain display.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
  getModelRegistry: () => ({}),
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
let health: Record<string, { state: "exhausted"; until: string; recheckAt: string }> = {};
const recordEngineUnavailable = vi.fn();
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => health,
  recordEngineUnavailable: (...args: unknown[]) => recordEngineUnavailable(...args),
}));
const recordClaudeRateLimit = vi.fn();
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: (...args: unknown[]) => recordClaudeRateLimit(...args) }));

import { chooseSubstituteOrReason, type ChooseSubstituteInput } from "../rate-limit-substitute.js";
import { rerouteAtCreation } from "../fallback-reroute.js";
import { recordLinkLimit } from "../fallback-link-run.js";
import { sessionFallbackChainView } from "../session-fallback-chain.js";
import { availabilityRegistry } from "../availability-registry.js";
import { fallbackChainsResponse } from "../../shared/fallback-chain-subjects.js";
import { makeSession } from "./helpers/session-fixture.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

const REMOTE_ACCOUNT = "claude@ci@build-box";
const LOCAL_ACCOUNT = "claude";
const engines = new Set(["claude", "opencode"]);
const installed = availabilityRegistry({}, (name) => engines.has(name));
const spent = () => { const until = new Date(Date.now() + 3600_000).toISOString(); return { state: "exhausted" as const, until, recheckAt: until }; };

const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, opencode: { bin: "opencode" } } } as unknown as JinnConfig;
const remoteEmployee = {
  name: "r", engine: "claude", model: "opus", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/work",
  fallback: [{ engine: "claude", model: "sonnet" }, { engine: "opencode", model: "x/m" }],
} as unknown as Employee;
const remote = { remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/work" };

function decide() {
  const input = { config, engines, session: makeSession({ engine: "claude" }), employee: remoteEmployee, account: REMOTE_ACCOUNT, remote, remoteTarget: remote } as unknown as ChooseSubstituteInput;
  return chooseSubstituteOrReason(input);
}

beforeEach(() => { health = {}; recordEngineUnavailable.mockClear(); recordClaudeRateLimit.mockClear(); });

describe("a remote employee's unprofiled Claude link", () => {
  it("is keyed on the employee's remote login, the own target included", () => {
    const { chain } = decide();
    expect(chain!.links.filter((link) => link.engine === "claude").map((link) => [link.key, link.account])).toEqual([
      ["claude||opus", REMOTE_ACCOUNT], ["claude||sonnet", REMOTE_ACCOUNT],
    ]);
    expect(chain!.links.find((link) => link.engine === "opencode")!.account).toBe("opencode");
  });

  it("records its limit under the remote login, never under `claude`", () => {
    const link = decide().chain!.links[1]!;
    recordLinkLimit(link, 1_900_000_000);
    expect(recordEngineUnavailable).toHaveBeenCalledTimes(1);
    expect(recordEngineUnavailable.mock.calls[0]![0]).toBe(REMOTE_ACCOUNT);
    expect(recordClaudeRateLimit).toHaveBeenCalledWith(1_900_000_000, REMOTE_ACCOUNT);
  });

  it("reads the remote login's limit and not the gateway's own", () => {
    health = { [LOCAL_ACCOUNT]: spent() };
    expect(decide().chain!.links.map((link) => link.health?.state)).toEqual(["ok", "ok", "ok"]);
    health = { [REMOTE_ACCOUNT]: spent() };
    expect(decide().chain!.links.map((link) => link.health?.state)).toEqual(["exhausted", "exhausted", "ok"]);
  });

  describe("at creation", () => {
    const args = (over: Record<string, unknown> = {}) => ({
      config, employee: remoteEmployee, engine: "claude", model: "opus", registry: installed, scope: { scoped: false, remote: true }, health: {}, ...over,
    });

    it("moves off a spent remote login to the first healthy link", () => {
      const choice = rerouteAtCreation(args({ health: { [REMOTE_ACCOUNT]: spent() } }))!;
      // The `claude` sonnet link is the same login, spent too: the opencode link is next.
      expect(choice).toMatchObject({ engine: "opencode", model: "x/m", reroute: { run: { position: 2 } } });
      expect(choice.reroute.account).toBeUndefined();
    });

    it("stays when only the gateway's own login is spent", () => {
      expect(rerouteAtCreation(args({ health: { [LOCAL_ACCOUNT]: spent() } }))).toBeUndefined();
    });
  });

  describe("in the chain display", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const view = (limits: Record<string, unknown>) => sessionFallbackChainView({
      config, employee: remoteEmployee, session: makeSession({ engine: "claude", employee: "r" }), registry: installed, health: {},
      scope: { scoped: false, remote: true }, limits: limits as never,
    });
    const reading = (usedPercent: number) => ({ at: Date.now(), windows: [{ name: "5h", usedPercent, resetsAt }] });

    it("shows the remote login's usage on its Claude links", () => {
      const { links } = view({ [REMOTE_ACCOUNT]: reading(100), [LOCAL_ACCOUNT]: reading(10) });
      expect(links.map((link) => [link.account, link.health?.state])).toEqual([
        [REMOTE_ACCOUNT, "exhausted"], [REMOTE_ACCOUNT, "exhausted"], ["opencode", "ok"],
      ]);
    });

    it("shows the employee's chain in the editor on the remote login too", () => {
      const subject = fallbackChainsResponse({ config, registry: installed, health: {} }, { employee: remoteEmployee, scope: { scoped: false, remote: true } })
        .subjects.find((entry) => entry.kind === "employee")!;
      expect(subject.primary?.account).toBe(REMOTE_ACCOUNT);
      expect(subject.effective.map((link) => link.account)).toEqual([REMOTE_ACCOUNT, "opencode"]);
    });
  });
});
