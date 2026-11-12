import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, Engine, EngineRunOpts, IncomingMessage, JinnConfig, Target } from "../../shared/types.js";

/**
 * The operator's switch of a chat's Claude profile (and engine): `PUT|PATCH /api/sessions/:id`
 * with `profile`. Every row of the contract: status and body keys, the notice and the
 * events, what the next turn runs on and is told, and what a pending session switch becomes.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-profile-switch-"));
process.env.JINN_HOME = home;
// Outside the instance home, which the redirected temp dir sits in.
const OUTSIDE = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const FRIEND = path.join(OUTSIDE, "profile-switch-friend");
// The gateway's own Claude profile, where an own-login session's transcript is looked for.
const OWN_CONFIG = fs.mkdtempSync(path.join(OUTSIDE, "profile-switch-own-"));
process.env.CLAUDE_CONFIG_DIR = OWN_CONFIG;
fs.writeFileSync(path.join(OWN_CONFIG, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test", refreshToken: "test", expiresAt: 4_102_444_800_000 } }));
const SPARE = path.join(OUTSIDE, "profile-switch-spare");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));

const { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } =
  await import("../../mcp/identity.js");
const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("./department-fixtures.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let managerModule: typeof import("../../sessions/manager.js");
const friend = claudeProfileFromDir(FRIEND);

const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: process.execPath, model: "opus", accounts: { friend: { configDir: FRIEND }, spare: { configDir: SPARE } } },
    codex: { bin: process.execPath, model: "gpt-5.5" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/jinn" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  sessions: {},
  mcp: {},
  portal: { setupComplete: true },
} as unknown as JinnConfig;

type Emitted = [string, Record<string, unknown>];
let emitted: Emitted[] = [];
let transportState: "idle" | "queued" | "running" = "idle";

function stubContext(): import("../api.js").ApiContext {
  return {
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: (event: string, payload: Record<string, unknown>) => { emitted.push([event, payload]); },
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
        getTransportState: (_key: string, status: string) => (transportState === "idle" ? status : transportState),
      }),
      getEngines: () => new Map(),
    },
  } as unknown as import("../api.js").ApiContext;
}

async function call(method: string, url: string, body?: unknown, opts: { context?: import("../api.js").ApiContext; caller?: string } = {}) {
  let status = 200;
  let raw = "";
  const identity: Record<string, string> = opts.caller
    ? {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: opts.caller,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(opts.caller),
      }
    : {};
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json", ...identity },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, opts.context ?? stubContext());
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

const patch = (id: string, body: unknown, opts?: Parameters<typeof call>[3]) => call("PATCH", `/api/sessions/${id}`, body, opts);

function makeSession(over: Partial<Parameters<typeof registry.createSession>[0]> = {}) {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `web:s-${Math.random()}`, model: "opus", employee: "plain-dev", ...over });
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  managerModule = await import("../../sessions/manager.js");
  const { refreshOrg } = await import("../org-registry.js");
  (await import("../../shared/db.js")).initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  writeEmployeeFile("platform", "far-dev", { department: "platform", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg(config);
}, 60_000);

beforeEach(async () => {
  emitted = [];
  transportState = "idle";
  (await import("../../shared/db.js")).initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("PATCH /api/sessions/:id with a profile", () => {
  it("applies it: 200, the session carries the new profile, and the row is where a turn will read it", async () => {
    const s = makeSession();

    const res = await patch(s.id, { profile: "friend" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: s.id, engine: "claude", model: "opus", status: "idle", lastError: null,
      claudeProfile: { name: "friend", key: `claude:${friend.key}` },
    });
    expect(registry.getSession(s.id)!.claudeConfigDir).toBe(friend.dir);
  });

  it("answers PUT the same way", async () => {
    const s = makeSession();
    const res = await call("PUT", `/api/sessions/${s.id}`, { profile: "friend" });
    expect(res.status).toBe(200);
    expect(res.body.claudeProfile.name).toBe("friend");
  });

  it("goes back to the own login with null, and the response says so", async () => {
    const s = makeSession({ claudeConfigDir: friend.dir });

    const res = await patch(s.id, { profile: null });

    expect(res.status).toBe(200);
    expect(res.body.claudeProfile).toBeNull();
    expect(registry.getSession(s.id)!.claudeConfigDir).toBeNull();
  });

  it("applies a profile and an engine together, keeping the title and model in the same request", async () => {
    const s = makeSession();
    const res = await patch(s.id, { engine: "claude", profile: "spare", title: "Moved", model: "sonnet" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Moved", model: "sonnet", claudeProfile: { name: "spare" } });
  });

  it("refuses a profile with a non-claude engine: 400, and nothing moves", async () => {
    const s = makeSession();
    const res = await patch(s.id, { engine: "codex", profile: "friend" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "profile applies only to the claude engine" });
    expect(registry.getSession(s.id)).toMatchObject({ engine: "claude", claudeConfigDir: null });
  });

  it("refuses an unknown profile and lists the declared ones: 400", async () => {
    const s = makeSession();
    const res = await patch(s.id, { profile: "nobody" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown Claude profile "nobody" — declared profiles: friend, spare' });
    expect(registry.getSession(s.id)!.claudeConfigDir).toBeNull();
  });

  it("refuses a malformed profile: 400", async () => {
    const res = await patch(makeSession().id, { profile: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profile must be a string/);
  });

  it("refuses a remote employee's session a local profile: 400, with the reason", async () => {
    const s = makeSession({ employee: "far-dev" });
    const res = await patch(s.id, { profile: "friend" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/runs on a remote host and uses that host's Claude login/);
    expect(registry.getSession(s.id)!.claudeConfigDir).toBeNull();
  });

  it("lets a department-scoped session change profile, and keeps it on claude", async () => {
    const s = makeSession({ employee: "lab-dev" });
    const moved = await patch(s.id, { profile: "friend" });
    expect(moved.status).toBe(200);
    expect(moved.body.claudeProfile.name).toBe("friend");

    const refused = await patch(s.id, { engine: "codex" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/run only on the claude engine/);
    expect(registry.getSession(s.id)!.engine).toBe("claude");
  });

  it.each(["running", "queued"] as const)("refuses while a turn is %s: 400, and nothing moves", async (state) => {
    const s = makeSession();
    transportState = state;

    const res = await patch(s.id, { profile: "friend" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot switch engine or profile while a turn is running, waiting, or queued" });
    expect(registry.getSession(s.id)!.claudeConfigDir).toBeNull();
    expect(emitted).toEqual([]);
  });

  it("still lets a running turn's model change through: that is not a switch", async () => {
    const s = makeSession();
    transportState = "running";
    const res = await patch(s.id, { model: "sonnet" });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("sonnet");
  });

  it("keeps refusing an engine spelled as a profile, and says where the profile goes", async () => {
    const s = makeSession();
    const res = await patch(s.id, { engine: "claude:friend" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/names a Claude profile.*send "profile"/);
    expect(registry.getSession(s.id)!.claudeConfigDir).toBeNull();
  });

  it("takes the operator's model/effort path when the profile is the one it is already on", async () => {
    const s = makeSession();

    const res = await patch(s.id, { profile: "", model: "sonnet" });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("sonnet");
    expect(registry.getSession(s.id)!.transportMeta?.lastSwitch).toBeUndefined();
    expect(registry.getMessages(s.id).filter((m) => m.role === "notification")).toEqual([]);
  });

  it("is for the operator only: a session caller cannot move another session", async () => {
    const s = makeSession();
    const caller = makeSession({ employee: "plain-dev" });

    const res = await patch(s.id, { profile: "friend" }, { caller: caller.id });

    expect(res.status).toBe(403);
    expect(registry.getSession(s.id)!.claudeConfigDir).toBeNull();
  });
});

describe("the left conversation's transcript path", () => {
  /** A Claude transcript for `thread` under `profileDir`, as Claude Code writes it. */
  function writeTranscript(profileDir: string, thread: string): string {
    const dir = path.join(profileDir, "projects", "-some-cwd");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${thread}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    return file;
  }
  const leftOf = (id: string) => (registry.getSession(id)!.transportMeta?.lastSwitch as Record<string, unknown>).leftTranscript;

  it("is recorded for an unscoped session, from the profile it was on", async () => {
    const s = makeSession({ claudeConfigDir: friend.dir });
    registry.recordEngineSessionId(s.id, "claude", "friend-thread");
    const file = writeTranscript(FRIEND, "friend-thread");

    const res = await patch(s.id, { profile: "spare" });

    expect(res.status).toBe(200);
    expect(leftOf(s.id)).toBe(file);
  });

  it("is recorded for an own-login session's switch to another engine", async () => {
    const s = makeSession();
    registry.recordEngineSessionId(s.id, "claude", "own-thread");
    const file = writeTranscript(OWN_CONFIG, "own-thread");

    await patch(s.id, { engine: "codex" });

    expect(leftOf(s.id)).toBe(file);
  });

  it("is left out for a department-scoped session, which reads the history through the tool only", async () => {
    const s = makeSession({ employee: "lab-dev", claudeConfigDir: friend.dir });
    registry.recordEngineSessionId(s.id, "claude", "scoped-thread");
    writeTranscript(FRIEND, "scoped-thread");

    const res = await patch(s.id, { profile: "spare" });

    expect(res.status).toBe(200);
    expect(leftOf(s.id)).toBeUndefined();
  });

  it("is left out for a remote employee's session, whose conversation is not on this machine", async () => {
    const s = makeSession({ employee: "far-dev" });
    registry.recordEngineSessionId(s.id, "claude", "remote-thread");
    writeTranscript(OWN_CONFIG, "remote-thread");

    const res = await patch(s.id, { engine: "codex" });

    expect(res.status).toBe(200);
    expect(leftOf(s.id)).toBeUndefined();
  });

  it("is left out when the session had no Claude conversation to leave", async () => {
    const s = makeSession();
    await patch(s.id, { profile: "friend" });
    expect(leftOf(s.id)).toBeUndefined();
  });
});

describe("what a switch leaves behind", () => {
  it("records the switch and a notice that says the operator changed it, and announces both", async () => {
    const s = makeSession();

    await patch(s.id, { profile: "friend" });

    const last = registry.getSession(s.id)!.transportMeta?.lastSwitch as Record<string, any>;
    expect(last).toMatchObject({
      by: "operator", applied: true, carryOver: "transcript-pointer",
      from: { engine: "claude", profile: null, claudeConfigDir: null },
      to: { engine: "claude", profile: "friend", claudeConfigDir: friend.dir },
    });
    const notices = registry.getMessages(s.id).filter((m) => m.role === "notification");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toMatch(/^🔀 Switched from Claude · own login · Opus.* to Claude · friend · Opus.* \(changed by the operator\)$/);
    expect(notices[0].meta?.sessionSwitch).toEqual(last);
    const events = emitted.map(([name]) => name);
    expect(events).toContain("session:updated");
    expect(events).toContain("session:notification");
    expect(emitted.find(([name]) => name === "session:notification")![1]).toMatchObject({ sessionId: s.id, message: notices[0].content });
  });

  it("clears a pending session switch: the operator's choice wins", async () => {
    const s = makeSession();
    registry.updateSession(s.id, { transportMeta: { pendingSwitch: { claimedAt: 1, conversation: "new" } } } as never);

    await patch(s.id, { profile: "friend" });

    expect(registry.getSession(s.id)!.transportMeta?.pendingSwitch).toBeUndefined();
  });

  it("writes no notice and no record when the request is refused", async () => {
    const s = makeSession();
    await patch(s.id, { profile: "nobody" });
    expect(registry.getMessages(s.id)).toEqual([]);
    expect(registry.getSession(s.id)!.transportMeta?.lastSwitch).toBeUndefined();
  });
});

function connectorStub(): Connector {
  const target: Target = { channel: "test" };
  return {
    name: "test", id: "test", start: async () => {}, stop: async () => {},
    getCapabilities: () => ({ threading: false, messageEdits: false, reactions: false, attachments: false }),
    getHealth: () => ({ status: "running", capabilities: { threading: false, messageEdits: false, reactions: false, attachments: false } }),
    reconstructTarget: () => target, sendMessage: async () => undefined, replyMessage: async () => undefined,
    addReaction: async () => {}, removeReaction: async () => {}, editMessage: async () => {}, onMessage: () => {},
  };
}

function incoming(text: string): IncomingMessage {
  return {
    connector: "test", source: "test", sessionKey: "test:profile-switch", replyContext: {}, channel: "channel-a",
    user: "operator", userId: "operator", text, attachments: [], raw: {},
  };
}

describe("the turn after a switch", () => {
  it("runs on the new profile with a pointer to the history, and never the earlier messages' text", async () => {
    const runs: EngineRunOpts[] = [];
    const engine: Engine = { name: "claude", run: async (opts) => { runs.push(opts); return { sessionId: `claude-native-${runs.length}`, result: "answer-text-one" }; } };
    const manager = new managerModule.SessionManager(config, new Map([["claude", engine]]), "boot-a" as never);
    const connector = connectorStub();

    await manager.route(incoming("first question about turnips"), connector);
    const session = registry.getSessionBySessionKey("test:profile-switch")!;
    expect(runs[0].claudeProfile ?? null).toBeNull();

    const moved = await patch(session.id, { profile: "friend" }, { context: { ...stubContext(), sessionManager: manager } as never });
    expect(moved.status).toBe(200);

    await manager.route(incoming("second question"), connector);
    const second = runs[1];
    expect(second.claudeProfile?.dir).toBe(friend.dir);
    expect(second.resumeSessionId).toBeUndefined();
    expect(second.prompt).toContain("read_session");
    expect(second.prompt).toContain(session.id);
    expect(second.prompt).toContain("second question");
    expect(second.prompt).not.toContain("turnips");
    expect(second.prompt).not.toContain("answer-text-one");
    expect(second.prompt).not.toMatch(/^We switched engines/);
  });

  it("returns to the parked conversation on the own login, with a pointer from then", async () => {
    const runs: EngineRunOpts[] = [];
    const engine: Engine = { name: "claude", run: async (opts) => { runs.push(opts); return { sessionId: `claude-native-${runs.length}`, result: "ok" }; } };
    const manager = new managerModule.SessionManager(config, new Map([["claude", engine]]), "boot-a" as never);
    const connector = connectorStub();
    const context = { ...stubContext(), sessionManager: manager } as never;

    await manager.route(incoming("hello"), connector);
    const session = registry.getSessionBySessionKey("test:profile-switch")!;
    await patch(session.id, { profile: "friend" }, { context });
    await manager.route(incoming("on friend"), connector);
    await patch(session.id, { profile: null }, { context });
    await manager.route(incoming("back home"), connector);

    const back = runs[2];
    expect(back.claudeProfile ?? null).toBeNull();
    expect(back.resumeSessionId).toBe("claude-native-1");
    expect(back.prompt).toContain("read_session");
    expect(back.prompt).toContain("back home");
    expect(back.prompt).not.toContain("on friend");
  });

  it("points to the history for an engine switch too, which no longer pastes it", async () => {
    const runs: EngineRunOpts[] = [];
    const codex: Engine = { name: "codex", run: async (opts) => { runs.push(opts); return { sessionId: "codex-native", result: "ok" }; } };
    const claude: Engine = { name: "claude", run: async () => ({ sessionId: "claude-native", result: "ok" }) };
    const manager = new managerModule.SessionManager(config, new Map<string, Engine>([["claude", claude], ["codex", codex]]), "boot-a" as never);
    const connector = connectorStub();

    await manager.route(incoming("hello there"), connector);
    const session = registry.getSessionBySessionKey("test:profile-switch")!;
    await patch(session.id, { engine: "codex" }, { context: { ...stubContext(), sessionManager: manager } as never });
    await manager.route(incoming("now on codex"), connector);

    expect(runs[0].prompt).toContain("read_session");
    expect(runs[0].prompt).not.toContain("hello there");
  });
});
