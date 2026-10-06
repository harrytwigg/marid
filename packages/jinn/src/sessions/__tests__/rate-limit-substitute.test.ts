import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which substitute a rate-limited turn moves onto (FR-079, FR-056, FR-076):
 * a local Claude session walks its own account's chain, an undeclared named
 * profile waits, a board walk turn never moves, and a remote employee keeps
 * main's engine-only rule.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
let health: Record<string, { state: "exhausted"; until: string; recheckAt: string }> = {};
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => health,
}));

import { chooseSubstitute } from "../rate-limit-substitute.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { makeSession } from "./helpers/session-fixture.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

const FRIEND = "/Users/operator/.claude-friend";
const WORK2 = "/Users/operator/.claude-work2";
const friend = claudeProfileFromDir(FRIEND);
const work2 = claudeProfileFromDir(WORK2);
const engines = new Set(["claude", "codex", "pi"]);
const spent = () => { const until = new Date(Date.now() + 3600_000).toISOString(); return { state: "exhausted" as const, until, recheckAt: until }; };

const config = {
  engines: {
    default: "claude",
    claude: {
      bin: "claude", model: "opus", fallback: ["codex"],
      accounts: {
        friend: { configDir: FRIEND, fallback: [] },
        work2: { configDir: WORK2, fallback: ["claude", "codex"] },
      },
    },
    codex: { bin: "codex", model: "gpt" },
    pi: { bin: "pi", model: "m" },
  },
} as unknown as JinnConfig;

function choose(account: string, employee: Partial<Employee> = {}, session = makeSession({ engine: "claude" })) {
  const emp = { name: "e", engine: "claude", ...employee } as Employee;
  const remote = emp.remoteHost ? { remoteHost: emp.remoteHost } : undefined;
  return chooseSubstitute({ config, engines, session, employee: emp, account, remote, remoteTarget: remote ?? {} });
}

beforeEach(() => { health = {}; });

describe("a local Claude session walks its own account's chain", () => {
  it("a declared account with fallback: [] waits for its own reset", () => {
    expect(choose(`claude:${friend.key}`, { claudeConfigDir: FRIEND })).toBeUndefined();
  });

  it("[claude, codex] moves to the default account's profile, recording both accounts", () => {
    expect(choose(`claude:${work2.key}`, { claudeConfigDir: WORK2 })).toEqual({
      engine: "claude",
      claudeProfile: null,
      accounts: { original: `claude:${work2.key}`, substitute: "claude", substituteConfigDir: null, fallbackModelMap: undefined },
    });
  });

  it("[claude, codex] moves to codex when the default account is exhausted", () => {
    health = { claude: spent() };
    expect(choose(`claude:${work2.key}`, { claudeConfigDir: WORK2 })).toEqual({ engine: "codex", claudeProfile: null });
  });

  it("the default account's chain is unchanged", () => {
    expect(choose("claude")).toEqual({ engine: "codex", claudeProfile: null });
  });

  it("an undeclared named profile never inherits engines.claude.fallback", () => {
    const stray = claudeProfileFromDir("/Users/operator/.claude-stray");
    expect(choose(`claude:${stray.key}`, { claudeConfigDir: stray.dir })).toBeUndefined();
  });

  it("the default account moves onto a declared account it names, on that account's profile", () => {
    const named = { ...config, engines: { ...config.engines, claude: { ...config.engines.claude, fallback: ["claude:friend"] } } } as JinnConfig;
    const pick = chooseSubstitute({
      config: named, engines, session: makeSession({ engine: "claude" }), employee: { name: "e" } as Employee,
      account: "claude", remote: undefined, remoteTarget: {},
    });
    expect(pick).toMatchObject({ engine: "claude", claudeProfile: friend, accounts: { substitute: `claude:${friend.key}`, substituteConfigDir: friend.dir } });
  });
});

describe("turns that never move", () => {
  it("a board walk turn is never substituted", () => {
    expect(choose("claude", {}, makeSession({ engine: "claude", sessionKey: "board-walk:2026-10-06T10:00:00.000Z" }))).toBeUndefined();
  });
});

describe("remote employees keep main's rule", () => {
  it("walk engines only, limited to those their host can run", () => {
    expect(choose("claude@box", { remoteHost: "box" })).toBeUndefined();
    const piFirst = { ...config, engines: { ...config.engines, claude: { ...config.engines.claude, fallback: ["claude:friend", "codex", "pi"] } } } as JinnConfig;
    const pick = chooseSubstitute({
      config: piFirst, engines, session: makeSession({ engine: "claude" }), employee: { name: "e", remoteHost: "box" } as Employee,
      account: "claude@box", remote: { remoteHost: "box" }, remoteTarget: { remoteHost: "box" },
    });
    expect(pick).toEqual({ engine: "pi", claudeProfile: null });
  });
});

describe("a department-scoped session (FR-026a)", () => {
  const scoped = () => makeSession({ engine: "claude", scopeDepartment: "side-project" });

  it("skips engine entries and waits when its chain has no Claude account", () => {
    expect(choose("claude")?.engine).toBe("codex");
    expect(choose("claude", {}, scoped())).toBeUndefined();
  });

  it("moves only to a Claude account in its chain, even one recorded exhausted, never to the engine entry", () => {
    health = { claude: spent() };
    const choice = choose(`claude:${work2.key}`, { claudeConfigDir: WORK2 }, scoped());
    expect(choice?.engine).toBe("claude");
    expect(choice?.accounts?.substitute).toBe("claude");
  });
});
