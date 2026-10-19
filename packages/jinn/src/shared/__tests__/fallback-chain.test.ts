import { describe, expect, it } from "vitest";
import { claudeProfileFromDir } from "../claude-profile.js";
import { isLinkExhausted, linkAccount, linkHealthKey, resolveLinkModel, sessionFallbackChain } from "../fallback-chain.js";
import type { FallbackChainEntry, ResolvedFallbackLink } from "../fallback-chain-wire.js";
import type { EngineHealthReading } from "../engine-health.js";
import type { Employee, JinnConfig, ModelRegistry } from "../types.js";
import { makeSession } from "../../sessions/__tests__/helpers/session-fixture.js";

/** The chain resolver: precedence, the model rule, account and health keys, and the reasons a link is passed over. */

const DIR_A = "/Users/operator/.claude-a";
const DIR_B = "/Users/operator/.claude-b";
const KEY_A = `claude:${claudeProfileFromDir(DIR_A).key}`;
const KEY_B = `claude:${claudeProfileFromDir(DIR_B).key}`;

const CHAIN: FallbackChainEntry[] = [
  { engine: "claude", profile: "A", model: "opus" },
  { engine: "claude", profile: "B", model: "sonnet" },
  { engine: "opencode", model: "openrouter/x" },
  { engine: "opencode", model: "opencode-go/y" },
];

function config(claude: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } }, fallback: CHAIN, ...claude },
      codex: { bin: "codex", model: "gpt" },
      opencode: { bin: "opencode", model: "opencode/big-pickle" },
      ...rest,
    },
  } as unknown as JinnConfig;
}

function entry(name: string, models: string[]): ModelRegistry[string] {
  return { name, available: true, defaultModel: models[0] ?? "", effortMechanism: "none" as const, models: models.map((id) => ({ id, label: id, supportsEffort: false, effortLevels: [] })) };
}

const registry = (overrides: Partial<ModelRegistry> = {}): ModelRegistry => ({
  claude: entry("claude", ["opus", "sonnet"]),
  codex: entry("codex", ["gpt", "gpt-mini"]),
  opencode: entry("opencode", []),
  ...overrides,
} as ModelRegistry);

function employee(overrides: Partial<Employee> = {}): Employee {
  return { name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p", ...overrides };
}

const chainOf = (links: ResolvedFallbackLink[]) => links.map((link) => link.key);

function resolve(options: { config?: JinnConfig; employee?: Employee; session?: Parameters<typeof makeSession>[0]; registry?: ModelRegistry; health?: EngineHealthReading } = {}) {
  return sessionFallbackChain({
    config: options.config ?? config(),
    employee: options.employee,
    session: makeSession(options.session),
    registry: options.registry ?? registry(),
    health: options.health ?? {},
  });
}

describe("the acceptance chain", () => {
  it("resolves in written order with labels, accounts and health keys", () => {
    const { source, links } = resolve();
    expect(source).toBe("engine");
    expect(chainOf(links)).toEqual(["claude||opus", "claude|A|opus", "claude|B|sonnet", "opencode||openrouter/x", "opencode||opencode-go/y"]);
    expect(links.map((link) => link.label)).toEqual(["claude · opus", "claude · A · opus", "claude · B · sonnet", "opencode · openrouter/x", "opencode · opencode-go/y"]);
    expect(links.map((link) => link.account)).toEqual(["claude", KEY_A, KEY_B, "opencode", "opencode"]);
    expect(links.map((link) => linkHealthKey(link))).toEqual(["claude", KEY_A, KEY_B, "opencode/openrouter", "opencode/opencode-go"]);
    expect(links.every((link) => link.origin === "config" && link.skip === undefined)).toBe(true);
  });

  it("is the first link's own target at index 0, whatever the chain holds", () => {
    expect(resolve({ session: { model: "sonnet" } }).links[0]).toMatchObject({ engine: "claude", model: "sonnet", key: "claude||sonnet" });
  });
});

describe("precedence", () => {
  it("an employee's chain overrides the engine's, and [] means no fallback", () => {
    const own = [{ engine: "codex", model: "gpt-mini" }];
    expect(resolve({ employee: employee({ fallback: own }), session: { employee: "dev" } })).toMatchObject({ source: "employee" });
    expect(chainOf(resolve({ employee: employee({ fallback: own }) }).links)).toEqual(["claude||opus", "codex||gpt-mini"]);
    expect(resolve({ employee: employee({ fallback: [] }) })).toMatchObject({ source: "employee", links: [expect.objectContaining({ key: "claude||opus" })] });
  });

  it("a session's own fallback target is a one-link chain and beats the employee's", () => {
    const { source, links } = resolve({ employee: employee({ fallback: [{ engine: "codex" }] }), session: { fallbackTarget: { engine: "opencode", model: "openrouter/x" } } });
    expect(source).toBe("session");
    expect(chainOf(links)).toEqual(["claude||opus", "opencode||openrouter/x"]);
  });

  it("a declared account's chain applies to a session on that profile, and the default chain does not", () => {
    const c = config({ accounts: { A: { configDir: DIR_A, fallback: [{ engine: "codex" }] }, B: { configDir: DIR_B } } });
    const onA = resolve({ config: c, employee: employee({ claudeConfigDir: DIR_A }) });
    expect(onA.source).toBe("account");
    expect(chainOf(onA.links)).toEqual(["claude|A|opus", "codex||"]);
    // A declared account with no chain of its own has none: it does not borrow the engine's.
    expect(resolve({ config: c, employee: employee({ claudeConfigDir: DIR_B }) })).toMatchObject({ source: "account", links: [expect.anything()] });
  });

  it("an undeclared named profile with no employee chain has none; an employee chain still applies", () => {
    const undeclared = employee({ claudeConfigDir: "/Users/operator/.claude-other" });
    expect(resolve({ employee: undeclared })).toMatchObject({ source: "none", links: [expect.objectContaining({ key: "claude||opus" })] });
    expect(resolve({ employee: { ...undeclared, fallback: [{ engine: "codex" }] } }).source).toBe("employee");
  });

  it("another engine's session takes that engine's default chain", () => {
    const c = config({}, { codex: { bin: "codex", model: "gpt", fallback: [{ engine: "claude", profile: "B", model: "sonnet" }] } });
    const { source, links } = resolve({ config: c, session: { engine: "codex", model: "gpt" } });
    expect(source).toBe("engine");
    expect(chainOf(links)).toEqual(["codex||gpt", "claude|B|sonnet"]);
  });
});

describe("legacy strings in a chain", () => {
  const c = config({ fallback: ["claude:A", "codex"], accounts: { A: { configDir: DIR_A, fallback: ["opencode"] }, B: { configDir: DIR_B } } }, { codex: { bin: "codex", model: "gpt", fallback: ["claude:B"] } });

  it("expands in place, marks what a chain brought in as legacy, and drops a target already listed", () => {
    const { links } = resolve({ config: c });
    expect(links.map((link) => `${link.engine}/${link.profile ?? ""}:${link.origin}`)).toEqual([
      "claude/:config", "claude/A:config", "codex/:config", "opencode/:legacy", "claude/B:legacy",
    ]);
  });
});

describe("the model rule", () => {
  const plain = config();
  const cfg = config({ fallbackModelMap: { opus: "gpt-mini" } });
  const session = { engine: "claude", model: "opus" };

  it("a link's own model wins", () => {
    expect(resolveLinkModel(cfg, registry(), session, { engine: "claude", profile: "B", model: "sonnet" })).toBe("sonnet");
  });

  it("on the session's engine, the session's model", () => {
    expect(resolveLinkModel(cfg, registry(), session, { engine: "claude", profile: "B" })).toBe("opus");
  });

  it("on another engine, the fallbackModelMap translation when it names a model that engine serves, else the engine's default", () => {
    expect(resolveLinkModel(cfg, registry(), session, { engine: "codex" })).toBe("gpt-mini");
    expect(resolveLinkModel(plain, registry(), { engine: "claude", model: "sonnet" }, { engine: "codex" })).toBeUndefined();
    expect(resolveLinkModel(cfg, registry(), { engine: "claude", model: null }, { engine: "codex" })).toBeUndefined();
  });

  it("an inherited model is part of the link's key, so a link that lands on the session's own target is dropped", () => {
    const { links } = resolve({ employee: employee({ fallback: [{ engine: "claude" }, { engine: "claude", profile: "B" }] }) });
    expect(chainOf(links)).toEqual(["claude||opus", "claude|B|opus"]);
  });
});

describe("accounts and health keys", () => {
  it("a Claude link maps to its declared profile's account, or to claude with no profile; any other link to its engine", () => {
    expect(linkAccount({ engine: "claude", profile: "A" }, config())).toBe(KEY_A);
    expect(linkAccount({ engine: "claude" }, config())).toBe("claude");
    expect(linkAccount({ engine: "opencode", model: "openrouter/x" }, config())).toBe("opencode");
  });

  it("an opencode link with provider/model keys on the provider; with no provider on the engine", () => {
    expect(linkHealthKey({ engine: "opencode", model: "openrouter/z-ai/glm-5", account: "opencode" })).toBe("opencode/openrouter");
    expect(linkHealthKey({ engine: "opencode", account: "opencode" })).toBe("opencode");
    expect(linkHealthKey({ engine: "opencode", model: "plain", account: "opencode" })).toBe("opencode");
    expect(linkHealthKey({ engine: "codex", model: "a/b", account: "codex" })).toBe("codex");
  });

  const until = new Date(Date.now() + 3_600_000).toISOString();
  const spent = (): EngineHealthReading[string] => ({ state: "exhausted", until, recheckAt: until });
  const link = (model: string) => ({ engine: "opencode", model, account: "opencode" });

  it("exhausted is read under the link's key and the engine-wide key", () => {
    expect(isLinkExhausted({ "opencode/openrouter": spent() }, link("openrouter/x"))).toBe(true);
    expect(isLinkExhausted({ "opencode/openrouter": spent() }, link("opencode-go/y"))).toBe(false);
    expect(isLinkExhausted({ opencode: spent() }, link("opencode-go/y"))).toBe(true);
    expect(isLinkExhausted({ opencode: { state: "degraded", until } }, link("opencode-go/y"))).toBe(false);
  });

  it("a Claude link has no engine-wide key: the default account's limit does not mark a named account", () => {
    const named = { engine: "claude", profile: "A", account: KEY_A };
    expect(isLinkExhausted({ claude: spent() }, named)).toBe(false);
    expect(isLinkExhausted({ [KEY_A]: spent() }, named)).toBe(true);
  });

  it("reports state, reset and the latest cached reading's binding window on each link", () => {
    const now = new Date();
    const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
    const { links } = sessionFallbackChain({
      config: config(), session: makeSession(), registry: registry(), now,
      health: { [KEY_A]: spent(), "opencode/openrouter": { state: "degraded", until } },
      limits: { [KEY_B]: { at: now.getTime(), windows: [{ name: "5h", usedPercent: 40, resetsAt }, { name: "7d", usedPercent: 81, resetsAt }, { name: "5h", usedPercent: 99, resetsAt: 1 }] } },
    });
    expect(links.map((link) => link.health?.state)).toEqual(["ok", "exhausted", "ok", "degraded", "ok"]);
    expect(links[1]!.health).toMatchObject({ state: "exhausted", until });
    expect(links[2]!.health).toEqual({ state: "ok", usedPercent: 81, window: "7d" });
  });

  it("a cached reading at 100% reads exhausted until its reset, with no health record", () => {
    const now = new Date();
    const resetsAt = Math.floor(now.getTime() / 1000) + 3600;
    const { links } = sessionFallbackChain({
      config: config(), session: makeSession(), registry: registry(), now, health: {},
      limits: { [KEY_A]: { at: now.getTime(), windows: [{ name: "5h", usedPercent: 100, resetsAt }] } },
    });
    expect(links[1]!.health).toEqual({ state: "exhausted", until: new Date(resetsAt * 1000).toISOString(), usedPercent: 100, window: "5h" });
  });
});

describe("links passed over", () => {
  const skips = (links: ResolvedFallbackLink[]) => links.slice(1).map((link) => link.skip);

  it("not-installed: the registry says the engine is not available", () => {
    const r = registry({ opencode: { ...entry("opencode", []), available: false } });
    expect(skips(resolve({ registry: r }).links)).toEqual([undefined, undefined, "not-installed", "not-installed"]);
  });

  it("scoped: a department-scoped session takes Claude links only", () => {
    expect(skips(resolve({ session: { scopeDepartment: "ops" } }).links)).toEqual([undefined, undefined, "scoped", "scoped"]);
  });

  it("remote: an engine that cannot run on a host, and a remote session's local profile", () => {
    const remote = employee({ remoteHost: "build.example", fallback: [{ engine: "codex" }, { engine: "claude", profile: "A" }, { engine: "opencode", model: "openrouter/x" }, { engine: "claude", model: "sonnet" }] });
    expect(skips(resolve({ employee: remote }).links)).toEqual(["remote", "remote", undefined, undefined]);
  });

  it("profile-unknown: a profile that is not a declared account, or sits on a non-Claude link", () => {
    const e = employee({ fallback: [{ engine: "claude", profile: "ghost" }, { engine: "codex", profile: "A" }] });
    const { links } = resolve({ employee: e });
    expect(skips(links)).toEqual(["profile-unknown", "profile-unknown"]);
  });

  it("model-not-served: only when the registry lists models for that engine", () => {
    const e = employee({ fallback: [{ engine: "codex", model: "gone" }, { engine: "codex", model: "gpt-mini" }, { engine: "opencode", model: "any/thing" }] });
    expect(skips(resolve({ employee: e }).links)).toEqual(["model-not-served", undefined, undefined]);
  });
});
