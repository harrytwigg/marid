import fs from "node:fs";
import { loadConfig } from "../shared/config.js";
import { JINN_HOME } from "../shared/paths.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { refreshGrokModels, refreshPiModels, refreshHermesModels, refreshOpencodeModels, refreshMusecodeModels } from "../shared/models.js";
import type { EngineLimitBucket, EngineLimitEngineSnapshot, EngineLimitWindow } from "../shared/types.js";
import type { EngineLimitAccountSnapshot } from "../shared/engine-limits-accounts.js";
import type { OpencodeAccountLimitSnapshot } from "../shared/engine-limits-opencode-accounts.js";
import { opencodeDiscoveryEnv } from "../engines/opencode-launch.js";
import { clearEngineHealthByOperator } from "../shared/engine-health.js";
import type { EngineHealth } from "../shared/engine-health.js";

export interface LimitsOptions {
  json?: boolean;
  engine?: string;
  /** Clear this health key's record instead of showing limits. */
  clear?: string;
}

function formatReset(window: EngineLimitWindow): string {
  if (!window.resetsAtIso) return "";
  return `, resets ${new Date(window.resetsAtIso).toLocaleString()}`;
}

function formatDuration(minutes?: number): string {
  if (!minutes) return "";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatWindow(window: EngineLimitWindow): string {
  const used = window.usedPercent === undefined ? "unknown" : `${window.usedPercent}%`;
  // A window already named by its length ("5h") needs no second statement of it ("5h/5h").
  const length = formatDuration(window.windowDurationMins);
  const duration = length && length !== window.name ? `/${length}` : "";
  return `${window.name}${duration}: ${used} used${formatReset(window)}`;
}

function printBuckets(buckets: readonly EngineLimitBucket[]): void {
  console.log("  Buckets:");
  for (const bucket of buckets) {
    const label = bucket.name && bucket.name !== bucket.id ? `${bucket.id} (${bucket.name})` : bucket.id;
    const parts = (bucket.windows ?? [bucket.primary, bucket.secondary]).filter(Boolean).map((w) => formatWindow(w!));
    console.log(`    - ${label}${bucket.planType ? `, plan ${bucket.planType}` : ""}`);
    for (const part of parts) console.log(`      ${part}`);
  }
}

function printEngine(engine: EngineLimitEngineSnapshot): void {
  const badge = engine.available ? engine.status : "missing";
  console.log(`${engine.name} (${badge})`);
  console.log(`  Source: ${engine.source}`);
  if (engine.accountPlan) console.log(`  Plan: ${engine.accountPlan}`);
  if (engine.defaultModel) console.log(`  Default model: ${engine.defaultModel}`);

  if (engine.windows?.length) {
    console.log("  Limits:");
    for (const window of engine.windows) console.log(`    - ${formatWindow(window)}`);
  }

  // A lone bucket is worth printing when the top-level windows are not its own.
  if (engine.buckets?.length && (engine.buckets.length > 1 || !engine.windows?.length)) printBuckets(engine.buckets);

  if (engine.credits) {
    const creditBits = [
      engine.credits.unlimited === true ? "unlimited" : undefined,
      engine.credits.hasCredits === false ? "no credits" : undefined,
      engine.credits.balance ? `balance ${engine.credits.balance}` : undefined,
      engine.credits.remainingPercent !== undefined ? `${engine.credits.remainingPercent}% remaining` : undefined,
    ].filter(Boolean);
    if (creditBits.length) console.log(`  Credits: ${creditBits.join(", ")}`);
  }

  if (engine.context) {
    const size = engine.context.contextWindowSize ? ` of ${engine.context.contextWindowSize.toLocaleString()} tokens` : "";
    const used = engine.context.usedPercent === undefined ? "unknown" : `${engine.context.usedPercent}%`;
    console.log(`  Context: ${used}${size}`);
  }

  if (engine.models.length) {
    console.log(`  Models: ${engine.models.map((m) => m.label || m.id).join(", ")}`);
  }

  if (engine.unsupportedReason) console.log(`  Note: ${engine.unsupportedReason}`);
  if (engine.error) console.log(`  Error: ${engine.error}`);
  if (engine.stale) console.log("  Note: latest snapshot is older than 30 minutes.");
}

function isOpencodeAccount(account: EngineLimitAccountSnapshot): account is OpencodeAccountLimitSnapshot {
  return typeof (account as Partial<OpencodeAccountLimitSnapshot>).provider === "string";
}

function formatTime(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleString();
}

/** One account's card: the name and where it runs, who uses it, what it has spent and whether it is held out. */
function printAccount(engineName: string, account: EngineLimitAccountSnapshot): void {
  const where = account.location.kind === "remote" ? `remote ${account.location.host}` : "local";
  console.log(`${engineName} account ${account.label === account.account ? account.label : `${account.account} (${account.label})`} (${where})`);
  if (isOpencodeAccount(account)) {
    console.log(`  Provider: ${account.provider}${account.base ? ` (clones ${account.base})` : ""}`);
    if (account.keyEnv) console.log(`  Key: ${account.keyEnv} (${account.keySet ? "set" : "NOT SET"})`);
  }
  if (account.employees.length) console.log(`  Employees: ${account.employees.join(", ")}`);
  if (account.accountPlan) console.log(`  Plan: ${account.accountPlan}`);
  if (account.windows?.length) {
    console.log("  Limits:");
    for (const window of account.windows) console.log(`    - ${formatWindow(window)}`);
  }
  if (account.buckets?.length) printBuckets(account.buckets);
  if (account.exhausted) console.log(`  Exhausted${account.exhausted.until ? ` until ${formatTime(account.exhausted.until)}` : ""}`);
  if (isOpencodeAccount(account) && account.nextTryAt) console.log(`  Next try: ${formatTime(account.nextTryAt)}`);
  if (account.hostUnreachable) console.log("  Note: the host did not answer; the windows are its last reading.");
  else if (account.noReading) console.log("  Note: no live reading for this account.");
  if (isOpencodeAccount(account)) for (const problem of account.problems ?? []) console.log(`  Problem: ${problem}`);
  if (account.error) console.log(`  Error: ${account.error}`);
}

function describeReplaced(replaced: EngineHealth): string {
  const parts = [replaced.state, replaced.failureClass, replaced.until ? `until ${replaced.until}` : undefined, replaced.window ? `window ${replaced.window}` : undefined, replaced.host ? `host ${replaced.host}` : undefined];
  return parts.filter(Boolean).join(", ");
}

/** Write a clear for one health key: for a reset the limits readout cannot see. */
function clearHealth(key: string): void {
  const replaced = clearEngineHealthByOperator(key);
  if (!replaced) {
    console.log(`Nothing to clear: ${key} has no record (a key is an engine, or a Claude account such as claude:<profile>).`);
    return;
  }
  console.log(`Cleared ${key} (was ${describeReplaced(replaced)}).`);
  console.log("Sessions standing in for it go back to it at their next turn; one waiting on its stand-in's limit hands back within a minute.");
}

export async function runLimits(opts: LimitsOptions = {}): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.log("Gateway is not set up. Run \"jinn setup\" first.");
    return;
  }
  if (opts.clear !== undefined) {
    clearHealth(opts.clear);
    return;
  }

  const config = loadConfig();
  await refreshPiModels(config);
  await refreshOpencodeModels(config, { env: opencodeDiscoveryEnv(config) });
  await refreshGrokModels(config);
  await refreshMusecodeModels(config);
  await refreshHermesModels(config);
  const snapshot = await collectEngineLimits(config, { engine: opts.engine });

  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(`Engine limits (${new Date(snapshot.generatedAt).toLocaleString()})`);
  for (const engine of Object.values(snapshot.engines)) {
    console.log("");
    printEngine(engine);
  }
  // A card per account, beside the engines: Claude's and opencode's declared ones.
  for (const [engineName, accounts] of Object.entries(snapshot.accounts ?? {})) {
    for (const account of accounts) {
      console.log("");
      printAccount(engineName, account);
    }
  }
}
