import { describe, expect, it } from "vitest";
import { accountHasChain, resolveAccountFallback, resolveHealthyAccountFallback } from "../account-fallback.js";
import { chainEntryAccount, declaredClaudeAccounts, validateClaudeAccounts, claudeChainAccountProblems } from "../claude-accounts-config.js";
import { claudeProfileFromDir } from "../claude-profile.js";
import { validateEngineFallbackChains } from "../engine-fallback.js";
import { resolveClaudeConfigDir } from "../home.js";
import type { JinnConfig } from "../types.js";

/**
 * Per-account fallback chains (FR-079): `engines.claude.accounts.<name>`, each a
 * local profile with its own chain, walked on the existing mechanism as if each
 * account were its own Claude installation.
 */

const FRIEND = "/Users/operator/.claude-friend";
const WORK2 = "/Users/operator/.claude-work2";
const friendKey = `claude:${claudeProfileFromDir(FRIEND).key}`;
const work2Key = `claude:${claudeProfileFromDir(WORK2).key}`;
const yes = () => true;

function config(claude: Record<string, unknown>): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", ...claude },
      codex: { bin: "codex", model: "gpt", fallback: [] },
    },
  } as unknown as JinnConfig;
}

describe("declared accounts resolve to account keys", () => {
  it("keys a declared name on its canonical directory, so a rename keeps every store's key", () => {
    const before = declaredClaudeAccounts(config({ accounts: { friend: { configDir: FRIEND } } }));
    const after = declaredClaudeAccounts(config({ accounts: { pal: { configDir: `${FRIEND}/` } } }));
    expect(before[0]!.key).toBe(friendKey);
    expect(after[0]!.key).toBe(friendKey);
  });

  it("reads `claude` as the default account and `claude:<name>` as a declared one", () => {
    const c = config({ accounts: { friend: { configDir: FRIEND } } });
    expect(chainEntryAccount(c, "claude")).toBe("claude");
    expect(chainEntryAccount(c, "claude:friend")).toBe(friendKey);
    expect(chainEntryAccount(c, "claude:nobody")).toBeUndefined();
    expect(chainEntryAccount(c, "codex")).toBe("codex");
  });
});

describe("validation", () => {
  const engines = (claude: Record<string, unknown>) => config(claude).engines as unknown as Record<string, unknown>;

  it("accepts a well-formed set, cycles included", () => {
    expect(validateClaudeAccounts(engines({
      fallback: ["claude:friend", "codex"],
      accounts: {
        friend: { configDir: FRIEND, fallback: ["claude:work2"] },
        work2: { configDir: WORK2, fallback: ["claude:friend", "claude", "codex"] },
      },
    }), "/tmp/jinn-home")).toEqual([]);
    expect(validateEngineFallbackChains(engines({ fallback: ["claude:friend", "codex"] }))).toEqual([]);
  });

  it("refuses two accounts on one canonical directory", () => {
    const problems = validateClaudeAccounts(engines({ accounts: { a: { configDir: FRIEND }, b: { configDir: `${FRIEND}/` } } }), "/tmp/jinn-home");
    expect(problems.join("\n")).toMatch(/already account a's/);
  });

  it("refuses the default profile's directory, a relative path and one inside the instance home", () => {
    const problems = validateClaudeAccounts(engines({ accounts: {
      mine: { configDir: resolveClaudeConfigDir() },
      rel: { configDir: "~/.claude-x" },
      inside: { configDir: "/tmp/jinn-home/profiles/x" },
    } }), "/tmp/jinn-home").join("\n");
    expect(problems).toMatch(/mine: configDir .* is the gateway's own Claude profile/);
    expect(problems).toMatch(/rel: configDir "~\/.claude-x" must be an absolute path/);
    expect(problems).toMatch(/inside: configDir .* lies inside the instance home/);
  });

  it("refuses unknown names and an account naming itself", () => {
    const problems = validateClaudeAccounts(engines({ accounts: {
      friend: { configDir: FRIEND, fallback: ["claude:friend", "claude:ghost", "gemini"] },
    } }), "/tmp/jinn-home").join("\n");
    expect(problems).toMatch(/must not name claude:friend itself/);
    expect(problems).toMatch(/"claude:ghost" names no account/);
    expect(problems).toMatch(/"gemini" is not a known engine/);
    expect(claudeChainAccountProblems(engines({ fallback: ["claude:ghost"] }))).toEqual([
      'engines.claude.fallback[0] "claude:ghost" names no account under engines.claude.accounts',
    ]);
  });
});

describe("walking an account's chain", () => {
  const c = config({
    fallback: ["codex"],
    accounts: {
      friend: { configDir: FRIEND, fallback: [] },
      work2: { configDir: WORK2, fallback: ["claude", "codex"] },
      quiet: { configDir: "/Users/operator/.claude-quiet" },
    },
  });

  it("a declared account with fallback: [] has nothing to move to", () => {
    expect(resolveAccountFallback(c, friendKey, yes)).toBeNull();
  });

  it("[claude, codex] moves to the default account", () => {
    expect(resolveHealthyAccountFallback(c, work2Key, yes, {})).toEqual({ engine: "claude", account: "claude" });
  });

  it("[claude, codex] moves to codex when the default account is exhausted", () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const health = { claude: { state: "exhausted" as const, until, recheckAt: until } };
    expect(resolveHealthyAccountFallback(c, work2Key, yes, health)).toEqual({ engine: "codex", account: "codex" });
  });

  it("the default account keeps engines.claude.fallback", () => {
    expect(resolveAccountFallback(c, "claude", yes)).toEqual({ engine: "codex", account: "codex" });
  });

  it("the default account's chain may name a declared account", () => {
    const d = config({ fallback: ["claude:friend", "codex"], accounts: { friend: { configDir: FRIEND } } });
    expect(resolveAccountFallback(d, "claude", yes)).toEqual({ engine: "claude", account: friendKey });
  });

  it("only account entries apply when engines are ruled out (a Claude-layout session)", () => {
    expect(resolveAccountFallback(c, work2Key, (t) => t.account !== "claude", { accountsOnly: true })).toBeNull();
    expect(resolveAccountFallback(c, work2Key, yes, { accountsOnly: true })).toEqual({ engine: "claude", account: "claude" });
  });

  it("an undeclared named profile has no chain; a declared one without fallback has an empty one", () => {
    expect(accountHasChain(c, "claude:0badc0de")).toBe(false);
    expect(accountHasChain(c, "claude")).toBe(true);
    expect(resolveAccountFallback(c, `claude:${claudeProfileFromDir("/Users/operator/.claude-quiet").key}`, yes)).toBeNull();
  });
});
