import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "./paths.js";
import { DEFAULT_CLAUDE_ACCOUNT, isDefaultClaudeAccount } from "./engine-account.js";

interface ClaudeUsageState {
  lastRateLimitAt?: string; // ISO
  lastResetsAt?: string; // ISO
}

/** The default account's record is the file's own top level, as before
 *  accounts; every other account keeps its record under `accounts` (FR-055). */
interface ClaudeUsageFile extends ClaudeUsageState {
  accounts?: Record<string, ClaudeUsageState>;
}

const STATE_PATH = path.join(JINN_HOME, "tmp", "claude-usage.json");

function ensureStateDir(): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
}

function readUsageFile(): ClaudeUsageFile {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ClaudeUsageFile;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function readClaudeUsageState(account: string = DEFAULT_CLAUDE_ACCOUNT): ClaudeUsageState {
  const file = readUsageFile();
  if (isDefaultClaudeAccount(account)) return file;
  const own = file.accounts?.[account];
  return own && typeof own === "object" ? own : {};
}

export function recordClaudeRateLimit(resetsAtSeconds?: number, account: string = DEFAULT_CLAUDE_ACCOUNT): void {
  const nowIso = new Date().toISOString();
  const state: ClaudeUsageState = {
    ...readClaudeUsageState(account),
    lastRateLimitAt: nowIso,
    ...(typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)
      ? { lastResetsAt: new Date(resetsAtSeconds * 1000).toISOString() }
      : {}),
  };
  const file = readUsageFile();
  const next: ClaudeUsageFile = isDefaultClaudeAccount(account)
    ? { ...state, ...(file.accounts ? { accounts: file.accounts } : {}) }
    : { ...file, accounts: { ...file.accounts, [account]: state } };

  try {
    ensureStateDir();
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // best-effort only
  }
}

export function getClaudeExpectedResetAt(now = new Date(), account: string = DEFAULT_CLAUDE_ACCOUNT): Date | undefined {
  const state = readClaudeUsageState(account);
  if (!state.lastResetsAt) return undefined;
  const d = new Date(state.lastResetsAt);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.getTime() <= now.getTime()) return undefined;
  return d;
}

export function isLikelyNearClaudeUsageLimit(now = new Date(), account: string = DEFAULT_CLAUDE_ACCOUNT): boolean {
  const state = readClaudeUsageState(account);
  if (!state.lastRateLimitAt) return false;

  // If we know the exact reset time and it has passed, the limit is cleared
  if (state.lastResetsAt) {
    const resetAt = new Date(state.lastResetsAt);
    if (!Number.isNaN(resetAt.getTime()) && now.getTime() > resetAt.getTime()) {
      return false;
    }
  }

  const d = new Date(state.lastRateLimitAt);
  if (Number.isNaN(d.getTime())) return false;
  // Heuristic: if we've hit the limit recently, we're likely near it again.
  return now.getTime() - d.getTime() < 6 * 60 * 60_000;
}

