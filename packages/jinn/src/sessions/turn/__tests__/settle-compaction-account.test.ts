import { describe, expect, it, vi } from "vitest";

/**
 * A /compact that hits a usage limit during an account swap was refused by the
 * substitute account, so the limit is recorded there, not on the employee's own
 * account (FR-055, FR-079).
 */

const recorded = vi.hoisted(() => [] as string[]);
vi.mock("../../rate-limit-account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../rate-limit-account.js")>()),
  recordAccountRateLimit: (account: string) => { recorded.push(account); },
}));
vi.mock("../completion.js", () => ({ settleTurn: vi.fn(async () => undefined) }));

const { settleRateLimitedCompaction } = await import("../settle.js");

describe("a rate-limited /compact during an account swap", () => {
  it("records the limit on the substitute account that refused it", async () => {
    const run = {
      input: {
        session: { id: "s-1", transportMeta: { engineOverride: { substituteAccount: "claude:0a1b2c3d", substituteConfigDir: "/Users/o/.claude-friend" } } },
        employee: { name: "op", engine: "claude" },
        attemptToken: "t",
      },
      plan: { engineName: "claude" },
      surface: { notice: vi.fn(async () => undefined) },
      terminalFields: () => ({}),
    };
    await settleRateLimitedCompaction(run as never, undefined);
    expect(recorded).toEqual(["claude:0a1b2c3d"]);
  });
});
