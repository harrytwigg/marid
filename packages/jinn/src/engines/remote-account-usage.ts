import { lastAccountReading, rememberAccountReading } from "../shared/account-readings.js";
import { recordClaudeUsageSample, usageHistoryPath } from "../shared/claude-usage-history.js";
import { fetchClaudeOAuthUsageWithToken } from "../shared/engine-limits-claude.js";
import { windowsFromClaudeUsage } from "../shared/engine-limits-claude-usage.js";
import type { ClaudeAccountInfo, RemoteAccountReader } from "../shared/engine-limits-accounts.js";
import type { EngineLimitEngineSnapshot } from "../shared/types.js";
import { cachedRemoteFacts, gatherFacts, probeReachable, shq, sshRun, type RemoteFacts, type SshRunResult } from "./remote-stage.js";

/**
 * A remote Claude account's live reading (spec FR-072). Remote sessions write
 * no status line back to the gateway, so the gateway reads the account itself,
 * on the same refresh as the local ones:
 *
 * - **The token.** A small script, run with the host's own Node, reads the
 *   login where Claude Code keeps it for that profile — the macOS Keychain
 *   entry named for the path on a macOS host, else `.credentials.json` — and
 *   prints ONLY the access token and its expiry. The refresh token never
 *   crosses the network. The profile path is an argument, quoted, never
 *   interpolated into the script. The token is held in memory for the one
 *   usage call and dropped: never stored, logged, refreshed or put in an
 *   environment.
 * - **The plan**, from `claude auth status` over SSH under the account's
 *   `CLAUDE_CONFIG_DIR`.
 * - **Only when the host is awake.** A host that does not answer the probe is
 *   not woken for monitoring; its card shows the last reading and its age.
 */

/** Runs on the remote host under its own Node, reading the script from stdin.
 *  argv[2] is the profile directory exactly as the session's CLAUDE_CONFIG_DIR
 *  (empty for the host's default login). Prints `{}` or
 *  `{"accessToken":…,"expiresAt":…}` and nothing else. */
export const REMOTE_TOKEN_SCRIPT = `
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const cp = require("node:child_process"), crypto = require("node:crypto");
const dir = process.argv[2] || "";
function pick(raw) {
  try {
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt === undefined ? null : oauth.expiresAt };
  } catch { return null; }
}
let found = null;
if (process.platform === "darwin") {
  const suffix = dir ? "-" + crypto.createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8) : "";
  try {
    found = pick(cp.execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials" + suffix, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
  } catch { found = null; }
}
if (!found) {
  try { found = pick(fs.readFileSync(path.join(dir || path.join(os.homedir(), ".claude"), ".credentials.json"), "utf8")); } catch { found = null; }
}
process.stdout.write(JSON.stringify(found || {}));
`;

export interface RemoteAccountUsageDeps {
  probe: (destination: string) => Promise<boolean>;
  facts: (destination: string) => Promise<RemoteFacts>;
  run: (destination: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<SshRunResult>;
  fetchUsage: (token: string) => Promise<Record<string, unknown> | undefined>;
  now: () => number;
}

const defaultDeps: RemoteAccountUsageDeps = {
  probe: probeReachable,
  facts: async (destination) => cachedRemoteFacts(destination) ?? await gatherFacts(destination),
  run: sshRun,
  fetchUsage: fetchClaudeOAuthUsageWithToken,
  now: Date.now,
};

/** The unexpired access token the host printed, or undefined. Parsed here and
 *  returned to the caller only; nothing else about the output is kept. */
export function accessTokenFromScriptOutput(stdout: string, nowMs: number): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { accessToken?: unknown; expiresAt?: unknown };
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return undefined;
    const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt
      : typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : undefined;
    // An expired token is no reading: the gateway never refreshes one (FR-071).
    if (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= nowMs) return undefined;
    return parsed.accessToken;
  } catch {
    return undefined;
  }
}

function envPrefix(configDir: string | undefined): string {
  return configDir ? `CLAUDE_CONFIG_DIR=${shq(configDir)} ` : "";
}

async function remotePlan(deps: RemoteAccountUsageDeps, destination: string, facts: RemoteFacts, configDir: string | undefined): Promise<string | undefined> {
  if (!facts.claudeBin) return undefined;
  const res = await deps.run(destination, [`${envPrefix(configDir)}${shq(facts.claudeBin)} auth status`], { timeoutMs: 15_000 });
  if (res.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(res.stdout) as { subscriptionType?: unknown; authMethod?: unknown };
    const plan = parsed.subscriptionType ?? parsed.authMethod;
    return typeof plan === "string" && plan ? plan : undefined;
  } catch {
    return undefined;
  }
}

function base(nowMs: number): EngineLimitEngineSnapshot {
  return { name: "claude", available: true, status: "static", source: "claude oauth usage api (over ssh)", refreshedAt: new Date(nowMs).toISOString(), models: [] };
}

/** What a host that did not answer shows: its last reading, marked stale, or
 *  a plain "no reading". Never a reason to wake it. */
function asleep(account: string): EngineLimitEngineSnapshot {
  const last = lastAccountReading(account);
  if (last) return { ...last.snapshot, stale: true };
  return { ...base(Date.now()), refreshedAt: new Date(0).toISOString(), unsupportedReason: "The host is asleep or unreachable, and has not been read yet; it is not woken to be read." };
}

export async function readRemoteAccountUsage(
  account: ClaudeAccountInfo,
  deps: RemoteAccountUsageDeps = defaultDeps,
): Promise<{ snapshot: EngineLimitEngineSnapshot; reachable: boolean }> {
  const destination = account.remote?.destination;
  if (!destination) return { snapshot: asleep(account.key), reachable: false };
  let reachable = false;
  try {
    reachable = await deps.probe(destination);
  } catch {
    reachable = false;
  }
  if (!reachable) return { snapshot: asleep(account.key), reachable: false };

  const nowMs = deps.now();
  const configDir = account.remote?.configDir;
  let facts: RemoteFacts;
  try {
    facts = await deps.facts(destination);
  } catch {
    return { snapshot: { ...base(nowMs), unsupportedReason: "The host answered, but its toolchain could not be read." }, reachable: true };
  }
  const [tokenRun, accountPlan] = await Promise.all([
    process.env.JINN_CLAUDE_USAGE_API === "off"
      ? Promise.resolve(undefined)
      : deps.run(destination, [`${shq(facts.nodeBin)} - ${shq(configDir ?? "")}`], { stdin: REMOTE_TOKEN_SCRIPT, timeoutMs: 15_000 }),
    remotePlan(deps, destination, facts, configDir),
  ]);
  const token = tokenRun && tokenRun.code === 0 ? accessTokenFromScriptOutput(tokenRun.stdout, nowMs) : undefined;
  const usage = token ? await deps.fetchUsage(token) : undefined;
  const windows = usage ? windowsFromClaudeUsage(usage) : [];
  if (windows.length === 0) {
    return {
      snapshot: { ...base(nowMs), accountPlan, unsupportedReason: "No live reading: the account's access token has expired or its login could not be read. A session on it refreshes the token." },
      reachable: true,
    };
  }
  const live: EngineLimitEngineSnapshot = { ...base(nowMs), status: "live", accountPlan, windows };
  rememberAccountReading(account.key, live, nowMs);
  recordClaudeUsageSample(live, nowMs, usageHistoryPath(account.key));
  return { snapshot: live, reachable: true };
}

export const remoteAccountReader: RemoteAccountReader = (_config, account) => readRemoteAccountUsage(account);
