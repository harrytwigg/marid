import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, HundredfoldConfig, ModelInfo } from "../../shared/types.js";
import type { OpencodeCloneModel } from "../../shared/opencode-clone.js";
import { baseConfig, loadApi, registry as sessions, resetFallbackFixture, unloadApi } from "./session-fallback-api-harness.js";

/**
 * Which accounts a session's opencode processes get (design, "Staging"): only
 * those its resolved chain can reach, so one session's process environment never
 * holds another workspace's key.
 */

const KEY_A = "sentinel-key-a-0123456789abcdef";
const KEY_B = "sentinel-key-b-fedcba9876543210";

const catalogue: ModelInfo[] = [{ id: "base-go/alpha", label: "alpha", supportsEffort: false, effortLevels: [] }];
const clones = new Map<string, readonly OpencodeCloneModel[]>([["base-go", [
  { id: "alpha", npm: "@opencode/ai/providers/openai-compatible", endpoint: "https://go.example.test/openai/v1" },
]]]);

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/opencode-catalogue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/opencode-catalogue.js")>()),
  opencodeCatalogue: () => catalogue,
  opencodeClones: () => clones,
}));

beforeAll(loadApi);
afterAll(unloadApi);

const ACCOUNTS = {
  a: { provider: "go-a", base: "base-go", keyEnv: "GO_A_KEY" },
  b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY" },
};
const link = (model: string) => ({ engine: "opencode", model });

function configWith(claudeFallback: unknown[] = [], extra: Record<string, unknown> = {}): HundredfoldConfig {
  return {
    ...baseConfig,
    engines: {
      ...baseConfig.engines,
      claude: { bin: "claude", model: "opus", fallback: claudeFallback },
      opencode: { bin: "opencode", model: "base-go/alpha", accounts: ACCOUNTS, ...extra },
    },
  } as unknown as HundredfoldConfig;
}

const employee = (fallback?: unknown[]): Employee => ({
  name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "claude", model: "opus", persona: "fixture",
  ...(fallback === undefined ? {} : { fallback }),
}) as unknown as Employee;

beforeEach(() => {
  resetFallbackFixture();
  process.env.GO_A_KEY = KEY_A;
  process.env.GO_B_KEY = KEY_B;
});

async function reach(config: HundredfoldConfig, over: { session?: Record<string, unknown>; employee?: Employee; model?: string; scope?: { scoped: boolean; remote: boolean } } = {}) {
  const { reachableOpencodeProviders } = await import("../opencode-account-reach.js");
  const { getModelRegistry, invalidateModelRegistry } = await import("../../shared/models.js");
  invalidateModelRegistry();
  const session = over.session === undefined ? undefined : sessions.createSession({ engine: "claude", source: "web", sourceRef: `web:reach-${Math.random()}`, model: "opus", ...over.session });
  return reachableOpencodeProviders({ config, registry: getModelRegistry(config), session, employee: over.employee, model: over.model, ...(over.scope ? { scope: over.scope } : {}) });
}

describe("reachableOpencodeProviders", () => {
  it("is the providers of an employee's own chain, and not the other account's", async () => {
    const found = await reach(configWith(), { session: {}, employee: employee([link("go-a/alpha")]) });
    expect([...found]).toEqual(["go-a"]);
  });

  it("is empty for a session whose chain names no opencode link", async () => {
    expect([...await reach(configWith(), { session: {}, employee: employee([]) })]).toEqual([]);
    expect([...await reach(configWith([{ engine: "codex" }]), { session: {} })]).toEqual([]);
  });

  it("follows the chain a session inherits from its engine, every opencode link of it", async () => {
    const found = await reach(configWith([link("go-b/alpha"), link("base-go/alpha")]), { session: {} });
    expect([...found].sort()).toEqual(["base-go", "go-b"]);
  });

  it("includes a stored per-session fallback target", async () => {
    const found = await reach(configWith(), { session: { fallbackTarget: { engine: "opencode", model: "go-b/alpha", label: "x" } } });
    expect([...found]).toEqual(["go-b"]);
  });

  it("includes the provider of the model the turn runs on, with or without a session record", async () => {
    expect([...await reach(configWith(), { model: "go-a/alpha" })]).toEqual(["go-a"]);
    expect([...await reach(configWith(), { session: {}, employee: employee([link("go-a/alpha")]), model: "go-b/alpha" })].sort()).toEqual(["go-a", "go-b"]);
  });

  it("reads the chain of the target a stand-in was moved off, not the stand-in's own link", async () => {
    // Standing on opencode/go-b after a limit on claude/opus: the chain is claude's, and go-b is reached only if that chain names it.
    const session = { engine: "opencode", model: "go-b/alpha", transportMeta: { engineOverride: { originalEngine: "claude", originalModel: "opus" } } };
    expect([...await reach(configWith(), { session, employee: employee([link("go-a/alpha")]) })]).toEqual(["go-a"]);
  });

  it("leaves out links a department-scoped session can never walk", async () => {
    const found = await reach(configWith(), { session: {}, employee: employee([link("go-a/alpha")]), scope: { scoped: true, remote: false } });
    expect([...found]).toEqual([]);
  });
});

describe("opencodeAccountsReaderFor", () => {
  async function staged(config: HundredfoldConfig, sessionId?: string, model?: string) {
    const { opencodeAccountsReaderFor } = await import("../opencode-account-reach.js");
    const { invalidateModelRegistry } = await import("../../shared/models.js");
    invalidateModelRegistry();
    return opencodeAccountsReaderFor(() => config)({ ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}) });
  }

  it("gives a session with an a-only chain account A's block and key, and not B's", async () => {
    const session = sessions.createSession({ engine: "claude", source: "web", sourceRef: "web:reader-a", model: "opus", employee: "a-worker" });
    const config = configWith([link("go-a/alpha")]);
    const accounts = await staged(config, session.id);
    expect(Object.keys(accounts!.providers(2))).toEqual(["go-a"]);
    expect(accounts!.env).toEqual({ GO_A_KEY: KEY_A });
    expect(accounts!.fingerprint).not.toContain("go-b");
  });

  it("gives a session whose chain names no account nothing: no block and no key", async () => {
    const session = sessions.createSession({ engine: "claude", source: "web", sourceRef: "web:reader-none", model: "opus", employee: "a-worker" });
    const accounts = await staged(configWith(), session.id);
    expect(accounts!.providers(2)).toEqual({});
    expect(accounts!.env).toEqual({});
    expect(accounts!.scrub.slice().sort()).toEqual(["GO_A_KEY", "GO_B_KEY"]);
  });

  it("gives an unknown session only the account of the model it runs", async () => {
    const accounts = await staged(configWith([link("go-b/alpha")]), "no-such-session", "go-a/alpha");
    expect(Object.keys(accounts!.providers(1))).toEqual(["go-a"]);
    expect(Object.keys(accounts!.env)).toEqual(["GO_A_KEY"]);
  });

  it("follows a chain change: adding an account to the chain adds its key and changes the fingerprint", async () => {
    const session = sessions.createSession({ engine: "claude", source: "web", sourceRef: "web:reader-change", model: "opus", employee: "a-worker" });
    const before = await staged(configWith([link("go-a/alpha")]), session.id);
    const after = await staged(configWith([link("go-a/alpha"), link("go-b/alpha")]), session.id);
    expect(Object.keys(after!.env).sort()).toEqual(["GO_A_KEY", "GO_B_KEY"]);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
  });
});
