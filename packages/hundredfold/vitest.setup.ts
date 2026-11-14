import { LEGACY_ENV_PREFIXES } from './src/shared/legacy/names.js';
import {
  assertIsolatedClaudeConfigDir,
  assertIsolatedTestHome,
  createIsolatedTestFileHome,
} from './vitest.test-home.js';

// setupFiles execute inside each worker before its test module is evaluated.
// Abort loudly if the pre-worker global setup ever stops propagating its home.
assertIsolatedTestHome(process.env.HUNDREDFOLD_HOME);
// A safe run-level home still shares SQLite state across forks. Allocate before
// static imports freeze paths; global teardown removes every file subtree.
// It also replaces CLAUDE_CONFIG_DIR, so no test reaches the real transcripts.
createIsolatedTestFileHome();
assertIsolatedClaudeConfigDir(process.env.CLAUDE_CONFIG_DIR);

/**
 * Scrub gateway/engine env that leaks in when the suite runs from inside a live
 * Hundredfold session — the common case on the operator's machine, where a Claude PTY
 * exports these into every child process.
 *
 * Same isolation boundary and same failure class as the HUNDREDFOLD_HOME leak: the
 * test's result silently depends on WHO ran it. This one is not hypothetical —
 * it broke claude-interactive-compact-window.test.ts, whose "no proxy → no
 * first-party assertion" case failed on an inherited '1' from the enclosing PTY.
 *
 * HUNDREDFOLD_HOME is deliberately NOT listed: setup owns the per-file home, and it
 * has already been asserted above.
 */
const LEAKY_ENV_VARS = [
  // Claude Code PTY env injected by the gateway (engines/claude-interactive.ts).
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDECODE',
  'ANTHROPIC_BASE_URL',
  // Session identity — a test inheriting these could act as a real session.
  'HUNDREDFOLD_SESSION_ID',
  'HUNDREDFOLD_SESSION_CAPABILITY',
  'HUNDREDFOLD_GATEWAY_URL',
  'HUNDREDFOLD_GATEWAY_TOKEN',
  'HUNDREDFOLD_HOME_IDENTITY',
  // Instance identity — the live gateway exports its own binding into every session,
  // and HUNDREDFOLD_HOST/HUNDREDFOLD_PORT outrank a fixture's config.yaml wherever a test loads one.
  'HUNDREDFOLD_INSTANCE',
  'HUNDREDFOLD_HOST',
  'HUNDREDFOLD_PORT',
  // Engine homes.
  'CODEX',
  'CODEX_HOME',
  // opencode PTY/session env, exported by an opencode employee session into
  // every child. OPENCODE_CONFIG is the sharp one: it names the PARENT
  // session's staged MCP config, so a test asserting "no config staged" would
  // instead observe that path and fail on whoever ran it. OPENCODE (the
  // nesting marker) and OPENCODE_PID are session-specific for the same reason.
  'OPENCODE',
  'OPENCODE_CONFIG',
  'OPENCODE_PID',
  'OPENCODE_SERVER_PASSWORD',
] as const;

for (const name of LEAKY_ENV_VARS) delete process.env[name];
// The same variables under the name an older build exports them by: a session started before an upgrade still carries those.
for (const name of LEAKY_ENV_VARS) {
  if (name.startsWith('HUNDREDFOLD_')) {
    for (const prefix of LEGACY_ENV_PREFIXES) delete process.env[`${prefix}_${name.slice('HUNDREDFOLD_'.length)}`];
  }
}

/**
 * Deliberately NOT importing assertNotProductionGateway (src/shared/sandbox-env.ts)
 * here: a setup file's imports are instantiated before every test module, so pulling
 * in shared/home.ts caches it against the real 'node:os' and any later
 * vi.mock('node:os') in a test whose graph reaches it silently stops applying —
 * fork-claude-projectdir.test.ts fails that way. assertIsolatedTestHome above is the
 * stronger check regardless: it refuses the production home AND every non-temp one.
 */
