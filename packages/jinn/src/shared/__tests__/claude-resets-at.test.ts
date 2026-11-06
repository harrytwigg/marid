import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `claudeResetsAtSeconds` is awaited while a turn is settling, so what it does
 * when its sources are absent, stale, switched off, or broken matters as much as
 * what it returns when they answer. The OAuth token reader is the only seam it
 * needs mocking at; everything else is a real file on a temp home.
 */
const readClaudeOAuthToken = vi.fn<() => Promise<string | undefined>>();
vi.mock("../claude-models.js", () => ({ readClaudeOAuthToken: () => readClaudeOAuthToken() }));

let claudeResetsAtSeconds: (nowMs?: number) => Promise<number | undefined>;
let TEST_ROOT: string;
let CLAUDE_DIR: string;

const NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");
const FUTURE = Math.floor(Date.parse("2026-08-19T17:00:00.000Z") / 1000);
const PAST = Math.floor(Date.parse("2026-08-19T07:00:00.000Z") / 1000);

function usageResponse(resetsAtIso: string): Response {
  return {
    ok: true,
    json: async () => ({ limits: [{ kind: "session", percent: 100, resets_at: resetsAtIso }] }),
  } as Response;
}

function writeSnapshot(resetsAt: number): void {
  fs.writeFileSync(
    path.join(CLAUDE_DIR, "statusline.json"),
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 100, resets_at: resetsAt } } }),
  );
}

beforeAll(async () => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-claude-reset-"));
  CLAUDE_DIR = path.join(TEST_ROOT, "home", "tmp", "engine-limits", "claude");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  process.env.JINN_HOME = path.join(TEST_ROOT, "home"); // frozen into paths.ts at the import below
  ({ claudeResetsAtSeconds } = await import("../engine-reset-times.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  delete process.env.JINN_CLAUDE_USAGE_API;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, file));
  delete process.env.JINN_CLAUDE_USAGE_API;
  readClaudeOAuthToken.mockReset();
  readClaudeOAuthToken.mockResolvedValue("oauth-token");
  vi.unstubAllGlobals();
});

describe("claudeResetsAtSeconds", () => {
  it("reads the session window's reset from the usage API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => usageResponse("2026-08-19T17:00:00.000Z")));
    expect(await claudeResetsAtSeconds(NOW_MS)).toBe(FUTURE);
  });

  it("falls back to the on-disk snapshot when the API has nothing", async () => {
    readClaudeOAuthToken.mockResolvedValue(undefined);
    writeSnapshot(FUTURE);
    expect(await claudeResetsAtSeconds(NOW_MS)).toBe(FUTURE);
  });

  it("states nothing when no source has a reading", async () => {
    readClaudeOAuthToken.mockResolvedValue(undefined);
    expect(await claudeResetsAtSeconds(NOW_MS)).toBeUndefined();
  });

  it("discards a reset that has already passed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => usageResponse("2026-08-19T07:00:00.000Z")));
    writeSnapshot(PAST);
    expect(await claudeResetsAtSeconds(NOW_MS)).toBeUndefined();
  });

  it("stays off the API when JINN_CLAUDE_USAGE_API is off", async () => {
    process.env.JINN_CLAUDE_USAGE_API = "off";
    const fetchSpy = vi.fn(async () => usageResponse("2026-08-19T17:00:00.000Z"));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await claudeResetsAtSeconds(NOW_MS)).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves rather than throwing when the token reader blows up", async () => {
    readClaudeOAuthToken.mockRejectedValue(new Error("keychain locked"));
    await expect(claudeResetsAtSeconds(NOW_MS)).resolves.toBeUndefined();
  });

  it("resolves rather than hanging when the API times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }));
    await expect(claudeResetsAtSeconds(NOW_MS)).resolves.toBeUndefined();
  });

  it("still reaches the snapshot after the API throws", async () => {
    readClaudeOAuthToken.mockRejectedValue(new Error("keychain locked"));
    writeSnapshot(FUTURE);
    expect(await claudeResetsAtSeconds(NOW_MS)).toBe(FUTURE);
  });

  describe("a five-hour bucket the account does not have", () => {
    function zeroSessionResponse(): Response {
      return {
        ok: true,
        json: async () => ({
          limits: [
            { kind: "session", percent: 0, resets_at: "2026-08-19T17:00:00.000Z" },
            { kind: "weekly_all", percent: 40, resets_at: "2026-08-24T12:00:00.000Z" },
          ],
        }),
      } as Response;
    }

    function writeAccountSnapshot(rateLimits: Record<string, unknown>, ageMs: number): void {
      const file = path.join(CLAUDE_DIR, "statusline.json");
      fs.writeFileSync(file, JSON.stringify({ rate_limits: rateLimits }));
      const at = new Date(NOW_MS - ageMs);
      fs.utimesSync(file, at, at);
    }

    const weeklyOnly = { seven_day: { used_percentage: 40, resets_at: FUTURE + 5 * 86_400 } };

    it("gives no reset when a recent snapshot sees only a weekly limit", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => zeroSessionResponse()));
      writeAccountSnapshot(weeklyOnly, 10 * 60_000);
      expect(await claudeResetsAtSeconds(NOW_MS)).toBeUndefined();
    });

    it("keeps the reset when the snapshot carries a five-hour window", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => zeroSessionResponse()));
      writeAccountSnapshot({ ...weeklyOnly, five_hour: { used_percentage: 0, resets_at: FUTURE } }, 10 * 60_000);
      expect(await claudeResetsAtSeconds(NOW_MS)).toBe(FUTURE);
    });

    it("keeps the reset when the weekly-only snapshot is older than five hours", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => zeroSessionResponse()));
      writeAccountSnapshot(weeklyOnly, 6 * 60 * 60_000);
      expect(await claudeResetsAtSeconds(NOW_MS)).toBe(FUTURE);
    });
  });
});
