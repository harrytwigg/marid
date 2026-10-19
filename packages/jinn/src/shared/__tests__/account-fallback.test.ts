import { describe, expect, it } from "vitest";
import { chainEntryAccount, declaredClaudeAccounts, validateClaudeAccounts } from "../claude-accounts-config.js";
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
    const set = engines({
      fallback: ["claude:friend", "codex"],
      accounts: {
        friend: { configDir: FRIEND, fallback: ["claude:work2"] },
        work2: { configDir: WORK2, fallback: ["claude:friend", "claude", "codex"] },
      },
    });
    expect(validateClaudeAccounts(set, "/tmp/jinn-home")).toEqual([]);
    expect(validateEngineFallbackChains(set)).toEqual([]);
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
    expect(problems).toMatch(/fallback\[0\] \(claude · friend\) is the target this chain falls back from/);
    expect(problems).toMatch(/profile "ghost" names no account/);
    expect(problems).toMatch(/"gemini" is not a known engine/);
    expect(validateEngineFallbackChains(engines({ fallback: ["claude:ghost"] }))).toEqual([
      'engines.claude.fallback[0]: profile "ghost" names no account under engines.claude.accounts',
    ]);
  });
});
