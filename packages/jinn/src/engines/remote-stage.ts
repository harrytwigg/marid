import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { FARM_FILTERED_DIRS, REMOTE_STAGE_MARKER } from "../shared/remote-farm.js";
import { runLocalWakeCommand, sendWakeOnLan } from "./remote-wake.js";
import { ancestorMemoryExcludes } from "../shared/remote-department.js";
import { assertRemoteClaudeSkipsAncestors, clearRemoteClaudeCheckCache } from "./remote-claude-check.js";
import { rebuildScopedHome, remoteDepartmentEnv, remoteDepartmentFileRoots, scopedRemoteDepartment, syncRemoteDepartmentStage } from "./remote-department-stage.js";
import { parseVersionOutput } from "../shared/brand.js";
import { getPackageVersion } from "../shared/version.js";
import { buildSessionSettings } from "../shared/claude-settings.js";
import { readGatewayInfo } from "../gateway/gateway-info.js";
import { GATEWAY_INFO_FILE } from "../shared/paths.js";
import { assertRemoteTarget, MOUNT_SENTINEL, resolveRemoteClaudeConfigDir, sshDestination, REMOTE_STAGE_DIR_NAME } from "../shared/remote-target.js";
import type { RemoteTarget, ResolvedMcpConfig, SessionRemoteTarget } from "../shared/types.js";
import type { RemoteEngineName } from "../shared/models.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { remapMcpConfigForRemote } from "../mcp/remote-config.js";
import { confineMcpToDepartment } from "../gateway/department-scope/mcp-servers.js";
import { piJinnMcpAttachable, piJinnSessionEnv, remotePiExtensionSource } from "./pi-mcp.js";
import { buildOpencodeSessionConfig, serializeOpencodeSessionConfig } from "./opencode-mcp.js";

/**
 * Everything the gateway does to a remote host that is NOT the interactive
 * session itself.
 *
 * All of it runs through one-shot `ssh` control invocations — plain
 * `child_process.spawn`, never `pty.spawn`. These are control operations, not
 * a TUI: they want an exit code and clean stdout, and a pseudo-terminal would
 * only interleave the two.
 *
 * The interactive session is the caller's job; this module hands it a ready
 * argv (see {@link buildSshSpawnArgs}).
 */

/** Directory on the remote host that acts as the session's JINN_HOME.
 *  Deliberately NOT `~/.jinn`: if a real Jinn instance is ever installed on
 *  that machine, staging into its home would overwrite its gateway.json and
 *  point its hook relay at our tunnel. A distinct name makes that collision
 *  impossible rather than unlikely. */
const REMOTE_STAGE_DIR = REMOTE_STAGE_DIR_NAME;

/** Subdirectory of the per-host stage holding one `$JINN_HOME` per session. */
const SESSIONS_DIR = "sessions";

/** How long an untouched session stage survives before the next spawn reaps it.
 *  Every spawn rewrites its own session's gateway.json, so a live session is
 *  never older than its last turn; this only ever collects the dead. */
const SESSION_STAGE_TTL_DAYS = 7;

const DEFAULT_WAIT_MS = 240_000;
/** Budget for a `wakeCommand`. Five minutes because a real startup path presses
 *  a power button and waits for a machine to POST, rather than sending a packet. */
const DEFAULT_WAKE_TIMEOUT_MS = 300_000;
const DEFAULT_PROBE_INTERVAL_MS = 10_000;
/** Per-probe ssh timeout. Short: this question is "is the box up", and a host
 *  that needs longer than this to answer a TCP handshake is, for our purposes,
 *  not up yet — the caller is already in a polling loop. */
const PROBE_CONNECT_TIMEOUT_S = 5;
/** Longer budget for real control work (staging, the farm, the trust seed). */
const CONTROL_CONNECT_TIMEOUT_S = 15;
const CONTROL_TIMEOUT_MS = 60_000;

/** POSIX single-quote for embedding an arbitrary value in a remote shell
 *  command. The remote is POSIX by assumption (it runs `claude` in a PTY). */
export function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** ssh options shared by every control invocation.
 *  - BatchMode: never prompt for a password/passphrase. Key auth or failure.
 *  - StrictHostKeyChecking is deliberately NOT relaxed to `accept-new`: silently
 *    trusting a new host key on the operator's behalf is a security downgrade,
 *    and the failure it would paper over is one they should see once. */
function controlSshOpts(connectTimeoutSeconds: number): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", "LogLevel=ERROR",
  ];
}

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one ssh control command. `stdin`, when given, is piped to the remote
 *  command — this is how file content is staged without a temp file on either
 *  side and without ever putting content on a command line. */
interface SshRunOpts {
  stdin?: string | Buffer;
  timeoutMs?: number;
  connectTimeoutSeconds?: number;
  /** Run the client in its own process group and let it finish after this
   *  process exits. For a control op whose EFFECT matters more than its
   *  answer — a kill sent during gateway shutdown — the 5s force-exit must
   *  not take the signal down with it. */
  outliveGateway?: boolean;
}

export async function sshRun(destination: string, args: string[], opts: SshRunOpts = {}): Promise<SshRunResult> {
  const full = [
    ...controlSshOpts(opts.connectTimeoutSeconds ?? CONTROL_CONNECT_TIMEOUT_S),
    // Same shape as the interactive spawn: `--` BEFORE the destination so a host
    // beginning with `-` cannot be read as a local ssh option, and none after it
    // (see buildSshSpawnArgs — a second `--` lands in the remote command).
    "--",
    destination,
    ...args,
  ];
  return await new Promise<SshRunResult>((resolve) => {
    const child = spawn("ssh", full, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.outliveGateway && process.platform !== "win32" ? { detached: true } : {}),
    });
    if (opts.outliveGateway) child.unref();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      // A control op that outlives its budget is a hung connection, not a slow
      // one; kill it so a wake/poll loop cannot stall on a half-open socket.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, opts.timeoutMs ?? CONTROL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      stderr += String(err instanceof Error ? err.message : err);
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Run a POSIX script on the remote. The script travels on stdin to `sh -s`
 *  rather than inside argv: ssh flattens argv into one string for the remote
 *  shell, so a script embedded there gets a second round of word splitting and
 *  quote interpretation. Arguments are shell-quoted individually. */
async function sshScript(
  destination: string,
  script: string,
  args: string[] = [],
  opts: { timeoutMs?: number; outliveGateway?: boolean } = {},
): Promise<SshRunResult> {
  const command = ["sh", "-s", ...args.map(shq)].join(" ");
  return await sshRun(destination, [command], { stdin: script, ...opts });
}

/** Write `content` to `remotePath` at mode 0600, atomically.
 *  tmp-then-rename so a hook relay or MCP server reading concurrently can never
 *  observe a partial file — the same discipline the local writers use. */
export async function stageRemoteFile(
  destination: string,
  remotePath: string,
  content: string,
): Promise<void> {
  const dir = path.posix.dirname(remotePath);
  const tmp = `${remotePath}.tmp`;
  const command = [
    `mkdir -p ${shq(dir)}`,
    `chmod 700 ${shq(dir)}`,
    `cat > ${shq(tmp)}`,
    `chmod 600 ${shq(tmp)}`,
    `mv -f ${shq(tmp)} ${shq(remotePath)}`,
  ].join(" && ");
  const res = await sshRun(destination, [command], { stdin: content });
  if (res.code !== 0) {
    throw new Error(`failed to stage ${remotePath} on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
}

// ── Host facts ───────────────────────────────────────────────────────────────

export interface RemoteFacts {
  /** `$HOME` on the remote host. Everything else is resolved against it, because
   *  the gateway cannot expand `~` for another machine's user. */
  home: string;
  /** Per-HOST stage root. Holds the real hook-relay/trust-seed copies and the
   *  `sessions/` tree; it is NOT itself a session's JINN_HOME. */
  stageDir: string;
  nodeBin: string;
  /** The agent CLIs found on the remote host, by engine name. Undefined for an
   *  engine whose binary is not there — which is only an error for the engine a
   *  given session actually runs (see {@link requireRemoteEngineBin}), because a
   *  host that runs Pi employees has no reason to have Claude Code installed. */
  claudeBin?: string;
  piBin?: string;
  opencodeBin?: string;
  jinnVersion: string;
  /** Directory holding the remote install's `server-entry.js` / `scrub-entry.js`. */
  entryDir: string;
}

/**
 * Probe the remote host for the absolute paths a session needs.
 *
 * The PATH dance at the top is load-bearing, not defensive clutter. A
 * non-interactive ssh command reads no shell rc file, so a host whose Node is
 * installed by a version manager reports no `node` at all — and nvm's own
 * `nvm.sh` cannot rescue that, because it is bash-only and `/bin/sh` is `dash`
 * on most Debian-family systems (a Raspberry Pi included). So nvm's layout is
 * read directly.
 *
 * Honouring nvm's `default` alias matters rather than taking the newest
 * version: a global `jinn-cli` lives under ONE version's tree, so a host with
 * both v22 (default, where jinn was installed) and v24 would otherwise resolve
 * to v24 and report jinn missing.
 */
export const FACTS_SCRIPT = `
set -u
# Common install dirs a login shell would add. Appended, so the system PATH wins.
PATH="$PATH:$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin"
if ! command -v node >/dev/null 2>&1; then
  nvmdir=\${NVM_DIR:-$HOME/.nvm}
  nodedir=""
  if [ -d "$nvmdir/versions/node" ]; then
    want=""
    [ -f "$nvmdir/alias/default" ] && want=$(cat "$nvmdir/alias/default" 2>/dev/null)
    if [ -n "$want" ]; then
      case "$want" in v*) pat="$want" ;; *) pat="v$want" ;; esac
      nodedir=$(ls -1d "$nvmdir/versions/node/$pat" "$nvmdir/versions/node/$pat".* 2>/dev/null | sort -V | tail -1)
    fi
    if [ -z "$nodedir" ]; then
      nodedir=$(ls -1d "$nvmdir"/versions/node/v* 2>/dev/null | sort -V | tail -1)
    fi
  fi
  if [ -n "$nodedir" ] && [ -x "$nodedir/bin/node" ]; then PATH="$nodedir/bin:$PATH"; fi
fi
export PATH
printf 'home=%s\\n' "$HOME"
printf 'node=%s\\n' "$(command -v node 2>/dev/null || true)"
printf 'claude=%s\\n' "$(command -v claude 2>/dev/null || true)"
printf 'pi=%s\\n' "$(command -v pi 2>/dev/null || true)"
printf 'opencode=%s\\n' "$(command -v opencode 2>/dev/null || true)"
jinnbin=$(command -v jinn 2>/dev/null || true)
if [ -n "$jinnbin" ]; then
  printf 'jinnversion=%s\\n' "$(jinn --version 2>/dev/null | tr -d '\\r' | head -n 1)"
  printf 'entrydir=%s\\n' "$(node -e 'const fs=require("fs"),path=require("path");try{const b=fs.realpathSync(process.argv[1]);process.stdout.write(path.resolve(path.dirname(b),"..","src","mcp"))}catch(e){}' "$jinnbin" 2>/dev/null || true)"
fi
`;

function parseKeyValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Facts are stable for the life of a host's install, so they are cached per
 *  gateway process. The mount sentinel is deliberately NOT cached — it is the
 *  one fact that can go stale while the gateway keeps running. */
const factsCache = new Map<string, RemoteFacts>();

/** Exported for tests: drop cached host facts. */
export function clearRemoteFactsCache(): void {
  factsCache.clear();
}

/**
 * Whether `engine`'s CLI was seen on `destination`, from facts already gathered
 * — `undefined` when this gateway has never probed that host.
 *
 * Tri-state on purpose. The one caller is the rate-limit substitution walker,
 * which runs on the turn path and must not make an ssh round trip to answer a
 * question about a host that just served a turn: it reads `false` as "do not
 * hand the work to this engine" and `undefined` as "unknown — let the spawn
 * say so", which is the same thing a collapsed boolean would get wrong in
 * exactly the case that matters (a host whose facts are not cached yet would
 * look like a host with nothing installed on it).
 */
export function remoteEngineAvailable(destination: string, engine: RemoteEngineName): boolean | undefined {
  const facts = factsCache.get(destination);
  if (!facts) return undefined;
  return Boolean(facts[REMOTE_ENGINE_BIN_FIELD[engine]]);
}

/** Which {@link RemoteFacts} field holds each engine's CLI path. One map rather
 *  than a ternary at each call site: a fourth engine that has to add a branch to
 *  two separate conditionals is how the two quietly stop agreeing about what is
 *  installed on a host. */
const REMOTE_ENGINE_BIN_FIELD: Record<RemoteEngineName, "claudeBin" | "piBin" | "opencodeBin"> = {
  claude: "claudeBin",
  pi: "piBin",
  opencode: "opencodeBin",
};

/** Facts already learned about a host this gateway boot, without asking again.
 *  For callers on a hot path that must never make an ssh round trip — the hook
 *  endpoint, which fires many times a turn. Undefined before the first spawn,
 *  which is fine: nothing can have hooked before it has spawned. */
export function cachedRemoteFacts(destination: string): RemoteFacts | undefined {
  return factsCache.get(destination);
}

/**
 * Reject a host missing the binaries EVERY session needs, naming the PATH cause.
 *
 * A non-interactive ssh reads no rc file, so the overwhelmingly common reason a
 * binary "is missing" here is that it is installed but only reachable from an
 * interactive shell. Being told to install something already installed sends
 * the operator down entirely the wrong path, so each message says how to check.
 *
 * The agent CLI is deliberately NOT checked here: facts are cached per host and
 * shared by every session on it, and which agent a session needs is a property
 * of its engine. A box that runs only Pi employees has no reason to carry Claude
 * Code, and refusing it here would make a whole host unusable over a binary
 * nothing on it was going to run. {@link requireRemoteEngineBin} makes that
 * judgement per engine instead.
 */
function assertRemoteToolchain(destination: string, kv: Record<string, string>): void {
  if (!kv.home) throw new Error(`${destination} reported no $HOME`);
  if (!kv.node) {
    throw new Error(
      `${destination} has no \`node\` on the non-interactive PATH. Check with `
      + `\`ssh ${destination} 'command -v node'\` — if that prints nothing but node works when you log in, `
      + `it is installed by a version manager this could not resolve; symlink it somewhere on the default PATH `
      + `(e.g. ~/.local/bin) or install Node.js system-wide`,
    );
  }
}

/** How an operator fixes a missing agent CLI, per engine. Both halves matter:
 *  the check, because a version manager's binary is invisible to a
 *  non-interactive ssh and "not installed" would be the wrong diagnosis; and the
 *  install line, because the two CLIs are not installed the same way. */
const REMOTE_ENGINE_INSTALL_HINT: Record<RemoteEngineName, string> = {
  claude: "install Claude Code there and sign it in",
  pi: "install the Pi CLI there and configure its providers in ~/.pi/agent/models.json",
  opencode: "install the opencode CLI there and sign it in with `opencode auth login`",
};

/**
 * The absolute path to the agent CLI this engine runs on the remote host.
 *
 * Throws rather than returning undefined: reaching a spawn with no binary is not
 * a state any caller can do something useful with, and the message is the whole
 * value — an unattended turn that fails with "no such file" tells the operator
 * nothing about which machine, which binary, or which PATH.
 */
/** The path to `engine`'s CLI on that host, or undefined when the probe did not
 *  find one. For callers that want to REPORT the state rather than act on it —
 *  `jinn remote status`, whose whole job is to say what is and is not there. */
export function remoteEngineBin(facts: RemoteFacts, engine: RemoteEngineName): string | undefined {
  return facts[REMOTE_ENGINE_BIN_FIELD[engine]];
}

export function requireRemoteEngineBin(
  destination: string,
  facts: RemoteFacts,
  engine: RemoteEngineName,
): string {
  const bin = remoteEngineBin(facts, engine);
  if (bin) return bin;
  throw new Error(
    `${destination} has no \`${engine}\` on the non-interactive PATH. Check with `
    + `\`ssh ${destination} 'command -v ${engine}'\` — ${REMOTE_ENGINE_INSTALL_HINT[engine]}, `
    + `or symlink it onto the default PATH if it is already installed`,
  );
}

/** Check the first line of the remote's `jinn --version` against the gateway's
 *  version. Returns the remote's bare version; throws with the fixing command
 *  when it differs or is not a version at all. */
export function assertRemoteVersion(destination: string, versionLine: string, local: string): string {
  const remote = parseVersionOutput(versionLine);
  if (remote !== local) {
    throw new Error(
      `${destination} runs jinn-cli ${remote ?? `(unrecognised \`jinn --version\` output: ${JSON.stringify(versionLine)})`} but this gateway is ${local} — `
      + `run \`npm install -g jinn-cli@${local}\` there`,
    );
  }
  return remote;
}

export async function gatherFacts(destination: string): Promise<RemoteFacts> {
  const cached = factsCache.get(destination);
  if (cached) return cached;

  const res = await sshScript(destination, FACTS_SCRIPT);
  if (res.code !== 0) {
    throw new Error(`could not read host facts from ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const kv = parseKeyValues(res.stdout);
  assertRemoteToolchain(destination, kv);
  if (!kv.jinnversion) {
    throw new Error(
      `${destination} has no \`jinn\` on PATH — run \`npm install -g jinn-cli@${getPackageVersion()}\` there `
      + `(the remote install supplies the MCP server entrypoints; the daemon is never started)`,
    );
  }
  // Version skew would otherwise surface as a confusing mid-turn MCP failure:
  // the remapped config points at entrypoints from a different build. Refuse
  // now, with the command that fixes it.
  const remoteVersion = assertRemoteVersion(destination, kv.jinnversion, getPackageVersion());
  if (!kv.entrydir) {
    throw new Error(`could not locate the jinn MCP entrypoints on ${destination}`);
  }
  const facts: RemoteFacts = {
    home: kv.home,
    stageDir: path.posix.join(kv.home, REMOTE_STAGE_DIR),
    nodeBin: kv.node,
    ...(kv.claude ? { claudeBin: kv.claude } : {}),
    ...(kv.pi ? { piBin: kv.pi } : {}),
    ...(kv.opencode ? { opencodeBin: kv.opencode } : {}),
    jinnVersion: remoteVersion,
    entryDir: kv.entrydir,
  };
  factsCache.set(destination, facts);
  return facts;
}

// ── Mount liveness ───────────────────────────────────────────────────────────

/** Read (creating on first use) the gateway-side sentinel value.
 *  Its only job is to be a value the remote can only see THROUGH the mount. */
function localSentinelValue(): string {
  const file = path.join(JINN_HOME, MOUNT_SENTINEL);
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch { /* first use */ }
  const value = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(JINN_HOME, { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

async function readRemoteSentinel(destination: string, mount: string): Promise<string> {
  const res = await sshRun(destination, [`cat ${shq(path.posix.join(mount, MOUNT_SENTINEL))} 2>/dev/null || true`]);
  return res.stdout.trim();
}

export { runLocalWakeCommand, sendWakeOnLan };

// ── Readiness ────────────────────────────────────────────────────────────────

export type RemoteReadiness =
  | { ready: true; facts: RemoteFacts }
  | { ready: false; reason: string };

export interface EnsureReadyOpts {
  /** Which agent the session will run there. Decides which CLI must be present
   *  and whether the Claude profile check applies — asked HERE, on the path that
   *  has an operator to talk to, rather than at the spawn where the only
   *  audience is a log line. */
  engine: RemoteEngineName;
  /** Whether an unreachable host may be woken. FALSE for the dashboard's idle
   *  PTY: opening a terminal tab must never boot someone's desktop. */
  allowWake: boolean;
  /** Called once when the host is not up and we are about to wait, so the turn
   *  path can move the session to "waiting" and tell the operator. */
  onWaitStart?: (info: { destination: string; waking: boolean }) => void;
  /** Polled while waiting; returning true abandons the wait (session stopped). */
  shouldAbort?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Is the host answering ssh at all? */
export async function probeReachable(destination: string): Promise<boolean> {
  const res = await sshRun(destination, ["true"], {
    timeoutMs: (PROBE_CONNECT_TIMEOUT_S + 5) * 1000,
    connectTimeoutSeconds: PROBE_CONNECT_TIMEOUT_S,
  });
  if (res.code === 0) return true;
  if (/host key verification failed/i.test(res.stderr)) {
    // Fail closed but say the exact thing the operator must do; BatchMode turns
    // the usual interactive TOFU prompt into a bare non-zero exit.
    throw new Error(
      `host key verification failed for ${destination} — add its key to the gateway's known_hosts `
      + `(e.g. \`ssh-keyscan -H <host> >> ~/.ssh/known_hosts\`) after checking the fingerprint`,
    );
  }
  if (/permission denied/i.test(res.stderr)) {
    throw new Error(
      `ssh to ${destination} was refused (permission denied) — remote execution is key-only `
      + `(BatchMode), so a passphrase-locked key with no agent will always fail`,
    );
  }
  return false;
}

/**
 * Bring a remote host to the point where a session can be spawned on it:
 * reachable, running a matching jinn-cli, with the gateway's JINN_HOME mounted.
 *
 * Waiting is BOUNDED on purpose. A desktop that is off for the weekend must
 * fail the turn with something the operator can read, not pin the session at
 * "waiting" indefinitely.
 */
export async function ensureRemoteReady(
  target: RemoteTarget,
  remote: RemoteExecutionConfig | undefined,
  opts: EnsureReadyOpts,
): Promise<RemoteReadiness> {
  if (!remote) return { ready: false, reason: "no `remote` config block is configured" };
  const destination = sshDestination(target as RemoteTarget & { remoteHost: string });
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;

  try {
    if (!await probeReachable(destination)) {
      const problem = await wakeAndWait(destination, remote, opts, now, sleep);
      if (problem) return { ready: false, reason: problem };
    }
    const facts = await gatherFacts(destination);
    requireRemoteEngineBin(destination, facts, opts.engine);
    const mountProblem = await verifyMount(destination, remote);
    if (mountProblem) return { ready: false, reason: mountProblem };
    const profileProblem = await verifyEngineProfile(destination, target, remote, opts.engine);
    if (profileProblem) return { ready: false, reason: profileProblem };
    return { ready: true, facts };
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The profile half of readiness, which only one engine has.
 *
 *  Pi has no profile of its own to be signed out of: it drives a provider the
 *  operator configured on that host, and those credentials are that provider's
 *  business. Asking this question of a Pi session would refuse a perfectly good
 *  host over a Claude Code install it never touches. */
async function verifyEngineProfile(
  destination: string,
  target: RemoteTarget,
  remote: RemoteExecutionConfig,
  engine: RemoteEngineName,
): Promise<string | undefined> {
  if (engine !== "claude") return undefined;
  return await verifyClaudeProfile(destination, resolveRemoteClaudeConfigDir(target, remote));
}

/** Hosts+profiles already seen signed in. Only SUCCESS is cached: a profile that
 *  failed may have been signed in since, and re-checking a failure costs one ssh
 *  round trip against a turn that was going to fail anyway. */
const authedProfiles = new Set<string>();

/** Exported for tests: forget cached profile auth results. */
export function clearRemoteProfileCache(): void {
  authedProfiles.clear();
}

/**
 * Refuse a profile that is not signed in.
 *
 * Claude Code answers an unauthenticated start with an interactive login
 * prompt. In a gateway PTY there is nobody to answer it, so the turn would hang
 * with no hook, no notification and no error — the same silent-hang class as the
 * folder-trust dialog, and worth the same explicit guard rather than a mystery.
 *
 * Only checked when a profile is named: the remote user's default profile is
 * whatever `claude` would use interactively, and second-guessing it here would
 * reject working setups that keep credentials somewhere we do not know about.
 */
async function verifyClaudeProfile(
  destination: string,
  claudeConfigDir: string | undefined,
): Promise<string | undefined> {
  if (!claudeConfigDir) return undefined;
  const key = `${destination}:${claudeConfigDir}`;
  if (authedProfiles.has(key)) return undefined;
  const creds = path.posix.join(claudeConfigDir, ".credentials.json");
  const res = await sshRun(destination, [`test -d ${shq(claudeConfigDir)} && echo dir; test -s ${shq(creds)} && echo creds; true`]);
  const out = res.stdout;
  if (!out.includes("dir")) {
    return `the Claude profile directory ${claudeConfigDir} does not exist on ${destination}`;
  }
  if (!out.includes("creds")) {
    return `the Claude profile at ${claudeConfigDir} on ${destination} is not signed in `
      + `(no .credentials.json) — claude would open a login prompt in front of a PTY with nobody at the keyboard`;
  }
  authedProfiles.add(key);
  return undefined;
}

/** Fire whichever wake mechanism is configured. `wakeCommand` wins over
 *  `wakeMac` so an operator whose box is not WoL-capable is never second-guessed. */
async function triggerWake(destination: string, remote: RemoteExecutionConfig): Promise<string | undefined> {
  if (remote.wakeCommand) {
    logger.info(`remote: waking ${destination} via wakeCommand`);
    await runLocalWakeCommand(remote.wakeCommand, remote.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS);
    return undefined;
  }
  if (remote.wakeMac) {
    logger.info(`remote: sending Wake-on-LAN to ${destination}`);
    await sendWakeOnLan(remote.wakeMac);
    return undefined;
  }
  return `${destination} is not reachable and no remote.wakeCommand/remote.wakeMac is configured`;
}

/** Wake an unreachable host and poll until it answers or the budget runs out.
 *  Returns the reason it is still not usable, or undefined on success. */
async function wakeAndWait(
  destination: string,
  remote: RemoteExecutionConfig,
  opts: EnsureReadyOpts,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const canWake = opts.allowWake && Boolean(remote.wakeCommand || remote.wakeMac);
  opts.onWaitStart?.({ destination, waking: canWake });

  // The dashboard's idle PTY passes allowWake:false. Opening a terminal tab
  // must never boot someone's desktop.
  if (!opts.allowWake) return `${destination} is not reachable`;
  const wakeProblem = await triggerWake(destination, remote);
  if (wakeProblem) return wakeProblem;

  return await pollUntilReachable(destination, remote, opts, now, sleep);
}

/** Poll a waking host until it answers, the operator stops the session, or the
 *  budget runs out. Bounded on purpose: a box that is off for the weekend must
 *  fail the turn with something readable, not pin it at "waiting" forever. */
async function pollUntilReachable(
  destination: string,
  remote: RemoteExecutionConfig,
  opts: EnsureReadyOpts,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const waitMs = remote.waitMs ?? DEFAULT_WAIT_MS;
  const interval = remote.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const aborted = () => opts.shouldAbort?.() === true;
  const deadline = now() + waitMs;
  while (now() < deadline) {
    if (aborted()) return "cancelled while waiting for the remote host";
    await sleep(interval);
    if (aborted()) return "cancelled while waiting for the remote host";
    if (await probeReachable(destination)) return undefined;
  }
  return `${destination} did not come up within ${Math.round(waitMs / 1000)}s of being woken`;
}

/**
 * Confirm the gateway's instance home is genuinely mounted on the remote host.
 *
 * The failure this exists for is a SILENTLY unmounted sshfs: the symlink farm
 * then points into an empty directory, the session's writes to knowledge/ and
 * docs/ succeed locally, and the org quietly diverges with no error anywhere.
 * A reboot does not bring sshfs back, so a host that just woke normally lands
 * here with a dead mount — which is why the remount attempt is on this path.
 */
async function verifyMount(
  destination: string,
  remote: RemoteExecutionConfig,
): Promise<string | undefined> {
  const expected = localSentinelValue();
  let seen = await readRemoteSentinel(destination, remote.mount);
  if (seen !== expected && remote.remountCommand) {
    logger.info(`remote: ${remote.mount} on ${destination} is not live — running remountCommand`);
    const res = await sshRun(destination, [remote.remountCommand]);
    if (res.code !== 0) {
      logger.warn(`remote remountCommand on ${destination} exited ${res.code}: ${res.stderr.trim()}`);
    }
    seen = await readRemoteSentinel(destination, remote.mount);
  }
  if (seen === expected) return undefined;
  return `the gateway's instance home is not mounted at ${remote.mount} on ${destination} `
    + `(sentinel ${seen ? "mismatched" : "unreadable"}) — without it the session's writes to `
    + `knowledge/, docs/ and org/ would land on the remote host instead of reaching the org`;
}

// ── Per-host staging ─────────────────────────────────────────────────────────

const seededTrust = new Set<string>();

/** Exported for tests: forget per-host staging so it runs again. */
export function clearRemoteStagingCache(): void {
  seededTrust.clear();
  clearRemoteClaudeCheckCache();
  stagingQueues.clear();
}

/**
 * Serialize control work per remote host.
 *
 * Two sessions preparing against the same box at the same moment would
 * otherwise interleave the two operations that mutate per-HOST state: staging
 * the shared assets, and the trust seed's read-modify-write of the remote
 * user's `~/.claude.json`. A lost update there is not cosmetic — the project
 * whose key was dropped is remembered as seeded and never retried, so its next
 * turn hangs forever on the folder-trust dialog.
 *
 * Per-SESSION staging needs no such lock: each session owns its own directory.
 */
const stagingQueues = new Map<string, Promise<unknown>>();

function serializePerHost<T>(destination: string, work: () => Promise<T>): Promise<T> {
  const prior = stagingQueues.get(destination) ?? Promise.resolve();
  // `catch` before chaining so one failed prepare does not poison the queue for
  // every later session on that host.
  const next = prior.catch(() => undefined).then(work);
  stagingQueues.set(destination, next.catch(() => undefined));
  return next;
}

/** Locate a shipped asset. Same three-candidate probe `server.ts` uses for
 *  hook-relay.mjs: `assets/` sits at a different depth relative to this module
 *  depending on whether it is running from `dist/` or a worktree, and guessing
 *  one depth is how the relay went missing before. */
function assetPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "..", "assets", name),
    path.join(here, "..", "..", "assets", name),
    path.join(here, "..", "assets", name),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`asset ${name} not found in any candidate location`);
  return found;
}

/** The two files staged as REAL copies at the per-host stage root, never
 *  symlinked through the mount: hooks fire many times a turn, and a relay that
 *  cannot run because the mount blipped would take the turn's completion signal
 *  with it. Living at the stage ROOT — outside any session's symlink farm — is
 *  what keeps the farm rebuild from converting them back into mount symlinks. */
const HOST_ASSETS = ["hook-relay.mjs", "remote-trust-seed.mjs"] as const;

export function remoteRelayScript(facts: RemoteFacts): string {
  return path.posix.join(facts.stageDir, "hook-relay.mjs");
}

/** A remote session's own `$JINN_HOME`, per session AND per engine.
 *
 *  Per SESSION because `gateway.json` names the reverse-tunnel port, which is
 *  allocated per spawn — so a single shared copy means any second prepare
 *  rewrites the port another LIVE session's hook relay is about to read. The
 *  relay would then POST into a port with no tunnel behind it and, by design,
 *  swallow the failure: no Stop, no policy enforcement, and a turn that runs to
 *  completion while the gateway hears nothing.
 *
 *  Per ENGINE for exactly the same reason, once a session can change engine
 *  mid-flight. A rate-limited Claude session is substituted onto pi WITHOUT its
 *  PTY being released: that PTY stays warm, takes the next turn through
 *  `injectPrompt` with no re-staging, and its relay re-reads `gateway.json` on
 *  every hook. Sharing one home would have pi's prepare repoint the live Claude
 *  session's relay at a tunnel that dies when pi's ssh exits. Locally the two
 *  engines keep entirely separate state (Claude's own config dir, pi's
 *  `--session-dir`); this is that same separation on the other machine.
 *
 *  Flat rather than nested under the session, because the stage reaper matches
 *  `-mindepth 1 -maxdepth 1 -type d -mtime` (FARM_SCRIPT): a parent directory's
 *  mtime does not move when a spawn writes inside it, so a nested layout would
 *  put live sessions in front of the reaper. */
export function remoteSessionHome(facts: RemoteFacts, jinnSessionId: string, engine: RemoteEngineName): string {
  return path.posix.join(facts.stageDir, SESSIONS_DIR, safeSessionSegment(`${jinnSessionId}__${engine}`));
}

/**
 * The instance's own `bin/` as a remote session sees it: a symlink in the farm
 * pointing at the mounted gateway home's `bin/`.
 *
 * Put on the session's PATH so the tools the operating instructions name by
 * bare name — `mem` above all — actually resolve there. Without it a remote
 * employee is told to run `~/.jinn/bin/mem`, finds no `~/.jinn` on that host
 * (the farm is deliberately NOT called `.jinn`), and concludes the memory layer
 * does not exist for them: three review rounds recorded nothing.
 *
 * Taken from the home the caller was actually GIVEN by `prepareRemoteSession`,
 * not recomputed from the session id: the home is keyed on the engine as well
 * as the session, and a second derivation is a second chance to name a farm
 * that this spawn never staged — a PATH entry pointing at nothing, and `mem`
 * missing again with no error anywhere.
 */
export function remoteSessionBinDir(sessionHome: string): string {
  return path.posix.join(sessionHome, "bin");
}

/** Session ids are gateway-generated and already path-safe; this is here so a
 *  hand-crafted one can never walk out of the sessions directory. */
function safeSessionSegment(segment: string): string {
  const clean = String(segment).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!clean || clean === "." || clean === "..") throw new Error(`unusable session id for remote staging: "${segment}"`);
  return clean;
}

/** Stage the per-host assets. Driven by what the farm script actually observed
 *  on this spawn rather than by a process-lifetime cache: a stage directory
 *  wiped while the gateway keeps running would otherwise leave the relay
 *  missing and never restage it, which is a silent hang until the next
 *  restart. */
async function ensureAssets(destination: string, facts: RemoteFacts, present: Set<string>): Promise<void> {
  for (const name of HOST_ASSETS) {
    if (present.has(name)) continue;
    const content = fs.readFileSync(assetPath(name), "utf-8");
    await stageRemoteFile(destination, path.posix.join(facts.stageDir, name), content);
  }
}

/**
 * Dismiss Claude Code's first-run folder-trust dialog for `remoteCwd` on the
 * remote host.
 *
 * Not optional. The dialog does not match `parsePermissionPrompt`'s strict
 * "Do you want to proceed?" shape and fires no Notification hook, so without
 * this the first turn against a directory the remote Claude has not seen hangs
 * forever with nothing reported anywhere.
 */
/**
 * Cache key for a completed trust seed.
 *
 * The PROFILE is part of it, not just the directory. Trust is recorded in
 * `<profile>/.claude.json`, so a session that switches profiles faces a config
 * file that has never seen this directory — and a key blind to the profile
 * would report the seed already done and hand that session the hanging dialog.
 */
export function trustSeedKey(
  destination: string,
  remoteCwd: string,
  claudeConfigDir: string | undefined,
): string {
  return `${destination}:${claudeConfigDir ?? "-"}:${remoteCwd}`;
}

/**
 * The remote command that pre-trusts `remoteCwd`.
 *
 * `CLAUDE_CONFIG_DIR` must match what the SESSION runs with: the seeder resolves
 * `.claude.json` inside the config dir when the variable is set and beside
 * `$HOME` when it is not, so seeding under the wrong one is indistinguishable
 * from not seeding at all — the dialog still appears, and the turn still hangs.
 *
 * Pure and exported so that agreement is testable without a second machine.
 */
export function buildTrustSeedCommand(
  facts: RemoteFacts,
  remoteCwd: string,
  claudeConfigDir: string | undefined,
): string {
  const script = path.posix.join(facts.stageDir, "remote-trust-seed.mjs");
  const env = claudeConfigDir ? `CLAUDE_CONFIG_DIR=${shq(claudeConfigDir)} ` : "";
  return `mkdir -p ${shq(remoteCwd)} && ${env}${shq(facts.nodeBin)} ${shq(script)} ${shq(remoteCwd)}`;
}

async function seedRemoteTrust(
  destination: string,
  facts: RemoteFacts,
  remoteCwd: string,
  claudeConfigDir: string | undefined,
): Promise<void> {
  // The profile is part of the key, not just the directory. Trust is recorded
  // in `<profile>/.claude.json`, so a session that switches profiles is facing
  // a config file that has never seen this directory — and a cache keyed on the
  // directory alone would skip the seed and hand it the hanging trust dialog.
  const key = trustSeedKey(destination, remoteCwd, claudeConfigDir);
  if (seededTrust.has(key)) return;
  const res = await sshRun(destination, [buildTrustSeedCommand(facts, remoteCwd, claudeConfigDir)]);
  if (res.code !== 0) {
    throw new Error(
      `could not pre-trust ${remoteCwd} on ${destination}: ${res.stderr.trim() || `exit ${res.code}`} `
      + `— the first turn would hang on Claude Code's folder-trust dialog`,
    );
  }
  logger.info(
    `remote: trust seeded for ${remoteCwd} on ${destination}`
    + `${claudeConfigDir ? ` (profile ${claudeConfigDir})` : ""} (${res.stdout.trim()})`,
  );
  seededTrust.add(key);
}

export const FARM_SCRIPT = `
set -eu
mount=$1
root=$2
home=$3
ttl=$4
cwd=\${5:-}
mkdir -p "$root" "$root/sessions" "$home" "$home/tmp"
chmod 700 "$root" "$root/sessions" "$home"
# Reap dead session stages. Every spawn rewrites its own session's gateway.json,
# so a live session's directory is never older than its last turn.
find "$root/sessions" -mindepth 1 -maxdepth 1 -type d -mtime +"$ttl" -exec rm -rf {} + 2>/dev/null || true
# One rebuild of a session's home at a time. Two can be started together, and
# the cleanup below deletes links while the other run's ln is creating them: a
# run fails on EEXIST/ENOENT or leaves an entry unlinked. mkdir is the lock
# because it is atomic everywhere (flock is not on every host); the holder
# records when it took it. A rebuild takes well under a second, so a lock held
# for 20s belongs to a run that died and is broken (a lock with no time yet is
# judged by the directory's age instead). Waiters give up after about 40s,
# inside the gateway's 60s control timeout, so the error is seen. Two waiters
# breaking the same stale lock at once can both proceed: no worse than before
# the lock, and it needs a dead run to begin with.
lock="$home.farm-lock"
tries=0
until mkdir "$lock" 2>/dev/null; do
  took=$(cat "$lock/taken" 2>/dev/null || true)
  case "$took" in ''|*[!0-9]*) took= ;; esac
  if { [ -n "$took" ] && [ $(( $(date +%s) - took )) -gt 20 ]; } \\
    || [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    rm -f "$lock/taken"
    rmdir "$lock" 2>/dev/null || true
    continue
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 800 ]; then
    echo "remote stage: another rebuild of $home has held $lock for too long" >&2
    exit 1
  fi
  sleep 0.05 2>/dev/null || sleep 1
done
date +%s > "$lock/taken"
trap 'rm -f "$lock/taken"; rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
# Drop every symlink first so an entry removed from the gateway's home does not
# linger here as a dangling one. gateway.json, tmp/ and the filtered directories
# below are real, not symlinks, so they are untouched by this. (A stage built
# before the filtered directories existed linked sessions/ whole; that link goes
# here, and the directory is rebuilt as a real one below.)
find "$home" -maxdepth 1 -type l -exec rm -f {} + 2>/dev/null || true
# Marks this as a remote session's stage, so Marid code started here refuses to
# start a gateway or open a database (shared/local-db-guard.ts).
printf 'remote session stage: linked entries lead to the gateway home\\n' > "$home/${REMOTE_STAGE_MARKER}"
for entry in "$mount"/* "$mount"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  case "$name" in
    gateway.json|tmp|${REMOTE_STAGE_MARKER}|${FARM_FILTERED_DIRS.join("|")}) continue ;;
  esac
  ln -sfn "$entry" "$home/$name"
done
# The directories that hold the gateway's SQLite databases are real directories
# here, linked entry by entry WITHOUT the database files. A WAL database opened
# from this host through sshfs is corrupted by the open itself, read-only or
# not: this host's locks are invisible to the gateway. Each database the gateway
# has is a DIRECTORY here, so a stray open fails instead of creating an empty
# local database that remote code would read as real. backups/ holds database
# snapshots and is left out too. Keep the patterns in step with
# shared/remote-farm.ts.
for dir in ${FARM_FILTERED_DIRS.join(" ")}; do
  [ -d "$mount/$dir" ] || continue
  # Never work THROUGH a link here: if a leftover link to the gateway's own
  # directory survived the cleanup above, chmod and ln would land on the
  # gateway. Remove it, and refuse outright if a real directory is not what
  # we end up with.
  [ ! -L "$home/$dir" ] || rm -f "$home/$dir"
  mkdir -p "$home/$dir"
  if [ -L "$home/$dir" ] || [ ! -d "$home/$dir" ]; then
    echo "remote stage: $home/$dir is not a real directory; refusing to stage it" >&2
    exit 1
  fi
  chmod 700 "$home/$dir"
  find "$home/$dir" -mindepth 1 -maxdepth 1 -type l -exec rm -f {} + 2>/dev/null || true
  find "$home/$dir" -mindepth 1 -maxdepth 1 -type f \\( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.db-journal' \\) -exec rm -f {} + 2>/dev/null || true
  for entry in "$mount/$dir"/* "$mount/$dir"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      backups|*.db|*.db-wal|*.db-shm|*.db-journal) continue ;;
    esac
    ln -sfn "$entry" "$home/$dir/$name"
  done
  for db in "$mount/$dir"/*.db; do
    [ -e "$db" ] || continue
    name=$(basename "$db")
    mkdir -p "$home/$dir/$name"
  done
done
# The company's operating rules, where the SESSION will actually look for them.
# A local employee gets these free: its cwd IS the gateway home, so Claude Code
# reads CLAUDE.md from it. A remote session's cwd is the workspace instead, so
# without this the rules are simply absent.
#
# Two guards, because this writes into a directory the operator owns:
#   - never replace an existing CLAUDE.md — it may be a repo's own, or theirs;
#   - never touch a git working tree. A workspace root holds repos in
#     subfolders and has no .git; a checkout does. Dropping an untracked file
#     into someone's repo would show up in git status and die to git clean -fdx.
if [ -n "$cwd" ] && [ -d "$mount" ] && [ -f "$mount/CLAUDE.md" ]; then
  mkdir -p "$cwd"
  if [ ! -e "$cwd/.git" ] && { [ ! -e "$cwd/CLAUDE.md" ] || [ -L "$cwd/CLAUDE.md" ]; }; then
    # Sessions sharing this cwd hold different locks, so their links can race;
    # the result is the same link either way.
    ln -sfn "$mount/CLAUDE.md" "$cwd/CLAUDE.md" 2>/dev/null \\
      || [ "$(readlink "$cwd/CLAUDE.md" 2>/dev/null)" = "$mount/CLAUDE.md" ] \\
      || ln -sfn "$mount/CLAUDE.md" "$cwd/CLAUDE.md"
    printf 'claudemd=linked\n'
  else
    printf 'claudemd=skipped\n'
  fi
fi
# Report which per-host assets are really there. Free — this round trip is
# already happening — and it is what lets a wiped stage restage itself instead
# of relying on a cache that outlives the directory it describes.
for a in hook-relay.mjs remote-trust-seed.mjs; do
  if [ -f "$root/$a" ] && [ ! -L "$root/$a" ]; then printf 'asset=%s\\n' "$a"; fi
done
`;

/**
 * Rebuild ONE session's `$JINN_HOME` as a symlink farm over the mounted gateway
 * home, so the session reads and writes the org's REAL knowledge, docs, org and
 * skills rather than copies. Also reaps dead session stages and reports which
 * per-host assets are genuinely present.
 *
 * Some entries are deliberately excluded and staged for real instead:
 *  - `gateway.json`, because the mounted one names the gateway's own port,
 *    which on this host would point the hook relay at the wrong process.
 *  - `tmp/`, because per-session settings and MCP configs churn there and a
 *    network filesystem is the wrong place for it.
 *  - `sessions/` and `workflows/` (FARM_FILTERED_DIRS), which are real
 *    directories linking every entry except the SQLite databases, their
 *    sidecars and `backups/`. A WAL database opened from this host through
 *    the mount is corrupted by the open, so each database is a directory
 *    here and any open of it fails (shared/remote-farm.ts).
 *  - `.jinn-remote-stage` (REMOTE_STAGE_MARKER), a real file that tells Marid
 *    code started inside the session that this home is not one to start a
 *    gateway or open a database from.
 *
 * Rebuilt every spawn rather than once: that is what keeps the farm honest when
 * the gateway's home gains a new top-level directory.
 */
export async function rebuildHomeFarm(
  destination: string,
  facts: RemoteFacts,
  mount: string,
  sessionHome: string,
  /** The session's working directory. Given so the company's CLAUDE.md can be
   *  linked where the session will look for it — guarded so it never lands
   *  inside a git working tree or over a real file. */
  remoteCwd?: string,
): Promise<Set<string>> {
  const res = await sshScript(destination, FARM_SCRIPT, [
    mount,
    facts.stageDir,
    sessionHome,
    String(SESSION_STAGE_TTL_DAYS),
    remoteCwd ?? "",
  ]);
  if (res.stdout.includes("claudemd=skipped")) {
    logger.info(`remote: left ${remoteCwd}/CLAUDE.md alone on ${destination} (a real file, or a git working tree)`);
  }
  if (res.code !== 0) {
    throw new Error(`could not build the remote JINN_HOME farm on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const present = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const value = line.trim();
    if (value.startsWith("asset=")) present.add(value.slice("asset=".length));
  }
  return present;
}

/** Ask the remote host for a free TCP port on its loopback.
 *  Used as the listen end of the reverse tunnel. There is a small window in
 *  which something else could take it, which is exactly why the session is
 *  spawned with `ExitOnForwardFailure=yes` — a lost race becomes a fast, loud
 *  exit rather than a session whose hooks silently never arrive. */
export async function probeFreePort(destination: string, facts: RemoteFacts): Promise<number> {
  const script = `const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()});`;
  const res = await sshRun(destination, [`${shq(facts.nodeBin)} -e ${shq(script)}`]);
  const port = Number.parseInt(res.stdout.trim(), 10);
  if (res.code !== 0 || !Number.isInteger(port) || port <= 0) {
    throw new Error(`could not allocate a tunnel port on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return port;
}

// ── Per-session staging ──────────────────────────────────────────────────────

export interface PrepareRemoteSessionOpts {
  /** A scoped session's carries its department, and its stage directory as `remoteCwd`. */
  target: SessionRemoteTarget;
  remote: RemoteExecutionConfig;
  facts: RemoteFacts;
  /** Which agent runs there. The two need different things staged, and staging
   *  the other one's is not free: Claude's settings.json registers seven hooks
   *  against a relay Pi never invokes, and the folder-trust seed rewrites the
   *  remote user's `.claude.json` — a real side effect on a host that may have
   *  no Claude Code on it at all. */
  engine: RemoteEngineName;
  jinnSessionId: string;
  /** Gateway port the reverse tunnel forwards to. */
  gatewayPort: number;
  /** Resolved MCP set for this session, if any. Remapped for the remote install. */
  resolvedMcp?: ResolvedMcpConfig;
  /** Further exports for the session's 0600 env file. The opencode server mode
   *  passes its server password here, so every ssh that sources the file — the
   *  server and the terminal view's `opencode attach` — can
   *  authenticate without the secret ever reaching a remote command line. Pi's
   *  own belt is computed below and ignores this. */
  sessionEnv?: Record<string, string>;
}

interface RemoteSessionStagingBase {
  destination: string;
  tunnelPort: number;
  /** This session's own `$JINN_HOME` on the remote host. */
  sessionHome: string;
  /** 0600 shell fragment the remote command sources for the session's secrets.
   *  A file rather than argv: everything on a remote command line is world-
   *  readable in that host's process table. */
  envFilePath: string;
}

export interface RemoteClaudeStaging extends RemoteSessionStagingBase {
  engine: "claude";
  /** Remote path for `--settings`. */
  settingsPath: string;
  /** Remote path for `--mcp-config`, when this session has MCP servers. */
  mcpConfigPath?: string;
}

export interface RemotePiStaging extends RemoteSessionStagingBase {
  engine: "pi";
  /** Remote path for `--session-dir`. A REAL directory under the session stage,
   *  never a symlink through the mount: Pi writes its conversation state here on
   *  every turn, and `--resume` across turns depends on it still being there —
   *  which is exactly what a network filesystem cannot promise. */
  piSessionDir: string;
  /** Remote path for `--extension`, when the jinn toolset could be wired.
   *  Undefined when this session carries no built-in `jinn` server, which is the
   *  same condition the local path treats as "run without the belt". */
  piExtensionPath?: string;
}

export interface RemoteOpencodeStaging extends RemoteSessionStagingBase {
  engine: "opencode";
  /** Remote path for `OPENCODE_CONFIG`, when this session has MCP servers
   *  opencode can run. Undefined when it carries none — opencode's own config on
   *  that host is then left entirely alone, which is the same condition the
   *  local path treats as "run without the belt".
   *
   *  Note what is NOT staged: opencode's data directory. Its session store and
   *  its `auth.json` sit side by side under the remote user's home, so moving
   *  the store would take the login with it and every turn would start
   *  unauthenticated. opencode generates its own session ids, so sessions
   *  sharing that one store cannot collide the way pi's would. */
  opencodeConfigPath?: string;
}

export type RemoteSessionStaging = RemoteClaudeStaging | RemotePiStaging | RemoteOpencodeStaging;

/**
 * Stage everything one remote session needs and return the remote paths its
 * argv must reference.
 *
 * Ordering matters: the farm is rebuilt before anything is written into the
 * stage directory, and Claude's trust seed runs before the session is ever
 * spawned.
 */
export async function prepareRemoteSession(opts: PrepareRemoteSessionOpts & { engine: "claude" }): Promise<RemoteClaudeStaging>;
export async function prepareRemoteSession(opts: PrepareRemoteSessionOpts & { engine: "pi" }): Promise<RemotePiStaging>;
export async function prepareRemoteSession(opts: PrepareRemoteSessionOpts & { engine: "opencode" }): Promise<RemoteOpencodeStaging>;
export async function prepareRemoteSession(opts: PrepareRemoteSessionOpts): Promise<RemoteSessionStaging> {
  const { target, remote, facts, jinnSessionId, engine } = opts;
  assertRemoteTarget(target, remote);
  const destination = sshDestination(target);
  const sessionHome = remoteSessionHome(facts, jinnSessionId, engine);
  // Refused here, before anything is written, if it cannot be staged in scope.
  const department = scopedRemoteDepartment(target, remote, facts, engine);
  if (department) await assertRemoteClaudeSkipsAncestors(destination, facts);
  // The caller resolved this set already confined; staging confines it again, so no
  // other server's spec (and the credentials it carries) is written to a scoped stage.
  const resolvedMcp = confineMcpToDepartment(opts.resolvedMcp, department);
  const realStageDir = await stageHostState(opts, destination, sessionHome, department);

  const tunnelPort = await probeFreePort(destination, facts);

  await stageGatewayJson(destination, sessionHome, tunnelPort);
  // The session identity pi's extension reads. Staged into the 0600 file rather
  // than the remote command line for the same reason the bearer is.
  const envFilePath = await stageSessionEnvFile(
    destination,
    sessionHome,
    tunnelPort,
    engine === "pi" ? piJinnSessionEnv(resolvedMcp) : { ...opts.sessionEnv, ...remoteDepartmentEnv(department) },
  );
  const base = { destination, tunnelPort, sessionHome, envFilePath };

  if (engine === "pi") {
    const piSessionDir = await stagePiSessionDir(destination, sessionHome);
    const piExtensionPath = await stagePiExtension(destination, facts, sessionHome, jinnSessionId, resolvedMcp);
    return { ...base, engine, piSessionDir, ...(piExtensionPath ? { piExtensionPath } : {}) };
  }

  if (engine === "opencode") {
    const opencodeConfigPath = await stageOpencodeConfig(destination, facts, sessionHome, tunnelPort, resolvedMcp);
    return { ...base, engine, ...(opencodeConfigPath ? { opencodeConfigPath } : {}) };
  }

  // A scoped session skips every CLAUDE.md above its stage directory (`ancestorMemoryExcludes`).
  const excludes = department ? { claudeMdExcludes: ancestorMemoryExcludes([target.remoteCwd!, realStageDir!]) } : undefined;
  const settingsPath = await stageSettings(destination, facts, sessionHome, jinnSessionId, excludes);
  const mcp = { resolved: resolvedMcp, departmentFileRoots: remoteDepartmentFileRoots(target) };
  const mcpConfigPath = await stageMcpConfig(destination, facts, sessionHome, tunnelPort, mcp);
  return { ...base, engine, settingsPath, ...(mcpConfigPath ? { mcpConfigPath } : {}) };
}

/**
 * The steps that touch per-HOST state, serialized; everything else writes inside the
 * session's own directory and cannot collide. A scoped session gets a home with no farm,
 * then its department's stage directory is synced, before the trust seed's `mkdir -p`
 * could create it empty. Returns a scoped session's stage directory as the host resolves it.
 */
async function stageHostState(opts: PrepareRemoteSessionOpts, destination: string, sessionHome: string, department: string | undefined): Promise<string | undefined> {
  const { target, remote, facts, engine } = opts;
  return await serializePerHost(destination, async () => {
    const present = department
      ? await rebuildScopedHome(destination, facts, sessionHome, SESSION_STAGE_TTL_DAYS, target.remoteWorkArea)
      : await rebuildHomeFarm(destination, facts, remote.mount, sessionHome, target.remoteCwd);
    await ensureAssets(destination, facts, present);
    const realStageDir = department ? await syncRemoteDepartmentStage(destination, facts, remote, department) : undefined;
    // Claude Code's folder-trust dialog is the thing being pre-empted here, and
    // it is Claude Code's alone: `pi -p` reads its prompt from stdin and prints
    // JSON, with no first-run dialog to hang on and no `.claude.json` to write.
    if (engine === "claude") {
      await seedRemoteTrust(destination, facts, target.remoteCwd!, resolveRemoteClaudeConfigDir(target, remote));
    }
    return realStageDir;
  });
}

/**
 * The trimmed `gateway.json` the remote side reads.
 *
 * It carries the TUNNEL port, the hook secret, and the API bearer — the last
 * because the built-in jinn MCP server resolves its bearer from
 * `<JINN_HOME>/gateway.json` (`mcp/server.ts` `resolveServerToken`), which is
 * the same 0600 same-uid file mechanism it uses locally, just on a second host.
 *
 * Nothing else from the real file travels: `pid`, `ptyPids`, `host` and `url`
 * all describe the gateway's own process and would only mislead a reader here.
 */
async function stageGatewayJson(destination: string, sessionHome: string, tunnelPort: number): Promise<void> {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  if (!info?.secret) throw new Error("the gateway has no hook secret yet — is the daemon fully started?");
  await stageRemoteFile(
    destination,
    path.posix.join(sessionHome, "gateway.json"),
    `${JSON.stringify({ port: tunnelPort, secret: info.secret, ...(info.token ? { token: info.token } : {}) }, null, 2)}\n`,
  );
}

/**
 * The session's `JINN_GATEWAY_URL` / `JINN_GATEWAY_TOKEN`, as a sourceable
 * shell fragment.
 *
 * The gateway exports both onto its own process env at boot, so a LOCAL session
 * inherits them and the system prompt can promise they are "already exported in
 * your environment" — which every documented curl in that prompt then uses:
 * delegation, following up on a child, reading a child's replies, pushing an
 * attachment, sending on a connector. A remote session inherits nothing from
 * the gateway process, so without this the whole set is dead there, and the URL
 * would in any case have to name the tunnel rather than the gateway's own port.
 *
 * A 0600 file rather than argv or `env K=V`: a remote command line is visible
 * to every process on that host, and the bearer token is not something to put
 * in a process table.
 */
async function stageSessionEnvFile(
  destination: string,
  sessionHome: string,
  tunnelPort: number,
  /** Further exports for this session's identity. Pi's belt travels here rather
   *  than in the remote command, because `JINN_SESSION_CAPABILITY` authorizes
   *  acting AS this session against the gateway and every remote command line is
   *  readable in that host's process table. Claude's equivalent rides inside the
   *  0600 staged mcp.json; this file is the same protection for an engine that
   *  has no such file. */
  extraExports: Record<string, string> = {},
): Promise<string> {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  const envFilePath = path.posix.join(sessionHome, "tmp", "session-env.sh");
  await stageRemoteFile(destination, envFilePath, buildSessionEnvFile(tunnelPort, info?.token, extraExports));
  return envFilePath;
}

/** The sourceable fragment itself. Pure, and exported, so which values land in a
 *  0600 file rather than on a world-readable command line is a testable claim
 *  rather than an assertion about a function that needs two machines to run. */
export function buildSessionEnvFile(
  tunnelPort: number,
  token: string | undefined,
  extraExports: Record<string, string> = {},
): string {
  const lines = [`export JINN_GATEWAY_URL=${shq(`http://127.0.0.1:${tunnelPort}`)}`];
  if (token) lines.push(`export JINN_GATEWAY_TOKEN=${shq(token)}`);
  for (const [key, value] of Object.entries(extraExports)) lines.push(`export ${key}=${shq(value)}`);
  return `${lines.join("\n")}\n`;
}

/** Reuse the real settings builder rather than reimplementing the hook set — it
 *  is the single source of truth for WHICH hooks a session registers, and a
 *  remote session must register exactly the same seven. */
async function stageSettings(
  destination: string,
  facts: RemoteFacts,
  sessionHome: string,
  jinnSessionId: string,
  /** Keys a scoped session adds (`claudeMdExcludes`). */
  extra: Record<string, unknown> = {},
): Promise<string> {
  const settingsPath = path.posix.join(sessionHome, "tmp", "settings.json");
  const settings = buildSessionSettings({
    sessionId: jinnSessionId,
    relayScript: remoteRelayScript(facts),
    // No statusLineDir: the recorder would write engine-limit JSON the gateway
    // cannot read from here. `claudeResetsAtSeconds()` simply returns undefined,
    // which the retry path already handles.
  });
  await stageRemoteFile(destination, settingsPath, `${JSON.stringify({ ...settings, ...extra }, null, 2)}\n`);
  return settingsPath;
}

/** Rewrite the resolved MCP set for the remote install and stage it.
 *  Every server spec — the builtin AND every scrub-wrapped third party — names
 *  the gateway's own node and dist paths, so a config staged verbatim would
 *  point the remote claude at binaries that do not exist there. */
async function stageMcpConfig(
  destination: string,
  facts: RemoteFacts,
  sessionHome: string,
  tunnelPort: number,
  /** The resolved set, and a scoped session's FR-065 roots on this host. */
  { resolved: resolvedMcp, departmentFileRoots }: { resolved: ResolvedMcpConfig | undefined; departmentFileRoots: string[] },
): Promise<string | undefined> {
  if (!resolvedMcp || Object.keys(resolvedMcp.mcpServers ?? {}).length === 0) return undefined;
  const remapped = remapMcpConfigForRemote(resolvedMcp, {
    remoteNode: facts.nodeBin,
    remoteEntryDir: facts.entryDir,
    remoteHome: sessionHome,
    gatewayUrl: `http://127.0.0.1:${tunnelPort}`,
    departmentFileRoots,
  });
  const mcpConfigPath = path.posix.join(sessionHome, "tmp", "mcp.json");
  await stageRemoteFile(destination, mcpConfigPath, `${JSON.stringify(remapped, null, 2)}\n`);
  return mcpConfigPath;
}

/**
 * Create this session's Pi state directory on the remote host.
 *
 * Pi keys a conversation on `--session-id` inside `--session-dir`, so this
 * directory IS the session's `--resume`: lose it between turns and pi silently
 * starts a new conversation with no memory of the last one. It therefore lives
 * in the real, per-session part of the stage — beside `tmp/`, never in the
 * symlink farm, where it would be written across sshfs into the gateway's own
 * home and disappear from pi's view the moment the mount blipped.
 *
 * Created here rather than left to pi: the local engine already pre-creates it
 * (`pi.ts` mkdirSync) because a missing session dir is not something pi's own
 * error output explains well.
 */
async function stagePiSessionDir(destination: string, sessionHome: string): Promise<string> {
  const dir = path.posix.join(sessionHome, "pi-session");
  const res = await sshRun(destination, [`mkdir -p ${shq(dir)} && chmod 700 ${shq(dir)}`]);
  if (res.code !== 0) {
    throw new Error(`could not create the remote pi session dir ${dir} on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return dir;
}

/**
 * Stage the `OPENCODE_CONFIG` file carrying this session's toolset.
 *
 * The cheapest wiring of the three engines, because opencode reads a real MCP
 * config: the already-resolved set is re-pointed at the remote install exactly
 * as Claude's is, then projected into opencode's own `mcp` shape. Nothing about
 * the servers themselves changes — same node, same entry scripts, same bearer
 * out of `<JINN_HOME>/gateway.json` over the same reverse tunnel.
 *
 * 0600, because the projected `environment` carries this session's capability:
 * anything on a remote command line is readable by every process on that host,
 * and this file is how it stays off one.
 */
async function stageOpencodeConfig(
  destination: string,
  facts: RemoteFacts,
  sessionHome: string,
  tunnelPort: number,
  resolvedMcp: ResolvedMcpConfig | undefined,
): Promise<string | undefined> {
  if (!resolvedMcp || Object.keys(resolvedMcp.mcpServers ?? {}).length === 0) return undefined;
  const remapped = remapMcpConfigForRemote(resolvedMcp, {
    remoteNode: facts.nodeBin,
    remoteEntryDir: facts.entryDir,
    remoteHome: sessionHome,
    gatewayUrl: `http://127.0.0.1:${tunnelPort}`,
  });
  const config = buildOpencodeSessionConfig(remapped);
  if (!config) return undefined;
  const configPath = path.posix.join(sessionHome, "tmp", "opencode.json");
  await stageRemoteFile(destination, configPath, serializeOpencodeSessionConfig(config));
  return configPath;
}

/**
 * Stage pi's generated `jinn` extension, re-pointed at the REMOTE install.
 *
 * Pi does not read an `--mcp-config`; it loads the company toolset from a
 * generated module that runs the built-in stdio server in-process
 * (`pi-mcp.ts`). That module's two imports are absolute paths to the GATEWAY's
 * `dist` — nothing on the other host — so the remote copy is regenerated
 * against `facts.entryDir` instead. Everything else the tools need travels the
 * way it does for Claude: the bearer and the gateway URL through the 0600 env
 * file, over the same reverse tunnel.
 */
async function stagePiExtension(
  destination: string,
  facts: RemoteFacts,
  sessionHome: string,
  jinnSessionId: string,
  resolvedMcp: ResolvedMcpConfig | undefined,
): Promise<string | undefined> {
  if (!piJinnMcpAttachable(resolvedMcp, jinnSessionId)) return undefined;
  const extensionPath = path.posix.join(sessionHome, "tmp", "pi-mcp", "jinn-mcp-extension.ts");
  await stageRemoteFile(destination, extensionPath, remotePiExtensionSource(facts.entryDir));
  return extensionPath;
}

// ── The interactive spawn ────────────────────────────────────────────────────

export interface SshSpawnOpts {
  destination: string;
  tunnelPort: number;
  gatewayPort: number;
  remoteCwd: string;
  /** Environment for the REMOTE claude process. `env` passed to pty.spawn only
   *  reaches the local ssh client, so anything the engine needs is inlined into
   *  the remote command instead. */
  remoteEnv: Record<string, string>;
  /** Variables to REMOVE from the remote login environment before exec.
   *  Load-bearing for billing: an `ANTHROPIC_API_KEY` sitting in the remote
   *  user's shell profile would flip the session from Max-subscription auth to
   *  metered API billing, silently. The local path denies the same three from
   *  inheritance (`buildPtyEnv`); `env -u` is how that reaches another host. */
  unsetRemoteEnv?: string[];
  /** Directories prepended to the remote PATH.
   *
   *  Critical, not cosmetic: Claude Code invokes every hook as bare `node`
   *  (`buildSessionSettings`), and a hook runs in the claude process's own
   *  environment. On a host whose Node comes from a version manager, the
   *  non-interactive PATH we inherit has no `node` at all — so every hook would
   *  fail to execute, no Stop would ever arrive, and the turn would hang
   *  forever with nothing reported. Putting the resolved node directory here is
   *  what makes the relay runnable. */
  pathPrepend?: string[];
  /** 0600 shell fragment sourced before exec, carrying the session's secrets.
   *  Sourced rather than inlined because a remote command line is readable by
   *  every process on that host. */
  envFile?: string;
  /** The agent CLI ON THE REMOTE host, and its argv. Not "claude": the same
   *  transport carries `pi` for a Pi employee, and the only difference between
   *  the two commands is this pair plus {@link allocateTty}. */
  bin: string;
  args: string[];
  /**
   * Remote file the agent's pid is written to before `exec`, so the gateway can
   * kill the agent by name later ({@link killRemoteEngine}). `$$` is the remote
   * shell's pid and `exec` hands that pid to the agent, so what lands in the
   * file IS the agent's pid, with no wrapper process in between. A second line
   * carries the process's start time (`ps -o lstart=`), which exec preserves:
   * that is what the kill checks the pid against, since argv is whatever the
   * agent's installer made it (a pnpm shim exec's `node …/cli.js`) and a pid
   * can be recycled.
   *
   * Required for a batch engine (`allocateTty: false`), and this is why:
   * killing the local ssh client only closes the channel, and sshd does not
   * signal a command that has no tty — its pipes go dead, and a process that
   * ignores EPIPE (opencode does) simply carries on. Verified on a real host:
   * an interrupted remote opencode ran on for 18 minutes past its "kill" and
   * committed into the worktree its successor had already been resumed on
   *. With a tty (`-tt`) the hangup reaches the agent as SIGHUP, so the
   * interactive engine does not need this.
   */
  pidFile?: string;
  /**
   * Whether ssh allocates a remote pseudo-terminal (`-tt`), the default.
   *
   * True for Claude Code, whose TUI needs one. FALSE for pi, and not as a
   * preference: a tty is a single byte stream, so the remote process's stderr
   * is folded into stdout and its diagnostics land in the middle of the
   * newline-delimited JSON the engine parses — the run's real error then reads
   * as an unparseable line and is dropped. Without a tty the two streams stay
   * separate, stdin is a clean pipe for the prompt, and the JSON arrives intact.
   */
  allocateTty?: boolean;
  /**
   * Whether to open the reverse tunnel (`-R tunnelPort:…:gatewayPort`), the
   * default. Only one ssh per session may hold it — `ExitOnForwardFailure`
   * turns a second bind of the same port into an immediate exit — so the
   * opencode server mode opens it on the long-lived `opencode serve` connection
   * (whose MCP servers need it) and passes `false` for the terminal view,
   * which does not talk to the gateway.
   */
  reverseTunnel?: boolean;
  /**
   * Local forwards (`-L localPort:127.0.0.1:remotePort`), so the gateway can
   * reach a loopback-only service on the remote host — the opencode server's
   * HTTP API, which is how an interrupt aborts a turn over there. Bound on the
   * gateway's loopback only.
   */
  localForwards?: Array<{ localPort: number; remotePort: number }>;
}

/**
 * Build the argv for the interactive `ssh` that carries the session.
 *
 * The flags are all load-bearing:
 *  - `-tt` forces remote PTY allocation. Passing an explicit remote command
 *    makes ssh default to NO pty, which breaks the TUI outright and with it the
 *    viewport parser that answers Claude Code's safety prompts. A batch engine
 *    passes `allocateTty: false` and gets `-T` instead — see that field.
 *  - `BatchMode=yes` keeps this key-only; there is nobody at the keyboard.
 *  - `EscapeChar=none` disables ssh's own `~`-prefixed escapes, which are
 *    otherwise live on the local PTY and could fire on transcript or paste
 *    content. Costs nothing — this is not an interactive human session.
 *  - `ExitOnForwardFailure=yes` is the important one: if the probed port was
 *    taken between probe and spawn, ssh exits immediately instead of running a
 *    session whose hooks and MCP calls can never reach the gateway. That turns
 *    a silent permanent hang — the worst failure for an unattended turn — into
 *    a fast exit the PTY watchdog already knows how to settle.
 */
export function buildSshSpawnArgs(opts: SshSpawnOpts): string[] {
  const unset = (opts.unsetRemoteEnv ?? []).flatMap((key) => ["-u", key]).map(shq).join(" ");
  // The one env entry that is NOT fully quoted: `"$PATH"` has to be expanded by
  // the remote shell so the prepended directories are added to whatever that
  // host's PATH already is, rather than replacing it. Each prepended directory
  // is still quoted individually, and `"$PATH"` is quoted so a directory
  // containing spaces survives on either side.
  const pathEntry = opts.pathPrepend?.length
    ? `PATH=${opts.pathPrepend.map(shq).join(":")}:"$PATH" `
    : "";
  const env = Object.entries(opts.remoteEnv)
    .map(([key, value]) => `${key}=${shq(value)}`)
    .join(" ");
  const agent = [opts.bin, ...opts.args].map(shq).join(" ");
  // Sourced BEFORE `env`, so the exported values are inherited through it while
  // `env -u` still strips the billing-critical names from the login profile.
  const source = opts.envFile ? `. ${shq(opts.envFile)} && ` : "";
  // The shell's own pid, which `exec` below hands to the agent, and its start
  // time, which exec preserves and no recycled pid can reproduce. Written
  // before the exec because there is no shell left afterwards to write it.
  const recordPid = opts.pidFile
    ? `printf '%s\\n%s\\n' "$$" "$(ps -o lstart= -p $$ 2>/dev/null)" > ${shq(opts.pidFile)} && `
    : "";
  // `exec` so the remote shell is replaced by claude: one fewer process between
  // sshd and the TUI, so a dropped connection reaches claude directly.
  const remoteCommand = `cd ${shq(opts.remoteCwd)} && ${source}${recordPid}exec env ${unset ? `${unset} ` : ""}${pathEntry}${env} ${agent}`;
  return [
    opts.allocateTty === false ? "-T" : "-tt",
    "-o", "BatchMode=yes",
    "-o", "EscapeChar=none",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    ...(opts.reverseTunnel === false ? [] : ["-R", `${opts.tunnelPort}:127.0.0.1:${opts.gatewayPort}`]),
    ...(opts.localForwards ?? []).flatMap((f) => ["-L", `127.0.0.1:${f.localPort}:127.0.0.1:${f.remotePort}`]),
    // `--` first: without it a destination beginning with `-` is read by the
    // LOCAL ssh as an option (`-oProxyCommand=…` then runs ON THE GATEWAY —
    // verified against the real ssh). The host is charset-validated at config
    // load too; this is the belt to that's braces.
    "--",
    opts.destination,
    // NO second `--`. ssh's option parsing consumes the FIRST `--` it sees and
    // passes any later one through as part of the remote command, so with a
    // leading one already present the remote shell receives a command starting
    // `-- cd …` and answers `/bin/bash: --: invalid option`. Verified against a
    // real host: `ssh -- host -- cmd` fails, `ssh -- host cmd` works.
    remoteCommand,
  ];
}

// ── Killing the remote agent ─────────────────────────────────────────────────

/** Where a batch engine's remote turn records the agent's pid (see
 *  {@link SshSpawnOpts.pidFile}). Under `tmp/` beside the env file, which
 *  {@link prepareRemoteSession} has already created by the time the turn runs. */
export function remoteEnginePidFile(sessionHome: string): string {
  return path.posix.join(sessionHome, "tmp", "engine.pid");
}

/** Everything a kill needs to find the agent again on the other host. Captured
 *  at spawn time, because by the time an interrupt arrives the staging that
 *  produced these paths is long gone. */
export interface RemoteEngineHandle {
  destination: string;
  pidFile: string;
  /** The agent binary as it was exec'd — argv[0] on that host. A pid read from
   *  a file could have been recycled by the time we act on it, so the kill only
   *  proceeds when the process at that pid still looks like our agent. */
  bin: string;
}

export type RemoteKillOutcome =
  /** SIGTERM was enough. */
  | "terminated"
  /** It ignored SIGTERM for the grace period and was SIGKILLed. */
  | "killed"
  /** Nothing to do: no pid recorded, or the process was already gone. */
  | "already-gone"
  /** The pid is live but is not our agent any more — left alone. From a kill
   *  this is as bad as `unreachable`: an agent whose identity we could not
   *  confirm may still be running. */
  | "pid-reused"
  /** The control connection failed or timed out; the agent may still be running. */
  | "unreachable";

/** Grace between SIGTERM and SIGKILL on the remote host. opencode and pi both
 *  exit within a second of SIGTERM; the margin is for a host under load. */
const REMOTE_KILL_GRACE_S = 5;
/** Connect + grace + a margin. Bounded because the interrupted turn cannot
 *  settle until this returns, and a host that has gone away must not hold it. */
const REMOTE_KILL_TIMEOUT_MS = 25_000;

/**
 * The kill, as a POSIX script. $1 pid file, $2 the agent binary (the second
 * identity), $3 grace seconds. Prints one {@link RemoteKillOutcome} word, and
 * removes the pid file once the process it named is known to be gone — a file
 * left behind would name a dead pid until the next turn overwrote it, and a
 * kill that read it mid-spawn would believe the new agent already gone.
 *
 * It signals the agent's whole descendant TREE, not only its process group:
 * opencode starts every bash-tool command in a session of its own, so a
 * `pnpm test` it launched is in no group we could name from here, and
 * SIGTERM to opencode alone leaves that command running (verified on a real
 * host). The tree is captured BEFORE the first signal — once the agent dies
 * its children are re-parented to init and can no longer be found from it.
 */
export const REMOTE_KILL_SCRIPT = `
f=$1; ident=$2; grace=\${3:-5}
[ -f "$f" ] || { echo already-gone; exit 0; }
pid=$(sed -n 1p "$f" 2>/dev/null)
started=$(sed -n 2p "$f" 2>/dev/null)
case "$pid" in ''|*[!0-9]*) rm -f "$f"; echo already-gone; exit 0;; esac
kill -0 "$pid" 2>/dev/null || { rm -f "$f"; echo already-gone; exit 0; }
# Is the process at that pid still OURS? Yes if its start time is the one
# recorded — exec keeps it, a recycled pid cannot match it — OR if the agent's
# binary is in its argv. Either alone has a hole: a shim exec's node so argv
# never names the binary, and a clock step (chrony makestep after a resume)
# moves every start time ps reports. Fooling both takes a recycled pid running
# the same binary during a clock step.
now=$(ps -o lstart= -p "$pid" 2>/dev/null)
if [ -z "$started" ] || [ -z "$now" ] || [ "$started" != "$now" ]; then
  ps -o args= -p "$pid" 2>/dev/null | grep -F -q -- "$ident" || { rm -f "$f"; echo pid-reused; exit 0; }
fi
tree() {
  echo "$1"
  for c in $(ps -eo pid=,ppid= | awk -v p="$1" '$2 == p { print $1 }'); do tree "$c"; done
}
victims=$(tree "$pid")
signal_all() {
  for v in $victims; do
    kill -0 "$v" 2>/dev/null || continue
    kill "-$1" -- "-$v" 2>/dev/null || kill "-$1" "$v" 2>/dev/null
  done
}
signal_all TERM
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$grace" ]; do sleep 1; i=$((i + 1)); done
if kill -0 "$pid" 2>/dev/null; then signal_all KILL; echo killed; else signal_all KILL; echo terminated; fi
rm -f "$f"
`;

/**
 * Terminate a batch engine's remote agent, and everything it started.
 *
 * Runs ahead of the local ssh client's own kill: the client's process group is
 * only the client, and closing a no-tty channel signals nothing on the other
 * side (see {@link SshSpawnOpts.pidFile}). Never throws — the caller is in a
 * kill path, and the answer it needs is whether the agent is known to be gone.
 */
export async function killRemoteEngine(handle: RemoteEngineHandle): Promise<RemoteKillOutcome> {
  const res = await sshScript(
    handle.destination,
    REMOTE_KILL_SCRIPT,
    [handle.pidFile, handle.bin, String(REMOTE_KILL_GRACE_S)],
    { timeoutMs: REMOTE_KILL_TIMEOUT_MS, outliveGateway: true },
  );
  const word = res.stdout.trim().split(/\s+/).pop();
  if (res.code === 0 && (word === "terminated" || word === "killed" || word === "already-gone" || word === "pid-reused")) {
    return word;
  }
  logger.warn(
    `remote kill on ${handle.destination} did not complete (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim() || "no output"}`,
  );
  return "unreachable";
}

/**
 * Before a remote turn starts: make sure the previous turn's agent is gone.
 *
 * The session queue serialises turns, so a process still at the recorded pid
 * when the next turn is about to spawn is one that outlived its gateway turn —
 * a gateway that crashed rather than shut down never ran `killAll`, and the
 * restart-resume path would otherwise start a fresh turn beside the survivor.
 * Usually one cheap control connection answering `already-gone`; when it is
 * not, the log says what was found.
 */
export async function reapStaleRemoteEngine(handle: RemoteEngineHandle, engineName: string): Promise<void> {
  const outcome = await killRemoteEngine(handle);
  if (outcome === "terminated" || outcome === "killed") {
    logger.warn(
      `A previous turn's ${engineName} was still running on ${handle.destination} and was ${outcome} before this turn started; `
      + "it had outlived its gateway turn",
    );
  } else if (outcome === "unreachable") {
    logger.warn(`Could not check ${handle.destination} for a previous ${engineName} run before this turn; starting anyway`);
  }
}

/**
 * The remote kills one batch engine has in flight.
 *
 * Two jobs. It logs each outcome under the engine's name, and it keeps the
 * promises where a shutdown can find them: a run leaves the engine's live
 * table the moment its local client closes, which is BEFORE the control
 * connection that killed it reports back, so the engine's own table cannot be
 * what shutdown waits on.
 */
export class RemoteKills {
  private inFlight = new Set<Promise<RemoteKillOutcome>>();

  constructor(private readonly engineName: string) {}

  /**
   * End a run: the agent on the other host FIRST, then the process on this one.
   *
   * The order is the point. The turn settles when the local process closes,
   * and the session queue starts the next turn on that settle — so if the
   * local ssh client died first, the next turn would begin while the remote
   * agent was still editing the same worktree, which is exactly how 
   * was committed by a run the operator had already interrupted. Killing the
   * remote process first means the channel closes because the agent EXITED.
   * If the host cannot be reached the local client is killed anyway, with a
   * warning: an unreachable host is not a reason to leave the operator's
   * interrupt hanging. A local run is simply signalled.
   */
  terminate(run: RemoteRun, trackingId: string, signalLocal: () => void): void {
    if (!run.remote) {
      signalLocal();
      return;
    }
    // Already asked: the local signal is queued behind that kill, or the
    // client has closed since. A second control connection would find nothing.
    if (run.remoteKill) return;
    run.remoteKill = this.start(run.remote, trackingId);
    void run.remoteKill.finally(signalLocal);
  }

  /**
   * Before a remote run's turn may settle: be sure the agent is gone.
   *
   * `code` is the local client's exit status. Three cases matter:
   *  - a kill is in flight: wait for it. The client closing means the agent
   *    exited, but the script is still sweeping its descendants, and a tool
   *    child that ignored SIGTERM would otherwise outlive the settle by the
   *    grace period;
   *  - that kill found nothing to kill, yet the client closed on OUR signal
   *    (code null) rather than because the remote side ended: the interrupt
   *    landed while the turn was still connecting, before the pid file was
   *    written. Look again now that it is;
   *  - no kill was asked for and the client failed on its own (255): a
   *    dropped connection, with an agent over there that nobody signalled.
   *    (A host that is down at spawn pays one more connect timeout here
   *    before the turn's error surfaces; the readiness probe before every
   *    spawn makes that rare.)
   */
  async beforeSettle(run: RemoteRun, trackingId: string, code: number | null): Promise<void> {
    if (!run.remote) return;
    if (run.remoteKill) {
      const outcome = await run.remoteKill;
      if (code === null && (outcome === "already-gone" || outcome === "pid-reused")) {
        logger.info(`${this.engineName} session ${trackingId}: the kill found no remote process but the client was closed by our signal; checking again`);
        run.remoteKill = this.start(run.remote, trackingId);
        await run.remoteKill;
      }
      return;
    }
    if (code === SSH_CONNECTION_FAILED) {
      logger.warn(`ssh client for remote ${this.engineName} session ${trackingId} closed with ${code}; ensuring the remote process is gone before settling`);
      run.remoteKill = this.start(run.remote, trackingId);
      await run.remoteKill;
    }
  }

  /** Kill one run's remote agent. Resolves once the host has answered, or the
   *  attempt has been given up on; never rejects. */
  start(handle: RemoteEngineHandle, trackingId: string): Promise<RemoteKillOutcome> {
    const kill = killRemoteEngine(handle).then((outcome) => {
      if (outcome === "unreachable") {
        logger.warn(
          `Could not reach ${handle.destination} to kill the ${this.engineName} process for session ${trackingId}; `
          + "it may still be running there",
        );
      } else if (outcome === "pid-reused") {
        logger.warn(
          `The pid recorded for the ${this.engineName} process for session ${trackingId} on ${handle.destination} `
          + "no longer looks like ours and was left alone; if the agent is still running there, it was not killed",
        );
      } else {
        logger.info(`Remote ${this.engineName} process for session ${trackingId} on ${handle.destination}: ${outcome}`);
      }
      return outcome;
    });
    this.inFlight.add(kill);
    void kill.finally(() => this.inFlight.delete(kill));
    return kill;
  }

  /** Every kill still in flight, for a shutdown to wait on — bounded by the
   *  caller. The control connections are spawned to outlive this process, so a
   *  wait that runs out only stops the wait; the signal is still delivered. */
  pending(): Promise<unknown> {
    return Promise.allSettled([...this.inFlight]);
  }
}

/** ssh's own exit status when the CONNECTION failed, as opposed to the remote
 *  command's status passed through. A remote run whose client closed this way
 *  has lost its transport, not its agent — see {@link RemoteKills}. */
export const SSH_CONNECTION_FAILED = 255;

/** What {@link RemoteKills} needs to know about one live run: whether it is
 *  remote, and the kill already asked for, if any. Both engines' live-process
 *  records carry these two fields. */
export interface RemoteRun {
  remote?: RemoteEngineHandle;
  /** Memoised so a second request (an interrupt followed by shutdown) does not
   *  open a second control connection for the same process. */
  remoteKill?: Promise<RemoteKillOutcome>;
}

/** The directory holding the remote host's `node`.
 *
 *  Prepended to a remote session's PATH so Claude Code's hooks — invoked as
 *  bare `node` — can actually run. On a host using a version manager this
 *  directory is the ONLY place node exists, and a non-interactive ssh sees
 *  none of it. */
export function remoteNodeDir(facts: RemoteFacts): string {
  return path.posix.dirname(facts.nodeBin);
}
