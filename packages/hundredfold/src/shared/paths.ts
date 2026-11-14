import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveHomeIdentity, resolveHundredfoldHome } from "./home.js";
import { resolveInstancesRegistryPath } from "../instances/directory.js";
import { resolveSttModelsDir } from "../stt/model-store.js";
import { resolveSttSettingsPath } from "../stt/settings-store.js";

export { resolveHomeIdentity, resolveHundredfoldHome } from "./home.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Fail closed if a test run resolves to a real, non-temp HUNDREDFOLD_HOME.
 *
 * There is a Vitest guard (vitest.global-setup.ts redirects HUNDREDFOLD_HOME, and
 * vitest.setup.ts asserts it per worker), but it is registered in
 * packages/hundredfold/vitest.config.ts — so it only arms when Vitest actually LOADS
 * that config. Run `npx vitest run packages/hundredfold/src` from the repo ROOT (which
 * has no Vitest config) and Vitest falls back to defaults: no globalSetup, no
 * setupFiles, no guard. An ambient HUNDREDFOLD_HOME=~/.hundredfold then flows straight into
 * every suite, and the tests write fixtures into the LIVE gateway registry.
 *
 * That happened on 2026-07-06 and again, 4x larger, on 2026-07-25 — the second
 * run burned 16 Todo IDs out of the append-only allocator, a permanent hole in
 * the live ledger caused by a test. Cleanup after the fact is not a fix.
 *
 * This assertion lives at the boundary instead of in test config, because
 * EVERY module that can touch the registry imports HUNDREDFOLD_HOME from here. It
 * cannot be bypassed by choosing a different cwd, config, or runner. The
 * sanctioned `pnpm test` path is unaffected: global setup has already pointed
 * HUNDREDFOLD_HOME at a temp dir before any worker imports this module.
 */
export function assertTestRunIsIsolated(home: string, env: NodeJS.ProcessEnv = process.env): void {
  // Vitest sets both in every worker; VITEST_WORKER_ID is absent in the main
  // process, so check either. Nothing else in the app sets these.
  if (!env.VITEST && !env.VITEST_WORKER_ID) return;

  const canonical = (p: string): string => {
    try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
  };
  const resolved = canonical(home);
  const tempRoot = canonical(env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT || os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  const underTemp = relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (underTemp) return;

  throw new Error(
    `Refusing to run tests against a non-temp HUNDREDFOLD_HOME=${home}.\n` +
    `Tests must never touch the live gateway registry (${path.join(home, "sessions", "registry.db")}).\n` +
    `Run the suite with the repo's own script — \`pnpm test\`, or \`pnpm --filter jinn-cli test\` — ` +
    `which loads packages/hundredfold/vitest.config.ts and redirects HUNDREDFOLD_HOME to a temp dir.\n` +
    `Running \`npx vitest\` from the repo root bypasses that config and is what caused ` +
    `fixture data to be written into ~/.hundredfold on 2026-07-06 and 2026-07-25.`,
  );
}

export const HUNDREDFOLD_HOME = resolveHundredfoldHome();
assertTestRunIsIsolated(HUNDREDFOLD_HOME);
export const HUNDREDFOLD_HOME_IDENTITY = resolveHomeIdentity(HUNDREDFOLD_HOME);
export const CONFIG_PATH = path.join(HUNDREDFOLD_HOME, "config.yaml");
export const SESSIONS_DB = path.join(HUNDREDFOLD_HOME, "sessions", "registry.db");
/** Append-only record of the sessions each gateway restart interrupted and what the next boot did about them (sessions/restart-record.ts). */
export const RESTART_RECORD_FILE = path.join(HUNDREDFOLD_HOME, "sessions", "restart-interrupted.jsonl");
export const CRON_JOBS = path.join(HUNDREDFOLD_HOME, "cron", "jobs.json");
export const CRON_RUNS = path.join(HUNDREDFOLD_HOME, "cron", "runs");
export const ORG_DIR = path.join(HUNDREDFOLD_HOME, "org");
export const SKILLS_DIR = path.join(HUNDREDFOLD_HOME, "skills");
export const PLUGINS_DIR = path.join(HUNDREDFOLD_HOME, "plugins");
export const DOCS_DIR = path.join(HUNDREDFOLD_HOME, "docs");
export const LOGS_DIR = path.join(HUNDREDFOLD_HOME, "logs");
export const TMP_DIR = path.join(HUNDREDFOLD_HOME, "tmp");
/** Durable, bounded terminal snapshots used to restore CLI views after restart. */
export const PTY_SNAPSHOTS_DIR = path.join(HUNDREDFOLD_HOME, "state", "pty-snapshots");
export const ENGINE_LIMITS_DIR = path.join(TMP_DIR, "engine-limits");
export const CLAUDE_LIMITS_DIR = path.join(ENGINE_LIMITS_DIR, "claude");
export const STT_MODELS_DIR = resolveSttModelsDir();
export const STT_SETTINGS_FILE = resolveSttSettingsPath();
/** Read fallback for installs that have not yet adopted their per-home model. */
export const LEGACY_STT_MODELS_DIR = path.join(HUNDREDFOLD_HOME, "models", "whisper");
export const PID_FILE = path.join(HUNDREDFOLD_HOME, "gateway.pid");
/** Gateway connection info (port + hook secret + pids) for hook-relay discovery. */
export const GATEWAY_INFO_FILE = path.join(HUNDREDFOLD_HOME, "gateway.json");
/** Per-session Claude Code --settings files. */
export const CLAUDE_SETTINGS_DIR = path.join(HUNDREDFOLD_HOME, "tmp", "settings");
/**
 * Per-session Codex CODEX_HOME overlays. Each hundredfold session that runs the builtin
 * `hundredfold` MCP server with a capability token gets a stable dir here whose
 * `config.toml` carries the server stanza (token off argv) — fresh and resume
 * both point CODEX_HOME here so the thread rollout persists across turns.
 */
export const CODEX_HOMES_DIR = path.join(HUNDREDFOLD_HOME, "tmp", "codex-homes");
/** The hook-relay script written once at boot. */
export const HOOK_RELAY_SCRIPT = path.join(HUNDREDFOLD_HOME, "hook-relay.mjs");
export const CLAUDE_SKILLS_DIR = path.join(HUNDREDFOLD_HOME, ".claude", "skills");
export const AGENTS_SKILLS_DIR = path.join(HUNDREDFOLD_HOME, ".agents", "skills");
export const TEMPLATE_DIR = path.join(__dirname, "..", "..", "..", "template");
export const FILES_DIR = path.join(HUNDREDFOLD_HOME, "files");
export const ATTACHMENTS_DIR = path.join(HUNDREDFOLD_HOME, "attachments");
export const VIDEO_CACHE_DIR = path.join(HUNDREDFOLD_HOME, "cache", "video");
export const IMAGE_CACHE_DIR = path.join(HUNDREDFOLD_HOME, "cache", "image");
/** Date-bucketed storage for files attached to / emitted by sessions. */
export const UPLOADS_DIR = path.join(HUNDREDFOLD_HOME, "uploads");
export const TEMPLATE_MIGRATIONS_DIR = path.join(TEMPLATE_DIR, "migrations");

/** Host-scoped workspace directory, deliberately outside every HUNDREDFOLD_HOME. */
export const INSTANCES_REGISTRY = resolveInstancesRegistryPath();
