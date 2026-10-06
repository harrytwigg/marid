import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A remote Claude account's reading (FR-072). This instance has no remote
 * host, so the SSH side is a fake: the token script itself is run here, under
 * this machine's Node, against a temporary profile standing in for the host's.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-account-"));
process.env.JINN_HOME = tmp;
const { REMOTE_TOKEN_SCRIPT, accessTokenFromScriptOutput, readRemoteAccountUsage } = await import("../remote-account-usage.js");
const { clearAccountReadings, lastAccountReading } = await import("../../shared/account-readings.js");
const { claudeResetsAtSeconds } = await import("../../shared/engine-reset-times.js");

const ACCESS = "sk-ant-oat01-REMOTE-ACCESS";
const REFRESH = "sk-ant-ort01-REMOTE-REFRESH";
const ACCOUNT = { key: "claude@ops@studio", label: "ops@studio", location: { kind: "remote" as const, host: "studio" }, profile: null, remote: { destination: "ops@studio", configDir: "/home/ops/.claude-work" }, employees: ["hound"] };
const facts = { home: "/home/ops", stageDir: "/home/ops/.jinn-remote", nodeBin: "/usr/bin/node", claudeBin: "/usr/local/bin/claude", jinnVersion: "0.34.0", entryDir: "/x" };

function profileWith(expiresAt: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-profile-"));
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt, refreshTokenExpiresAt: Date.now() + 86_400_000, scopes: ["user:inference"] },
  }));
  return dir;
}

/** Run the script exactly as the host would: on stdin, profile path as argv. */
function runScript(dir: string): string {
  return execFileSync(process.execPath, ["-", dir], { input: REMOTE_TOKEN_SCRIPT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir() } });
}

beforeEach(() => clearAccountReadings());

describe("the token script, run on the host", () => {
  it("prints only the access token and its expiry: the refresh token never leaves", { timeout: 30_000 }, () => {
    const expiresAt = Date.now() + 3600_000;
    const out = runScript(profileWith(expiresAt));
    expect(JSON.parse(out)).toEqual({ accessToken: ACCESS, expiresAt });
    expect(out).not.toContain(REFRESH);
    expect(out).not.toContain("refresh");
  });

  it("prints {} for a profile with no login", { timeout: 30_000 }, () => {
    expect(runScript(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-empty-")))).toBe("{}");
  });

  // These spawn node, which a loaded full-suite run can slow well past the default timeout.
  it("takes the profile path as an argument, so a hostile path is data, not script", { timeout: 30_000 }, () => {
    const evil = path.join(os.tmpdir(), "x\"; require('fs').writeFileSync('/tmp/pwned-remote-account','1'); \"");
    expect(runScript(evil)).toBe("{}");
    expect(fs.existsSync("/tmp/pwned-remote-account")).toBe(false);
  });
});

describe("the gateway's side of the reading", () => {
  const usage = { limits: [{ kind: "session", percent: 64, resets_at: "2099-01-01T00:00:00Z" }] };

  function deps(over: Partial<Parameters<typeof readRemoteAccountUsage>[1] & object> = {}) {
    const run = vi.fn(async (_dest: string, args: string[], opts?: { stdin?: string }) => {
      if (opts?.stdin) return { code: 0, stdout: JSON.stringify({ accessToken: ACCESS, expiresAt: Date.now() + 3600_000 }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ subscriptionType: "max" }), stderr: args.join(" ") };
    });
    return {
      probe: vi.fn(async () => true),
      facts: vi.fn(async () => facts),
      run,
      fetchUsage: vi.fn(async () => usage),
      now: () => Date.now(),
      ...over,
    };
  }

  it("reads a reachable host: plan under the account's CLAUDE_CONFIG_DIR, the token used once and kept nowhere", async () => {
    const d = deps();
    const { snapshot, reachable } = await readRemoteAccountUsage(ACCOUNT, d);
    expect(reachable).toBe(true);
    expect(snapshot).toMatchObject({ status: "live", accountPlan: "max" });
    expect(snapshot.windows?.[0]?.usedPercent).toBe(64);
    expect(d.fetchUsage).toHaveBeenCalledWith(ACCESS);
    const commands = (d.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[1] as string[]).join(" "));
    expect(commands).toContain(`CLAUDE_CONFIG_DIR='/home/ops/.claude-work' '/usr/local/bin/claude' auth status`);
    expect(commands).toContain(`'/usr/bin/node' - '/home/ops/.claude-work'`);
    expect(JSON.stringify(lastAccountReading(ACCOUNT.key))).not.toContain(ACCESS);
    for (const file of fs.readdirSync(tmp, { recursive: true }) as string[]) {
      const full = path.join(tmp, file);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, "utf-8")).not.toContain(ACCESS);
    }
  });

  it("never wakes a host: one probe, no facts, no commands, and the last reading with its age", async () => {
    await readRemoteAccountUsage(ACCOUNT, deps());
    const asleep = deps({ probe: vi.fn(async () => false) });
    const { snapshot, reachable } = await readRemoteAccountUsage(ACCOUNT, asleep);
    expect(reachable).toBe(false);
    expect(asleep.probe).toHaveBeenCalledTimes(1);
    expect(asleep.facts).not.toHaveBeenCalled();
    expect(asleep.run).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({ status: "live", stale: true });
    expect(snapshot.refreshedAt).toBe(lastAccountReading(ACCOUNT.key)!.snapshot.refreshedAt);
  });

  it("a host never read and asleep shows no reading", async () => {
    const { snapshot, reachable } = await readRemoteAccountUsage(ACCOUNT, deps({ probe: vi.fn(async () => false) }));
    expect(reachable).toBe(false);
    expect(snapshot.windows ?? []).toEqual([]);
  });

  it("an expired remote token is no reading, and is never refreshed", async () => {
    const d = deps({
      run: vi.fn(async (_d: string, _a: string[], opts?: { stdin?: string }) => opts?.stdin
        ? { code: 0, stdout: JSON.stringify({ accessToken: ACCESS, expiresAt: Date.now() - 1000 }), stderr: "" }
        : { code: 1, stdout: "", stderr: "" }),
    });
    const { snapshot } = await readRemoteAccountUsage(ACCOUNT, d);
    expect(d.fetchUsage).not.toHaveBeenCalled();
    expect(snapshot.status).toBe("static");
    expect(accessTokenFromScriptOutput(JSON.stringify({ accessToken: ACCESS, expiresAt: 1 }), Date.now())).toBeUndefined();
  });

  it("answers a remote account's backoff reset from its last reading", async () => {
    await readRemoteAccountUsage(ACCOUNT, deps());
    expect(await claudeResetsAtSeconds(Date.now(), { remoteAccount: ACCOUNT.key })).toBe(Date.parse("2099-01-01T00:00:00Z") / 1000);
    expect(await claudeResetsAtSeconds(Date.now(), { remoteAccount: "claude@nobody" })).toBeUndefined();
  });
});

const { cachedRemoteAccountReader, clearRemoteAccountReaderCache } = await import("../remote-account-usage.js");

describe("the cached reader the Limits page uses", () => {
  const live = { name: "claude", available: true, status: "live" as const, source: "t", refreshedAt: new Date().toISOString(), models: [] };

  it("never makes a request wait on a slow host beyond its budget, and serves the reading once it lands", async () => {
    clearRemoteAccountReaderCache();
    let finish!: (r: { snapshot: typeof live; reachable: boolean }) => void;
    const read = vi.fn(() => new Promise<{ snapshot: typeof live; reachable: boolean }>((resolve) => { finish = resolve; }));
    const reader = cachedRemoteAccountReader(read, 20);
    const first = await reader({} as never, ACCOUNT);
    expect(first.snapshot.status).toBe("static");
    // A second request while the first read is still out does not start another.
    await reader({} as never, ACCOUNT);
    expect(read).toHaveBeenCalledTimes(1);
    finish({ snapshot: live, reachable: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await reader({} as never, ACCOUNT)).snapshot.status).toBe("live");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
