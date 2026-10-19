import { describe, expect, it } from "vitest";
import { resolveAccountFallback } from "../account-fallback.js";
import { claudeProfileFromDir } from "../claude-profile.js";
import { resolveFallbackEngine } from "../engine-fallback.js";
import { expandFallbackChain } from "../fallback-chain-expand.js";
import { linkAccount } from "../fallback-chain.js";
import { claudeAccountKey } from "../engine-account.js";
import { declaredClaudeAccounts } from "../claude-accounts-config.js";
import { sessionFallbackChain } from "../fallback-chain.js";
import { makeSession } from "../../sessions/__tests__/helpers/session-fixture.js";
import type { JinnConfig, ModelRegistry } from "../types.js";

/**
 * A chain written only in the legacy strings must come out of the expansion in the
 * order the old walkers visited it: `resolveAccountFallback` for a local Claude
 * subject, `resolveFallbackEngine` for every other. The walkers are recorded by
 * an `isUsable` that rejects everything, so the order of its calls is the visit order.
 */

const FRIEND = "/srv/operator/.claude-friend";
const WORK2 = "/srv/operator/.claude-work2";
const friendKey = `claude:${claudeProfileFromDir(FRIEND).key}`;
const work2Key = `claude:${claudeProfileFromDir(WORK2).key}`;
const ACCOUNTS = { friend: { configDir: FRIEND, fallback: ["claude:work2", "opencode"] }, work2: { configDir: WORK2, fallback: ["claude", "codex"] } };

function config(engines: Record<string, unknown>): JinnConfig {
  return { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" }, ...engines } } as unknown as JinnConfig;
}

/** Each case is the `engines` mapping beside `claude` and `codex` defaults, so a case only names what it sets. */
const CASES: Array<[name: string, engines: Record<string, unknown>]> = [
  ["a flat chain", { claude: { fallback: ["codex", "opencode"] } }],
  ["breadth first: a target's own chain comes after its siblings", { claude: { fallback: ["codex", "grok"] }, codex: { fallback: ["opencode"] }, grok: { fallback: ["pi"] } }],
  ["a target reachable twice is visited once", { claude: { fallback: ["codex", "opencode"] }, codex: { fallback: ["opencode", "grok"] } }],
  ["a two-engine cycle", { claude: { fallback: ["codex"] }, codex: { fallback: ["claude"] } }],
  ["a longer cycle that returns to the start", { claude: { fallback: ["codex"] }, codex: { fallback: ["opencode"] }, opencode: { fallback: ["grok", "claude", "codex"] }, grok: { fallback: ["pi"] } }],
  ["the subject named deep in another chain", { claude: { fallback: ["codex"] }, codex: { fallback: ["claude", "hermes"] } }],
  ["an empty chain", { claude: { fallback: [] } }],
  ["no chain at all", {}],
  ["declared accounts, each with a chain", { claude: { fallback: ["claude:friend", "codex"], accounts: ACCOUNTS } }],
  ["an account entry naming no declared account is dropped", { claude: { fallback: ["claude:ghost", "codex"], accounts: ACCOUNTS } }],
  ["accounts that name each other and the default account", { claude: { fallback: ["claude:work2"], accounts: { ...ACCOUNTS, work2: { configDir: WORK2, fallback: ["claude:friend", "claude", "codex"] } } } }],
];

/** The subjects a case is asked about: every local Claude account, and every other engine. */
function accountSubjects(engines: Record<string, unknown>): Array<{ from: string; chain: string[] }> {
  const claude = engines.claude as { fallback?: string[]; accounts?: typeof ACCOUNTS } | undefined;
  return [
    { from: "claude", chain: claude?.fallback ?? [] },
    ...Object.values(claude?.accounts ?? {}).map((account, index) => ({ from: [friendKey, work2Key][index]!, chain: account.fallback ?? [] })),
  ];
}

function oldAccountOrder(c: JinnConfig, from: string): string[] {
  const seen: string[] = [];
  resolveAccountFallback(c, from, (target) => { seen.push(target.account); return false; });
  return seen;
}

function oldEngineOrder(c: JinnConfig, from: string): string[] {
  const seen: string[] = [];
  resolveFallbackEngine(c, from, (engine) => { seen.push(engine); return false; });
  return seen;
}

describe("legacy expansion visits targets in the old walkers' order", () => {
  it.each(CASES)("local Claude subjects, account walk: %s", (_name, engines) => {
    const c = config(engines);
    for (const { from, chain } of accountSubjects(engines)) {
      const expanded = expandFallbackChain(c, chain, { mode: "account", selfAccount: from }).map(({ link }) => linkAccount(link, c));
      expect(expanded, `from ${from}`).toEqual(oldAccountOrder(c, from));
    }
  });

  it.each(CASES)("every other subject, engine walk: %s", (_name, engines) => {
    const c = config(engines);
    for (const from of ["claude", "codex", "opencode", "grok", "pi", "hermes"]) {
      const chain = (c.engines as unknown as Record<string, { fallback?: string[] } | undefined>)[from]?.fallback ?? [];
      // A remote Claude subject keeps an account entry as a link it can never use; the engine walker never saw it.
      const expanded = expandFallbackChain(c, chain, { mode: "engine", selfAccount: from }).filter(({ link }) => link.profile === undefined).map(({ link }) => link.engine);
      expect(expanded, `from ${from}`).toEqual(oldEngineOrder(c, from));
    }
  });

  it("really is breadth first, so the parity above is not vacuous", () => {
    const c = config({ claude: { fallback: ["codex", "grok"] }, codex: { fallback: ["opencode"] }, grok: { fallback: ["pi"] } });
    expect(oldAccountOrder(c, "claude")).toEqual(["codex", "grok", "opencode", "pi"]);
    expect(expandFallbackChain(c, ["codex", "grok"], { mode: "account", selfAccount: "claude" }).map(({ link }) => link.engine)).toEqual(["codex", "grok", "opencode", "pi"]);
  });

  it("marks the written entries config and what their own chains brought in legacy", () => {
    const c = config({ claude: { fallback: ["codex", "grok"] }, codex: { fallback: ["opencode"] } });
    const out = expandFallbackChain(c, ["codex", "grok"], { mode: "engine", selfAccount: "claude" });
    expect(out.map(({ link, origin }) => `${link.engine}:${origin}`)).toEqual(["codex:config", "grok:config", "opencode:legacy"]);
  });

  it("keeps an object entry as one target and lists an exact repeat once", () => {
    const c = config({ codex: { fallback: ["claude"] } });
    const out = expandFallbackChain(c, [{ engine: "codex", model: "gpt-mini" }, "codex", { engine: "codex", model: "gpt-mini" }], { mode: "engine", selfAccount: "claude" });
    // The object is the codex target on gpt-mini and brings no chain; the string is codex itself, which then brings codex's chain.
    expect(out.map(({ link }) => `${link.engine}/${link.model ?? ""}`)).toEqual(["codex/gpt-mini", "codex/"]);
  });
});

describe("a legacy-only config through the whole resolver", () => {
  const registry = Object.fromEntries(["claude", "codex", "opencode", "grok", "pi", "hermes"].map((name) => [name, { name, available: true, defaultModel: "", effortMechanism: "none", models: [] }])) as unknown as ModelRegistry;

  it.each(CASES)("a default-account Claude session's links are the old account walk, in order: %s", (_name, engines) => {
    const c = config(engines);
    const { links } = sessionFallbackChain({ config: c, session: makeSession({ model: "opus" }), registry, health: {} });
    expect(links.slice(1).map((link) => link.account)).toEqual(oldAccountOrder(c, "claude"));
  });

  it("keeps string entries as strings in both chains, and reads them back as declared", () => {
    const c = config({ claude: { fallback: ["claude:friend", "codex"], accounts: ACCOUNTS } });
    expect((c.engines.claude as { fallback?: unknown }).fallback).toEqual(["claude:friend", "codex"]);
    expect(declaredClaudeAccounts(c).map((account) => [account.name, account.fallback, account.key === claudeAccountKey(account.profile)])).toEqual([
      ["friend", ["claude:work2", "opencode"], true], ["work2", ["claude", "codex"], true],
    ]);
  });
});
