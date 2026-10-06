/**
 * Live limits per local Claude account (FR-071, FR-073, FR-078).
 *
 * Each named profile is read the way the default one is, with its own token:
 * its suffixed Keychain entry or its own `.credentials.json`, never
 * `$CLAUDE_CODE_OAUTH_TOKEN` (the default account's). The token is used for
 * the one usage call and never reaches a log, a file or a child environment,
 * and nothing refreshes it. With one account the response is exactly as
 * before: no `accounts` key at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Employee, EngineLimitsResponse, JinnConfig } from "../types.js";

const childEnvs: Array<Record<string, string | undefined>> = [];
const keychainServices: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((cmd: string, args: string[], opts: unknown, cb?: (...a: unknown[]) => void) => {
    const callback = (typeof opts === "function" ? opts : cb) as (...a: unknown[]) => void;
    const options = (typeof opts === "object" && opts ? opts : {}) as { env?: Record<string, string | undefined> };
    if (cmd === "security") {
      keychainServices.push(args[args.indexOf("-s") + 1]!);
      callback(new Error("The specified item could not be found in the keychain."), "", "");
      return undefined as never;
    }
    childEnvs.push(options.env ?? {});
    callback(null, JSON.stringify({ subscriptionType: options.env?.CLAUDE_CONFIG_DIR ? "max-friend" : "max" }), "");
    return undefined as never;
  }) as typeof real.execFile;
  return { ...real, execFile };
});

const SECRET = "sk-ant-oat01-FRIEND-ACCESS-SECRET";
const REFRESH = "sk-ant-ort01-FRIEND-REFRESH-SECRET";
const ENV_TOKEN = "sk-ant-oat01-DEFAULT-ENV";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

let ROOT: string;
let PROFILE_DIR: string;
let friendKey: string;
let mod: {
  collectEngineLimits: (c: JinnConfig, o?: { engine?: string }) => Promise<EngineLimitsResponse>;
  registerAccountRoster: (source: () => Iterable<Employee>) => void;
  invalidateModelRegistry: () => void;
  recordEngineUnavailable: (engine: string, reason: string, resetsAt?: number) => void;
  claudeSnapshotFile: (dir: string, account?: string) => string | null;
  registerSessionAccountResolver: (r: ((id: string) => string | undefined) | undefined) => void;
};
const fetchCalls: Array<{ url: string; auth: string }> = [];

const cfg = (): JinnConfig => ({
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: process.execPath, model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low"] }] } },
  connectors: {},
}) as unknown as JinnConfig;

const usage = (percent: number) => ({ limits: [{ kind: "session", percent, resets_at: "2099-01-01T00:00:00Z" }] });

function writeCredentials(expiresAt: number): void {
  fs.writeFileSync(path.join(PROFILE_DIR, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: SECRET, refreshToken: REFRESH, expiresAt, refreshTokenExpiresAt: Date.now() + 86_400_000 },
  }));
}

function everyFile(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? everyFile(full) : [full];
  });
}

beforeAll(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-account-limits-"));
  PROFILE_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-friend-profile-")), ".claude-friend");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "tmp", "engine-limits", "claude"), { recursive: true });
  process.env.JINN_HOME = ROOT;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ENV_TOKEN;
  delete process.env.JINN_CLAUDE_USAGE_API;
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
    fetchCalls.push({ url, auth: init.headers.Authorization });
    return { ok: true, json: async () => usage(init.headers.Authorization === `Bearer ${SECRET}` ? 71 : 12) } as unknown as Response;
  });
  const profile = await import("../claude-profile.js");
  friendKey = `claude:${profile.claudeProfileFromDir(PROFILE_DIR).key}`;
  mod = {
    ...(await import("../engine-limits.js")),
    ...(await import("../engine-limits-accounts.js")),
    ...(await import("../models.js")),
    ...(await import("../engine-health.js")),
    ...(await import("../engine-limits-claude.js")),
    ...(await import("../engine-account.js")),
  } as typeof mod;
});

afterAll(() => {
  delete process.env.JINN_HOME;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  vi.unstubAllGlobals();
  mod.registerAccountRoster(() => []);
});

beforeEach(() => {
  fetchCalls.length = 0;
  childEnvs.length = 0;
  keychainServices.length = 0;
  writeCredentials(Date.now() + 3600_000);
  fs.rmSync(path.join(ROOT, "tmp", "engine-health.json"), { force: true });
  mod.invalidateModelRegistry();
});

const operator = { name: "op", engine: "claude" } as Employee;
const sideDev = () => ({ name: "side-dev", engine: "claude", claudeConfigDir: PROFILE_DIR }) as Employee;

describe("one Claude account (FR-078)", () => {
  it("answers exactly as before: no accounts key", async () => {
    mod.registerAccountRoster(() => [operator]);
    const res = await mod.collectEngineLimits(cfg(), { engine: "claude" });
    expect(Object.keys(res)).toEqual(["generatedAt", "default", "engines"]);
  });
});

describe("two local Claude accounts (FR-071, FR-073)", () => {
  it("reads each with its own token and lists both, the default first", async () => {
    mod.registerAccountRoster(() => [operator, sideDev()]);
    const res = await mod.collectEngineLimits(cfg(), { engine: "claude" });

    expect(res.engines.claude.windows?.[0]?.usedPercent).toBe(12);
    const [first, second] = res.accounts!.claude!;
    expect(first).toMatchObject({ account: "claude", label: "claude", employees: ["op"], location: { kind: "local" } });
    expect(first!.windows).toEqual(res.engines.claude.windows);
    expect(second).toMatchObject({ account: friendKey, label: ".claude-friend", employees: ["side-dev"], status: "live", accountPlan: "max-friend" });
    expect(second!.windows?.[0]?.usedPercent).toBe(71);
    expect(second!.noReading).toBeUndefined();
  });

  it("skips $CLAUDE_CODE_OAUTH_TOKEN for the named account and reads its own login", async () => {
    mod.registerAccountRoster(() => [operator, sideDev()]);
    await mod.collectEngineLimits(cfg(), { engine: "claude" });
    expect(fetchCalls.map((call) => call.auth).sort()).toEqual([`Bearer ${ENV_TOKEN}`, `Bearer ${SECRET}`].sort());
    if (process.platform === "darwin") {
      expect(keychainServices).toContain(`Claude Code-credentials-${friendKey.slice("claude:".length)}`);
    }
  });

  it("never refreshes a token, and the token reaches no file, child environment or log", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
    mod.registerAccountRoster(() => [operator, sideDev()]);
    await mod.collectEngineLimits(cfg(), { engine: "claude" });
    spies.forEach((spy) => spy.mockRestore());

    expect(fetchCalls.every((call) => call.url === USAGE_URL)).toBe(true);
    expect(fs.readFileSync(path.join(PROFILE_DIR, ".credentials.json"), "utf-8")).toContain(REFRESH);
    for (const file of everyFile(ROOT)) expect(fs.readFileSync(file, "utf-8")).not.toContain(SECRET);
    expect(JSON.stringify(childEnvs)).not.toContain(SECRET);
    expect(childEnvs.some((env) => env.CLAUDE_CONFIG_DIR === PROFILE_DIR)).toBe(true);
    expect(logged.join("\n")).not.toContain(SECRET);
    // Each account keeps its own history; the default keeps today's file.
    const histories = fs.readdirSync(path.join(ROOT, "tmp", "engine-limits")).filter((name) => name.startsWith("claude-usage-history"));
    expect(histories.sort()).toEqual(["claude-usage-history.json", `claude-usage-history.${encodeURIComponent(friendKey)}.json`].sort());
  });

  it("shows an account with an expired token as having no live reading", async () => {
    writeCredentials(Date.now() - 60_000);
    mod.registerAccountRoster(() => [operator, sideDev()]);
    const res = await mod.collectEngineLimits(cfg(), { engine: "claude" });
    expect(res.accounts!.claude![1]).toMatchObject({ account: friendKey, noReading: true });
    expect(fetchCalls).toHaveLength(1);
  });

  it("marks an account recorded at its limit", async () => {
    const until = Math.floor(Date.now() / 1000) + 3600;
    mod.recordEngineUnavailable(friendKey, "usage limit", until);
    mod.registerAccountRoster(() => [operator, sideDev()]);
    const res = await mod.collectEngineLimits(cfg(), { engine: "claude" });
    expect(res.accounts!.claude![1]!.exhausted).toEqual({ until: new Date(until * 1000).toISOString() });
    expect(res.accounts!.claude![0]!.exhausted).toBeUndefined();
  });
});

describe("status-line snapshots are read per account", () => {
  it("takes only the account's own sessions' snapshots", () => {
    const dir = path.join(ROOT, "tmp", "engine-limits", "claude");
    const write = (id: string) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 4_000_000_000 } } }));
    write("operator-session");
    write("friend-session");
    mod.registerSessionAccountResolver((id) => (id === "friend-session" ? friendKey : "claude"));
    try {
      expect(path.basename(mod.claudeSnapshotFile(dir, friendKey)!)).toBe("friend-session.json");
      expect(path.basename(mod.claudeSnapshotFile(dir)!)).toBe("operator-session.json");
    } finally {
      mod.registerSessionAccountResolver(undefined);
      fs.rmSync(path.join(dir, "operator-session.json"));
      fs.rmSync(path.join(dir, "friend-session.json"));
    }
  });
});
