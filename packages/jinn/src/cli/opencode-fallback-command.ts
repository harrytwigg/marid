import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import yaml from "js-yaml";
import { CONFIG_PATH } from "../shared/paths.js";
import { saveConfigAtomic } from "../shared/config.js";
import { parseJsonc } from "../engines/opencode-internal-fallback.js";
import type { FallbackLink } from "../shared/fallback-chain-wire.js";
import { migrateOpencodeFallback, type OpencodeEmployee, type OpencodeMigration } from "./opencode-fallback-migration.js";

/** `jinn fallback migrate-opencode [--file <path>] [--write]` (docs/fallback-chains.md, "Migrating a host"). */

const SETTINGS_FILE = "rate-limit-fallback.json";

/** Where the plugin looks for its settings, in its own order: each base's `.opencode/`, `opencode/` and itself. */
export function settingsSearchPaths(projectDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [projectDir, home, xdg].flatMap((base) => [path.join(base, ".opencode"), path.join(base, "opencode"), base].map((dir) => path.join(dir, SETTINGS_FILE)));
}

function readSettings(file: string): unknown {
  return parseJsonc(fs.readFileSync(file, "utf-8"));
}

/** The settings file the plugin would read: the first that exists and parses. */
export function findSettings(candidates: string[]): { file: string; settings: unknown } | undefined {
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      return { file, settings: readSettings(file) };
    } catch {
      /* the plugin skips an unreadable file and tries the next, so does this */
    }
  }
  return undefined;
}

/** The YAML a chain goes in, with each link on one line from `flowLevel` down. */
function flow(value: unknown, flowLevel: number): string {
  return yaml.dump(value, { flowLevel, lineWidth: 120 }).trimEnd();
}

const REMOVAL_STEPS = [
  "Remove the plugin from the host's opencode config:",
  '  - delete "opencode-rate-limit" from the `plugin` list in opencode.json / opencode.jsonc, or',
  "  - delete model-fallback.js from the plugin directory;",
  `then delete ${SETTINGS_FILE}.`,
  "Run `jinn doctor` to confirm no internal fallback is left.",
];

function chainSection(chain: FallbackLink[]): string[] {
  if (chain.length === 0) return ["# No engine-wide chain: the settings file has no fallback list (or no \"*\" chain)."];
  return ["# Engine default (engines.opencode.fallback): add to config.yaml, or run again with --write.", flow({ engines: { opencode: { fallback: chain } } }, 4)];
}

function suggestionLines(migration: OpencodeMigration): string[] {
  if (migration.employeeSuggestions.length === 0) return [];
  return [
    "",
    "# Suggested employee chains (not written). Add `fallback` to the employee's YAML:",
    ...migration.employeeSuggestions.flatMap((s) => [
      `# ${s.model}: ${s.employees.length ? `employees ${s.employees.join(", ")}` : "no employee on the opencode engine is pinned to this model"}`,
      flow({ fallback: s.chain }, 2),
    ]),
  ];
}

/** The report the command prints. */
export function renderMigration(migration: OpencodeMigration, source: string): string {
  const lines = [`# From ${source}`, ...migration.notes.map((n) => `# note: ${n}`), ...chainSection(migration.engineChain), ...suggestionLines(migration)];
  if (migration.unmapped.length) {
    lines.push("", "# Settings with no gateway equivalent (the gateway already covers them):");
    for (const { key, reason } of migration.unmapped) lines.push(`#   ${key}: ${reason}`);
  }
  if (migration.problems.length) lines.push("", ...migration.problems.map((p) => `# PROBLEM: ${p}`));
  lines.push("", "# After migrating:", ...REMOVAL_STEPS.map((l) => `#   ${l}`));
  return lines.join("\n");
}

/** What `--write` did, or why it refused. */
export type WriteOutcome = { written: true } | { written: false; reason: string };

/**
 * Merge the engine default chain into config.yaml through the atomic save.
 * Refuses when `engines.opencode.fallback` is already set, when the chain is
 * empty or invalid, and when the config does not exist.
 */
export function writeEngineChain(chain: FallbackLink[], configPath = CONFIG_PATH, save: (config: unknown) => void = saveConfigAtomic): WriteOutcome {
  if (chain.length === 0) return { written: false, reason: "there is no engine-wide chain to write" };
  if (!fs.existsSync(configPath)) return { written: false, reason: `no config at ${configPath}; run \`jinn setup\` first` };
  const config = (yaml.load(fs.readFileSync(configPath, "utf-8")) ?? {}) as Record<string, any>;
  const engines = (config.engines ??= {});
  const opencode = (engines.opencode ??= {});
  if (opencode.fallback !== undefined) {
    return { written: false, reason: "engines.opencode.fallback is already set; edit it by hand, or remove it and run again" };
  }
  opencode.fallback = chain;
  save(config);
  return { written: true };
}

/** The org's employees and the opencode engine's default model; empty when there is no home yet. */
async function orgOf(): Promise<{ employees: OpencodeEmployee[]; defaultModel?: string }> {
  try {
    const { loadConfig } = await import("../shared/config.js");
    const { scanOrg } = await import("../gateway/org.js");
    const config = loadConfig();
    const employees = [...scanOrg(config).values()].map((e) => ({ name: e.name, engine: e.engine, model: e.model }));
    return { employees, defaultModel: config.engines.opencode?.model };
  } catch {
    return { employees: [] };
  }
}

export interface MigrateOptions {
  file?: string;
  write?: boolean;
}

/** What `--write` makes of a migration: written, or why not. */
function writeOutcome(migration: OpencodeMigration): WriteOutcome {
  if (migration.problems.length) return { written: false, reason: "the chain has problems (above)" };
  return writeEngineChain(migration.engineChain);
}

function missingSettings(candidates: string[], file: string | undefined): string {
  if (file) return `No readable settings file at ${candidates[0]}.`;
  return `No ${SETTINGS_FILE} found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}`;
}

/** Run the command: print the report, and with `--write` merge the engine chain. */
export async function runMigrateOpencode(options: MigrateOptions = {}, out: (line: string) => void = console.log): Promise<void> {
  const candidates = options.file ? [path.resolve(options.file)] : settingsSearchPaths(process.cwd());
  const found = findSettings(candidates);
  if (!found) {
    out(missingSettings(candidates, options.file));
    process.exitCode = 1;
    return;
  }
  const migration = migrateOpencodeFallback(found.settings, await orgOf());
  out(renderMigration(migration, found.file));
  let failed = migration.problems.length > 0;
  if (options.write) {
    const outcome = writeOutcome(migration);
    out(outcome.written ? `\nWrote engines.opencode.fallback to ${CONFIG_PATH}.` : `\nNot written: ${outcome.reason}.`);
    failed = failed || !outcome.written;
  }
  if (failed) process.exitCode = 1;
}

export function registerFallbackCommand(program: Command): void {
  const fallback = program.command("fallback").description("Fallback chains");
  fallback
    .command("migrate-opencode")
    .description("Print the gateway fallback chain equivalent to this host's opencode rate-limit-fallback.json")
    .option("--file <path>", "Read this settings file instead of searching the plugin's paths")
    .option("--write", "Merge the engine default chain into config.yaml (refuses when engines.opencode.fallback is already set)")
    .action(async (opts) => {
      await runMigrateOpencode({ file: opts.file, write: opts.write });
    });
}
