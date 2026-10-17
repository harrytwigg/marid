import fs from "node:fs";
import { NAMES, currentInstanceName, type Names } from "../shared/codename.js";
import { isCodenameEnvKey } from "../shared/codename-env.js";
import { resolveJinnHome } from "../shared/home.js";
import { builtinMcpServerName } from "../mcp/builtin-name.js";
import { readHomeMoveReceipt } from "../instances/home-rename.js";
import { inspectHome, type HomeState } from "../instances/home-state.js";
import { readPendingMove } from "../instances/home-pending.js";
import { stageRootFor } from "../instances/stage-rename.js";
import { loadInstances, type Instance } from "../instances/directory.js";
import yaml from "js-yaml";
import path from "node:path";

/**
 * `doctor`: what this install carries from before the codename changed, and what has been done about it.
 * Read-only: it never moves, rewrites or deletes anything.
 */

export interface DoctorFinding {
  level: "ok" | "info" | "problem";
  message: string;
}

export interface DoctorInput {
  env?: NodeJS.ProcessEnv;
  names?: Names;
  home?: string;
  instances?: Instance[];
}

const HOME_STATE_FINDINGS: Record<HomeState, (home: string, current: string, legacy: string) => DoctorFinding> = {
  "not-named-for-codename": (home) => ({ level: "ok", message: `Home ${home} does not carry the codename in its path, so it needs no move.` }),
  current: (home) => ({ level: "ok", message: `Home ${home} is at this build's name.` }),
  absent: (home) => ({ level: "info", message: `Home ${home} does not exist yet.` }),
  moved: (_home, current, legacy) => ({ level: "ok", message: `Home was moved to ${current}; ${legacy} is a link to it.` }),
  "pending-move": (_home, current, legacy) => ({ level: "problem", message: `Home is still at ${legacy}. It moves to ${current} the next time it is started with nothing running there (a snapshot is taken first).` }),
  conflict: (_home, current, legacy) => ({ level: "problem", message: `Both ${legacy} and ${current} exist as directories. Nothing was touched. Keep the one with your data, rename the other aside, and run again.` }),
  "legacy-link-elsewhere": (_home, current, legacy) => ({ level: "problem", message: `${legacy} is a link to somewhere other than ${current}, so it was left alone.` }),
};

function registryFindings(instances: Instance[], names: Names): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const seen = new Map<string, string>();
  for (const instance of instances) {
    const canonical = currentInstanceName(instance.name, names);
    if (canonical !== instance.name) findings.push({ level: "info", message: `Registry entry "${instance.name}" (${instance.home}) still has the old name; it becomes "${canonical}" when its home moves.` });
    const twin = seen.get(canonical);
    if (twin !== undefined) findings.push({ level: "problem", message: `Registry entries "${twin}" and "${instance.name}" are one instance under two names.` });
    seen.set(canonical, instance.name);
  }
  return findings;
}

function configuredMcpName(home: string, names: Names): string {
  try {
    return builtinMcpServerName(yaml.load(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")) as object, names);
  } catch {
    return builtinMcpServerName(undefined, names);
  }
}

function homeFindings(home: string, names: Names): DoctorFinding[] {
  const { state, current, legacy } = inspectHome(home, names);
  const findings = [HOME_STATE_FINDINGS[state](home, current, legacy)];
  if (readPendingMove(current)) findings.push({ level: "problem", message: `The move to ${current} did not finish all its steps (conversations, stage directories, registry). The next command that settles the home tries them again.` });
  const receipt = readHomeMoveReceipt(current);
  if (receipt) findings.push({ level: "info", message: `Moved ${receipt.at}: ${receipt.transcripts} conversation director${receipt.transcripts === 1 ? "y" : "ies"} followed it${receipt.backup ? `; snapshot at ${receipt.backup}` : ""}.` });
  const legacyStage = stageRootFor(legacy, names, true);
  if (fs.existsSync(legacyStage)) findings.push({ level: "problem", message: `Department stage directories are still under ${legacyStage}; they move with the home.` });
  findings.push({ level: "info", message: `The built-in MCP server is registered as "${configuredMcpName(current, names)}".` });
  return findings;
}

function legacyEnvFindings(env: NodeJS.ProcessEnv, names: Names): DoctorFinding[] {
  const legacyVariables = Object.keys(env).filter((key) => isCodenameEnvKey(key, names) && !key.replace(/^_/, "").startsWith(`${names.upper}_`));
  return legacyVariables.length === 0 ? [] : [{ level: "info", message: `Set under the old prefix (still read, with a warning): ${legacyVariables.sort().join(", ")}.` }];
}

/** The findings, in the order they are printed. */
export function doctorFindings(input: DoctorInput = {}, processEnv: NodeJS.ProcessEnv = process.env): DoctorFinding[] {
  const names = input.names ?? NAMES;
  const env = input.env ?? processEnv;
  if (!names.renamed) return [{ level: "ok", message: `The codename is "${names.codename}"; there is nothing to carry over.` }];
  const home = input.home ?? resolveJinnHome(env);
  return [
    ...homeFindings(home, names),
    ...registryFindings(input.instances ?? safeInstances(), names),
    ...legacyEnvFindings(env, names),
  ];
}

function safeInstances(): Instance[] {
  try {
    return loadInstances();
  } catch {
    return [];
  }
}

const MARK = { ok: "ok     ", info: "note   ", problem: "ACTION " } as const;

export function runDoctor(options: { json?: boolean } = {}): void {
  const findings = doctorFindings();
  if (options.json) console.log(JSON.stringify(findings, null, 2));
  else for (const finding of findings) console.log(`${MARK[finding.level]}${finding.message}`);
  if (findings.some((finding) => finding.level === "problem")) process.exitCode = 1;
}
