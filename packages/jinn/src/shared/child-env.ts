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
}

const ENGINE_CHILD_ENV_DENY_EXACT: ReadonlySet<string> = new Set([
  "JINN_HOME_IDENTITY",
  "JINN_TAKE_PORT",
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
  return ENGINE_SCRUB_RULES.some(
    (rule) => Boolean(options[rule.option])
      && (rule.exact.includes(key) || rule.prefix.some((prefix) => key.startsWith(prefix))),
  );
}
