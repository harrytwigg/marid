import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { TurnReceipt, TurnSurface } from "../turn/types.js";

/**
 * A session moved onto another Claude account runs there in a warm PTY spawned
 * on that account's profile. When the override ends — a new message after
 * `until`, or a wait on the substitute's limit reaching `until` — the session is
 * back on its own account, and its next turn must spawn on its own profile and
 * resume its own thread. The interactive engine used to reuse the warm PTY
 * whatever profile the turn asked for, so that turn was pasted into the
 * substitute account's live conversation instead.
 *
 * End to end: the real registry, the real turn code and the real interactive
 * engine, driven by hook events over a fake PTY.
 */

interface FakePty { env: Record<string, string>; args: string[]; writes: string[] }
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[], options: { env: Record<string, string> }) => {
    const record: FakePty = { env: options.env, args, writes: [] };
    ptys.push(record);
    return {
      pid: 8100 + ptys.length, _exitCode: null, onData() {}, onExit() {}, kill() {},
      write(data: string) { record.writes.push(data); }, resize() {}, on() {},
    };
  }),
}));
vi.mock("../../engines/sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41500; }
    stop() {}
  },
}));
// The substitute is out for five days: a weekly limit.
vi.mock("../../shared/engine-reset-times.js", () => ({
  claudeResetsAtSeconds: async () => Math.floor(Date.now() / 1000) + 5 * 24 * 3600,
}));
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-account-revert-pty-")));
process.env.JINN_HOME = path.join(tmp, "home");
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { beginEngineSubstitution, maybeRevertEngineOverride } = await import("../engine-override.js");
const { InteractiveClaudeEngine } = await import("../../engines/claude-interactive.js");
const { PtyLifecycleManager } = await import("../../engines/pty-lifecycle.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { cleanupSessionSettings } = await import("../../shared/claude-settings.js");
const { CLAUDE_SETTINGS_DIR } = await import("../../shared/paths.js");

const DEFAULT_DIR = path.join(tmp, "default-claude");
const friend = claudeProfileFromDir(path.join(tmp, "friend"));
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const third = claudeProfileFromDir(path.join(tmp, "third"));
const THIRD_ACCOUNT = `claude:${third.key}`;
const config = { gateway: {}, engines: { default: "claude", claude: { model: "opus" } }, sessions: {} } as unknown as JinnConfig;

const flush = () => new Promise((r) => setTimeout(r, 30));
const hooks = new Map<string, (payload: Record<string, unknown>) => void>();
const hook = (sessionId: string, payload: Record<string, unknown>) => hooks.get(sessionId)!(payload);

let lifecycle: InstanceType<typeof PtyLifecycleManager>;
let engine: InstanceType<typeof InteractiveClaudeEngine>;
const sessionIds: string[] = [];

function surface(): { surface: TurnSurface; receipts: TurnReceipt[] } {
  const receipts: TurnReceipt[] = [];
  return {
    receipts,
    surface: {
      started: async () => {}, delta: () => {}, notice: async () => {}, reply: async () => {}, waiting: async () => {},
      settled: async (receipt) => { receipts.push(receipt); },
    },
  };
}

function startTurn(sessionId: string, prompt: string, on: TurnSurface): Promise<void> {
  reg.insertMessage(sessionId, "user", prompt);
  const started = reg.beginSessionAttempt(sessionId)!;
  return runTurn({
    session: reg.getSession(sessionId)!, attemptToken: started.attemptToken!, prompt, attachments: [], config,
    engines: new Map([["claude", engine]]), gatewayBootId: "test-boot", connectorNames: [], channel: "web", user: "operator",
  }, on);
}

function swap(id: string, accounts: { original: string; substitute: string; substituteConfigDir: string | null }, until: Date) {
  reg.updateSession(id, { status: "running", attemptToken: "swap-attempt" } as never);
  beginEngineSubstitution({
    session: reg.getSession(id)!, attemptToken: "swap-attempt", config, employee: undefined, substitute: "claude", accounts,
    until, syncSince: new Date(Date.now() - 60_000).toISOString(), lastError: "limit",
  });
  reg.updateSession(id, { status: "idle" } as never);
}

function newSession(ref: string): string {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: ref, model: "opus" });
  sessionIds.push(s.id);
  reg.recordEngineSessionId(s.id, "claude", "a-thread");
  return s.id;
}

const resumeOf = (pty: FakePty) => pty.args[pty.args.indexOf("--resume") + 1];

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await flush();
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  ptys.length = 0;
  hooks.clear();
  for (const dir of [DEFAULT_DIR, friend.dir, third.dir]) fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv("CLAUDE_CONFIG_DIR", DEFAULT_DIR);
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
  engine = new InteractiveClaudeEngine(lifecycle, {
    register: (id: string, cb: (payload: Record<string, unknown>) => void) => { hooks.set(id, cb); },
    unregister: () => {},
  } as never);
});

afterEach(() => {
  lifecycle.killAll();
  for (const id of sessionIds.splice(0)) cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
  vi.unstubAllEnvs();
});

describe("a session back on its own Claude account after a swap", () => {
  it("a new message after until spawns on the own profile instead of pasting into the substitute's PTY", async () => {
    const id = newSession("web:revert-pty");
    swap(id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, new Date(Date.now() + 3600_000));

    // A turn inside the window runs on the friend account and leaves its PTY warm.
    const first = surface();
    const onFriend = startTurn(id, "draft the notes", first.surface);
    await flush();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.env.CLAUDE_CONFIG_DIR).toBe(friend.dir);
    hook(id, { hook_event_name: "SessionStart", session_id: "b-thread" });
    hook(id, { hook_event_name: "Stop", last_assistant_message: "drafted on the friend account" });
    await onFriend;
    expect(first.receipts).toHaveLength(1);

    // `until` passes; the next message reverts the override at turn start, as route() does.
    const meta = reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>;
    reg.updateSession(id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never });
    maybeRevertEngineOverride(reg.getSession(id)!);

    const second = surface();
    const onOwn = startTurn(id, "now publish them", second.surface);
    await flush();
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.env.CLAUDE_CONFIG_DIR).toBe(DEFAULT_DIR);
    expect(resumeOf(ptys[1]!)).toBe("a-thread");
    expect(ptys[0]!.writes.join("")).not.toContain("publish");
    hook(id, { hook_event_name: "SessionStart", session_id: "a-thread" });
    hook(id, { hook_event_name: "Stop", last_assistant_message: "published on the own account" });
    await onOwn;
    expect(second.receipts[0]?.result).toBe("published on the own account");
  });

  it("a wait on a weekly-limited substitute hands back at until and spawns on the own profile", async () => {
    const id = newSession("web:handback-pty");
    const handBackAt = new Date(Date.now() + 1_500);
    swap(id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, handBackAt);
    reg.recordEngineSessionId(id, "claude", "b-thread");
    swap(id, { original: FRIEND_ACCOUNT, substitute: THIRD_ACCOUNT, substituteConfigDir: third.dir }, new Date(Date.now() + 5 * 3600_000));
    reg.recordEngineSessionId(id, "claude", "c-thread");

    const seen = surface();
    const turn = startTurn(id, "now publish them", seen.surface);
    await flush();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.env.CLAUDE_CONFIG_DIR).toBe(third.dir);
    hook(id, { hook_event_name: "SessionStart", session_id: "c-thread" });
    hook(id, { hook_event_name: "StopFailure", error: "rate_limit" });

    // Nothing in the third account's chain: the turn waits, then is handed back at `until`.
    await until(() => ptys.length > 1, 6_000);
    expect(Date.now()).toBeGreaterThanOrEqual(handBackAt.getTime());
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.env.CLAUDE_CONFIG_DIR).toBe(DEFAULT_DIR);
    expect(resumeOf(ptys[1]!)).toBe("a-thread");
    expect(ptys[0]!.writes.join("")).not.toContain("another Claude account");
    hook(id, { hook_event_name: "SessionStart", session_id: "a-thread" });
    hook(id, { hook_event_name: "Stop", last_assistant_message: "published on the own account" });
    await turn;
    expect(seen.receipts).toHaveLength(1);
    expect(seen.receipts[0]?.result).toBe("published on the own account");
    expect(reg.getSession(id)!.status).toBe("idle");
  }, 15_000);
});
