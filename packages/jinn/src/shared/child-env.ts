import path from "node:path";
import { applyClaudeProfileEnv, type ClaudeProfile } from "./claude-profile.js";
import { envNamesFor } from "./codename-env.js";

export interface EngineChildEnvOptions {
  scrubClaudeCode?: boolean;
  scrubCodex?: boolean;
  /** Drop opencode's own session plumbing inherited from a parent process. A
   *  gateway started from inside an opencode session — or restarted as that
   *  session's child — carries the parent's `OPENCODE_CONFIG`, which names that
   *  OTHER session's staged config, plus its server password and pid; the
   *  opencode engine then hands a cross-session config to any turn that stages
   *  none of its own. */
  scrubOpencode?: boolean;
  denyExact?: Iterable<string>;
  /** A named Claude profile sets `CLAUDE_CONFIG_DIR` (claude-profile.ts); null/unset keeps today's env. */
  claudeProfile?: ClaudeProfile;
  /** A department-scoped session: keep only {@link isScopedSessionEnvName} variables, not the gateway's whole environment. */
  scopedSession?: boolean;
}

const ENGINE_CHILD_ENV_DENY_EXACT: ReadonlySet<string> = new Set(envNamesFor([
  "HOME_IDENTITY",
  "TAKE_PORT",
  // Per session, set by the engine; a gateway started from inside an employee's session must not hand its employee to others.
  "EMPLOYEE",
]));

/** The key variables of the declared opencode accounts (engines.opencode.accounts.*.keyEnv). A key reaches only the opencode
 *  processes that serve its account, and those add it back after this deny: every other child built here, claude, codex, pi,
 *  MCP and tool children included, never inherits one. Set when the config loads. */
let opencodeAccountKeyEnv: ReadonlySet<string> = new Set();

/** The account keys themselves, taken out of the gateway's own environment when the config loads (see below). */
const opencodeAccountKeys = new Map<string, string>();

/**
 * Replace the account key variables every child env drops (the config's, in full; an empty list clears them), and
 * move each one's value out of `env` (the gateway's own `process.env`) into this module. A key is then in no
 * environment the gateway passes on by default: every spawn site that hands down `process.env`, scrubbed or not,
 * leaves it out without having to know about accounts. Only the opencode launch paths read it back
 * ({@link opencodeAccountKeyEnvironment}), and the gateway's own successor gets it ({@link withOpencodeAccountKeys}).
 * A later reload keeps a key already taken, takes one a new account names if the environment still has it, and forgets
 * the key of an account the config no longer declares: it is not put back into `env`, so it reaches no process at all
 * (not an opencode one, not the gateway's successor, not a claude child).
 */
export function setOpencodeAccountKeyEnv(names: Iterable<string>, env: NodeJS.ProcessEnv = process.env): void {
  opencodeAccountKeyEnv = new Set(names);
  for (const name of [...opencodeAccountKeys.keys()]) {
    if (!opencodeAccountKeyEnv.has(name)) opencodeAccountKeys.delete(name);
  }
  for (const name of opencodeAccountKeyEnv) {
    const value = env[name];
    if (value === undefined) continue;
    if (value.trim() !== "") opencodeAccountKeys.set(name, value);
    delete env[name];
  }
}

/** `base` (the gateway's environment) with the account keys taken at config load laid over it: a key taken wins, any other variable reads as `base` has it. Only for the readers that hand a key to an opencode process or report whether one is set; never a child env as a whole. */
export function opencodeAccountKeyEnvironment(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...base };
  for (const [name, value] of opencodeAccountKeys) out[name] = value;
  return out;
}

/** `env` with the account keys the gateway took put back: for a gateway that starts its own successor (daemon start, restart), which reads them again at its own config load. */
export function withOpencodeAccountKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of opencodeAccountKeys) out[name] = value;
  return out;
}

/** Test seam: forget the keys taken and the variables denied. */
export function resetOpencodeAccountKeysForTest(): void {
  opencodeAccountKeys.clear();
  opencodeAccountKeyEnv = new Set();
}

/** Per-engine scrub rules. `exact` names and `prefix` families are stripped
 *  only when the caller turns that engine's option on. */
const ENGINE_SCRUB_RULES: ReadonlyArray<{
  option: "scrubClaudeCode" | "scrubCodex" | "scrubOpencode";
  exact: ReadonlyArray<string>;
  prefix: ReadonlyArray<string>;
}> = [
  { option: "scrubClaudeCode", exact: ["CLAUDECODE"], prefix: ["CLAUDE_CODE_"] },
  { option: "scrubCodex", exact: ["CODEX"], prefix: ["CODEX_"] },
  // Exact names, NOT the OPENCODE_* prefix: OPENCODE_CONFIG_DIR and
  // OPENCODE_DISABLE_* are operator settings that have to survive. The staged
  // config and the per-server password are set on the child after this scrub,
  // so they still win.
  {
    option: "scrubOpencode",
    exact: ["OPENCODE", "OPENCODE_PID", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG"],
    prefix: [],
  },
];

/**
 * What a department-scoped session's processes keep of the gateway's environment.
 *
 * The gateway's environment holds every credential the instance needs: config.yaml
 * refers to an MCP server's key as `${VAR}`, which resolves from it, and a service
 * unit may load a whole secrets directory into it. A scoped session may use only the
 * MCP servers its department allow-lists, and those reach it with their values already
 * resolved into its MCP config, so it inherits none of those variables, only these:
 * the login basics, locale, terminal and temp dirs, outbound proxy and CA settings,
 * Claude Code's own model and feature switches, and the Hundredfold variables its hooks and
 * `jinn` MCP server find the gateway with. Its own `JINN_SESSION_ID` and
 * `JINN_DEPARTMENT` and `JINN_EMPLOYEE` are set on top by the engine.
 *
 * This stops inheritance only. The session still runs as the gateway's OS user, so it
 * can read the gateway's own environment (`/proc/<pid>/environ`) and its files.
 *
 * Windows names are matched case-insensitively, as Windows itself does.
 */
const SCOPED_SESSION_ENV_EXACT: ReadonlySet<string> = new Set([
  // POSIX login
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TERM", "COLORTERM", "LANG", "LANGUAGE", "TZ",
  "TMPDIR", "TMP", "TEMP", "SSH_AUTH_SOCK",
  // Windows login
  "USERPROFILE", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  // Outbound network
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Claude Code (its CLAUDE_CODE_* switches are the engine's to set; its API key and base URL are never inherited)
  "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "MAX_THINKING_TOKENS", "MAX_MCP_OUTPUT_TOKENS", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT",
  "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "BASH_MAX_OUTPUT_LENGTH", "USE_BUILTIN_RIPGREP",
  // Hundredfold: where the hook relay and the `jinn` MCP server find the gateway, and which instance those belong to
  // (so a `jinn` run against another home drops them, sandbox-env.ts). Under either codename: a session an
  // older gateway started carries the older names.
  ...envNamesFor(["HOME", "INSTANCE", "GATEWAY_URL", "GATEWAY_TOKEN", "BINDING_HOME"]),
]);

const SCOPED_SESSION_ENV_PREFIX: ReadonlyArray<string> = ["LC_", "XDG_", "DISABLE_"];

/** Whether a department-scoped session keeps the gateway's variable `key`. */
export function isScopedSessionEnvName(key: string): boolean {
  const name = key.toUpperCase();
  return SCOPED_SESSION_ENV_EXACT.has(name) || SCOPED_SESSION_ENV_PREFIX.some((prefix) => name.startsWith(prefix));
}

export function buildEngineChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: EngineChildEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const denyExact = new Set(options.denyExact ?? []);
  for (const [key, value] of Object.entries(baseEnv)) {
    if (shouldScrubEngineChildEnv(key, options, denyExact)) continue;
    if (value !== undefined) env[key] = value;
  }
  // resolveClaudeConfigDir() resolves this against the GATEWAY's cwd, but engines are
  // spawned in the session's working directory — so a relative value would send the
  // child to a different directory than the one the gateway seeded consent flags in
  // and watches for transcripts. Hand it the path already resolved.
  if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.resolve(env.CLAUDE_CONFIG_DIR);
  return applyClaudeProfileEnv(env, options.claudeProfile ?? null);
}

function shouldScrubEngineChildEnv(
  key: string,
  options: EngineChildEnvOptions,
  denyExact: ReadonlySet<string>,
): boolean {
  if (ENGINE_CHILD_ENV_DENY_EXACT.has(key) || denyExact.has(key) || opencodeAccountKeyEnv.has(key)) return true;
  if (options.scopedSession && !isScopedSessionEnvName(key)) return true;
  return ENGINE_SCRUB_RULES.some(
    (rule) => Boolean(options[rule.option])
      && (rule.exact.includes(key) || rule.prefix.some((prefix) => key.startsWith(prefix))),
  );
}
