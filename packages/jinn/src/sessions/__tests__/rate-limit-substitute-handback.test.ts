import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import type { ClaudeProfile } from "../../shared/claude-profile.js";
import type { TurnReceipt, TurnSurface } from "../turn/types.js";

/**
 * A session moved onto a substitute Claude account goes back to its own account
 * at the override's `until`. When the substitute is then limited with nothing
 * left in its chain, the wait used to sleep to the SUBSTITUTE's reset — days,
 * for a weekly limit — although the session's own account reopened at `until`.
 * A delegated child has nobody to send the message that would unpark it, so its
 * Todo stalled. The wait now ends at `until`, and the turn re-runs on the
 * session's own account, resuming its own thread with the sync transcript.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
// The login gates read this machine's real Claude state; neither is under test.
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));
vi.mock("../claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: () => {},
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-substitute-handback-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { beginEngineSubstitution } = await import("../engine-override.js");
const { currentClaudeAccount } = await import("../session-account.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const friend = claudeProfileFromDir("/Users/operator/.claude-friend");
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const third = claudeProfileFromDir("/Users/operator/.claude-third");
const THIRD_ACCOUNT = `claude:${third.key}`;

// No account is declared, so the third account has no chain to walk: Branch B.
const config = { gateway: {}, engines: { default: "claude", claude: { model: "opus" } }, sessions: {} } as unknown as JinnConfig;

interface Call { prompt: string; resumeSessionId?: string; claudeProfile: ClaudeProfile | undefined }

function claudeEngine(behaviour: (call: number) => EngineResult) {
  const calls: Call[] = [];
  const engine: Engine = {
    name: "claude",
    async run(opts: EngineRunOpts) {
      calls.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, claudeProfile: opts.claudeProfile });
      return behaviour(calls.length);
    },
  };
  return { engine, calls };
}

function recordingSurface() {
  const seen = { notices: [] as string[], receipts: [] as TurnReceipt[] };
  const surface: TurnSurface = {
    started: async () => {},
    delta: () => {},
    notice: async (text) => { seen.notices.push(text); },
    reply: async () => {},
    waiting: async () => {},
    settled: async (receipt) => { seen.receipts.push(receipt); },
  };
  return { surface, seen };
}

function swap(id: string, accounts: { original: string; substitute: string; substituteConfigDir: string | null }, until: Date, syncSince: string) {
  reg.updateSession(id, { status: "running", attemptToken: "swap-attempt" } as never);
  beginEngineSubstitution({
    session: reg.getSession(id)!, attemptToken: "swap-attempt", config, employee: undefined, substitute: "claude", accounts,
    until, syncSince, lastError: "limit",
  });
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("a nested account swap whose substitute hits its weekly limit", () => {
  it("resumes on the session's own account at the override's until, not at the substitute's reset", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:handback", model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "a-thread");
    const syncSince = new Date(Date.now() - 60_000).toISOString();
    const until = new Date(Date.now() + 1_500);
    // Own account → friend (the window is this swap's), then friend → third.
    swap(s.id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, until, syncSince);
    reg.recordEngineSessionId(s.id, "claude", "b-thread");
    reg.insertMessage(s.id, "user", "draft the release notes");
    reg.insertMessage(s.id, "assistant", "drafted on the friend account");
    swap(s.id, { original: FRIEND_ACCOUNT, substitute: THIRD_ACCOUNT, substituteConfigDir: third.dir }, new Date(Date.now() + 5 * 3600_000), syncSince);
    reg.recordEngineSessionId(s.id, "claude", "c-thread");
    reg.updateSession(s.id, { status: "idle" } as never);

    // The third account is out for five days; the own account answers.
    const weeklyReset = Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
    const { engine, calls } = claudeEngine((call) => call === 1
      ? { sessionId: "c-thread", result: "", error: "You've hit your weekly limit", rateLimit: { status: "rejected", resetsAt: weeklyReset } }
      : { sessionId: "a-thread", result: "done on the own account" });
    const { surface, seen } = recordingSurface();

    reg.insertMessage(s.id, "user", "now publish them");
    const started = reg.beginSessionAttempt(s.id)!;
    await runTurn({
      session: reg.getSession(s.id)!,
      attemptToken: started.attemptToken!,
      prompt: "now publish them",
      attachments: [],
      config,
      engines: new Map([["claude", engine]]),
      gatewayBootId: "test-boot",
      connectorNames: [],
      channel: "web",
      user: "operator",
    }, surface);

    expect(Date.now()).toBeGreaterThanOrEqual(until.getTime());
    expect(calls).toHaveLength(2);
    // The limited turn ran on the third account's thread and profile.
    expect(calls[0]!.resumeSessionId).toBe("c-thread");
    expect(calls[0]!.claudeProfile).toEqual(third);
    // The re-run is on the own account and thread, carrying what it missed.
    expect(calls[1]!.resumeSessionId).toBe("a-thread");
    expect(calls[1]!.claudeProfile).toBeNull();
    expect(calls[1]!.prompt).toMatch(/^We temporarily ran this session on another Claude account due to a usage limit\./);
    expect(calls[1]!.prompt).toContain("ASSISTANT: drafted on the friend account");
    expect(calls[1]!.prompt).toContain("USER: now publish them");

    const after = reg.getSession(s.id)!;
    expect(after.status).toBe("idle");
    expect(currentClaudeAccount(after)).toBe("claude");
    expect((after.transportMeta as Record<string, unknown> | null)?.engineOverride).toBeUndefined();
    expect(after.engineSessions?.claude?.id).toBe("a-thread");
    expect(after.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("b-thread");
    expect(after.engineSessions?.[THIRD_ACCOUNT]?.id).toBe("c-thread");
    expect(seen.receipts).toHaveLength(1);
    expect(seen.receipts[0]!.result).toBe("done on the own account");
    expect(reg.getMessages(s.id).at(-1)).toMatchObject({ role: "assistant", content: "done on the own account" });
  }, 15_000);
});
