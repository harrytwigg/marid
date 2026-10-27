import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/**
 * Starting a session on a declared Claude account: `engine: "claude:<name>"` on POST /api/sessions and
 * POST /api/delegations, previewed by GET /api/fallback-preview, refused where the choice cannot hold
 * (an undeclared name, a remote employee, a department-scoped caller) and never changeable afterwards.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-primary-profile-api-"));
process.env.JINN_HOME = home;
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } =
  await import("../../mcp/identity.js");
const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("./department-fixtures.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let workItems: typeof import("../../work-items/store.js");
let refreshOrg: typeof import("../org-registry.js").refreshOrg;

const FRIEND = path.join(os.tmpdir(), "primary-api-friend");
const SPARE = path.join(os.tmpdir(), "primary-api-spare");
const friend = claudeProfileFromDir(FRIEND);
const spare = claudeProfileFromDir(SPARE);

const engineStub = { name: "stub", run: () => new Promise(() => {}), isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: {
      bin: "claude", model: "opus", fallback: ["codex"],
      accounts: { friend: { configDir: FRIEND, fallback: [] }, spare: { configDir: SPARE, fallback: ["claude:friend", "codex"] } },
    },
    codex: { bin: "codex", model: "gpt-5.6-sol" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/jinn" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as JinnConfig;

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map([["claude", engineStub], ["codex", engineStub]]),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function call(method: string, url: string, body?: unknown, callerSessionId?: string): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const identity: Record<string, string> = callerSessionId
    ? {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: callerSessionId,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
      }
    : {};
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json", ...identity },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

const spawn = (body: Record<string, unknown>, caller?: string) => call("POST", "/api/sessions", { prompt: "brief", ...body }, caller);
const delegate = (body: Record<string, unknown>, caller?: string) =>
  call("POST", "/api/delegations", { employee: "plain-dev", task: "A brief with acceptance.", ...body }, caller);

beforeAll(async () => {
  const dbModule = await import("../../shared/db.js");
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  ({ refreshOrg } = await import("../org-registry.js"));
  dbModule.initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  writeEmployeeFile("platform", "far-dev", { department: "platform", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

beforeEach(() => {
  fs.rmSync(HEALTH_PATH, { force: true });
});

const scopedCaller = () => registry.createSession({ engine: "claude", source: "web", sourceRef: `web:scoped-${Math.random()}`, employee: "lab-dev" }).id;
const agentCaller = () => registry.createSession({ engine: "claude", source: "web", sourceRef: `web:agent-${Math.random()}`, employee: "plain-dev" }).id;
const todoCount = () => workItems.listWorkItems({}).length;

describe("POST /api/sessions", () => {
  it("starts the session on the declared profile and says so on the wire", async () => {
    const created = await spawn({ employee: "plain-dev", engine: "claude:friend" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ engine: "claude", claudeProfile: { name: "friend", key: `claude:${friend.key}` } });
    expect(registry.getSession(created.body.id)!.claudeConfigDir).toBe(friend.dir);
  });

  it("starts an employee-less session on the declared profile too", async () => {
    const created = await spawn({ engine: "claude:spare" });
    expect(created.status).toBe(201);
    expect(created.body.claudeProfile).toEqual({ name: "spare", key: `claude:${spare.key}` });
  });

  it("is a named target: the session stays on the profile when the default account is out of allowance", async () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({ claude: { state: "exhausted", until: reset, recheckAt: reset, reason: "spent" } }));
    const created = await spawn({ employee: "plain-dev", engine: "claude:friend" });
    expect(created.status).toBe(201);
    const session = registry.getSession(created.body.id)!;
    expect(session.engine).toBe("claude");
    expect(session.transportMeta?.engineOverride).toBeUndefined();
  });

  it("changes nothing when no profile is named", async () => {
    const created = await spawn({ employee: "plain-dev", engine: "claude" });
    expect(created.status).toBe(201);
    expect(created.body.claudeProfile).toBeNull();
    expect(registry.getSession(created.body.id)!.claudeConfigDir).toBeNull();
    const bare = await spawn({ employee: "plain-dev" });
    expect(bare.body.claudeProfile).toBeNull();
  });

  it("refuses an undeclared profile with a 400 that lists the declared ones", async () => {
    const before = registry.listSessions().length;
    const refused = await spawn({ employee: "plain-dev", engine: "claude:nobody" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/unknown Claude profile "nobody".*declared profiles: friend, spare/);
    expect(registry.listSessions().length).toBe(before);
  });

  it("refuses a remote employee with a 400", async () => {
    const refused = await spawn({ employee: "far-dev", engine: "claude:friend" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/remote host/);
  });

  it("refuses a department-scoped caller with a 403, and still lets it start a plain session", async () => {
    const caller = scopedCaller();
    const refused = await spawn({ employee: "lab-dev", engine: "claude:friend" }, caller);
    expect(refused.status).toBe(403);
    expect(refused.body.error).not.toMatch(/friend/);
    const plain = await spawn({ employee: "lab-dev", engine: "claude" }, caller);
    expect(plain.status).toBe(201);
  });

  it("lets only the operator start a member of a scoped department on another profile", async () => {
    const before = registry.listSessions().length;
    const refused = await spawn({ employee: "lab-dev", engine: "claude:friend" }, agentCaller());
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/department-scoped "lab".*only the operator/);
    expect(registry.listSessions().length).toBe(before + 1);
    const operator = await spawn({ employee: "lab-dev", engine: "claude:friend" });
    expect(operator.status).toBe(201);
    expect(registry.getSession(operator.body.id)!.claudeConfigDir).toBe(friend.dir);
    const agentPlain = await spawn({ employee: "plain-dev", engine: "claude:friend" }, agentCaller());
    expect(agentPlain.status).toBe(201);
  });
});

describe("POST /api/delegations", () => {
  it("starts the delegate on the declared profile", async () => {
    const created = await delegate({ engine: "claude:friend" });
    expect(created.status).toBe(201);
    expect(created.body.engine).toBe("claude");
    expect(registry.getSession(created.body.sessionId)!.claudeConfigDir).toBe(friend.dir);
  });

  it("refuses an undeclared profile with a 400, before minting a Todo", async () => {
    const before = todoCount();
    const refused = await delegate({ engine: "claude:nobody" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/declared profiles: friend, spare/);
    expect(todoCount()).toBe(before);
  });

  it("refuses a remote employee with a 400, before minting a Todo", async () => {
    const before = todoCount();
    const refused = await delegate({ employee: "far-dev", engine: "claude:friend" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/remote host/);
    expect(todoCount()).toBe(before);
  });

  it("refuses a department-scoped caller with a 403, before minting a Todo", async () => {
    const before = todoCount();
    const refused = await delegate({ employee: "lab-dev", engine: "claude:friend" }, scopedCaller());
    expect(refused.status).toBe(403);
    expect(todoCount()).toBe(before);
  });

  it("refuses an agent putting a member of a scoped department on another profile, before minting a Todo", async () => {
    const before = todoCount();
    const refused = await delegate({ employee: "lab-dev", engine: "claude:friend" }, agentCaller());
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/only the operator/);
    expect(todoCount()).toBe(before);
  });

  it("treats a profile mismatch on a reused live session as it treats an engine mismatch: the session keeps what it has, and the answer says so", async () => {
    const item = workItems.createWorkItem({ title: "Reuse", source: "human", status: "backlog", assignee: "plain-dev", department: "platform" });
    const first = await delegate({ workItemId: item.id, engine: "claude" });
    expect(first.status).toBe(201);
    const again = await delegate({ workItemId: item.id, engine: "claude:friend" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, sessionId: first.body.sessionId, claudeProfile: null, selectionIgnored: { claudeProfile: "claude:friend" } });
    expect(JSON.stringify(again.body)).not.toContain(FRIEND);
    expect(registry.getSession(first.body.sessionId)!.claudeConfigDir).toBeNull();
  });
});

describe("PATCH /api/sessions/:id", () => {
  it("refuses to change the profile afterwards, with a 400 that says why", async () => {
    const created = await spawn({ employee: "plain-dev", engine: "claude:friend" });
    const patched = await call("PATCH", `/api/sessions/${created.body.id}`, { engine: "claude:spare" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(/chosen when a session is created/);
    expect(registry.getSession(created.body.id)).toMatchObject({ engine: "claude", claudeConfigDir: friend.dir });
  });
});

describe("GET /api/fallback-preview", () => {
  it("previews the declared profile's own chain", async () => {
    const preview = await call("GET", "/api/fallback-preview?engine=claude:spare");
    expect(preview.status).toBe(200);
    expect(preview.body.fallback.chain.links.map((link: { account: string }) => link.account)).toEqual([`claude:${spare.key}`, `claude:${friend.key}`, "codex"]);
  });

  it("previews the default account's chain for a bare engine, as before", async () => {
    const preview = await call("GET", "/api/fallback-preview?engine=claude");
    expect(preview.body.fallback.chain.links.map((link: { account: string }) => link.account)).toEqual(["claude", "codex"]);
  });

  it("refuses an undeclared profile with a 400", async () => {
    const preview = await call("GET", "/api/fallback-preview?engine=claude:nobody");
    expect(preview.status).toBe(400);
    expect(preview.body.error).toMatch(/unknown Claude profile/);
  });
});

describe("a session's wire after its profile is no longer declared", () => {
  it("keeps the key and drops the name", async () => {
    const created = await spawn({ employee: "plain-dev", engine: "claude:friend" });
    const accounts = (config.engines.claude as { accounts: Record<string, unknown> }).accounts;
    const kept = accounts.friend;
    delete accounts.friend;
    try {
      const read = await call("GET", `/api/sessions/${created.body.id}`);
      expect(read.body.claudeProfile).toEqual({ name: null, key: `claude:${friend.key}` });
    } finally {
      accounts.friend = kept;
    }
  });
});
