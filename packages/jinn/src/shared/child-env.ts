import path from "node:path";
import { applyClaudeProfileEnv, type ClaudeProfile } from "./claude-profile.js";

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

const ENGINE_CHILD_ENV_DENY_EXACT: ReadonlySet<string> = new Set([
  "JINN_HOME_IDENTITY",
  "JINN_TAKE_PORT",
  // Per session, set by the engine; a gateway started from inside an employee's session must not hand its employee to others.
  "JINN_EMPLOYEE",
]);

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
 * Claude Code's own model and feature switches, and the Jinn variables its hooks and
 * `jinn` MCP server find the gateway with. Its own `JINN_SESSION_ID` and
 * `JINN_DEPARTMENT` are set on top by the engine.
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
  // Jinn: where the hook relay and the `jinn` MCP server find the gateway
  "JINN_HOME", "JINN_INSTANCE", "JINN_GATEWAY_URL", "JINN_GATEWAY_TOKEN",
  // Which instance those belong to, so a `jinn` run against another home drops them (sandbox-env.ts)
  "JINN_BINDING_HOME",
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
  if (ENGINE_CHILD_ENV_DENY_EXACT.has(key) || denyExact.has(key)) return true;
  if (options.scopedSession && !isScopedSessionEnvName(key)) return true;
  return ENGINE_SCRUB_RULES.some(
    (rule) => Boolean(options[rule.option])
      && (rule.exact.includes(key) || rule.prefix.some((prefix) => key.startsWith(prefix))),
  );
}
