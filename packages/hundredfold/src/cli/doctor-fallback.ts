import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { duplicateProblemsByChain } from "../shared/fallback-chain-load.js";
import type { DoctorFinding } from "./doctor.js";

/**
 * Fallback chains in `config.yaml` that repeat a target. A repeat still loads (the
 * chain tries each target once), so it is no failure, but it is reported here and by
 * `GET /api/fallback-chains` because a write refuses it. Read-only, like the rest of `doctor`.
 */
export function fallbackChainFindings(home: string): DoctorFinding[] {
  let engines: unknown;
  try {
    engines = (yaml.load(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")) as { engines?: unknown } | null)?.engines;
  } catch {
    return [];
  }
  const repeats = Object.values(duplicateProblemsByChain(engines)).flat();
  if (repeats.length === 0) return [{ level: "ok", message: "No fallback chain in config.yaml repeats a target." }];
  return repeats.map((problem) => ({ level: "problem", message: `${problem}. It loads (the repeat is ignored); remove it, because saving this chain is refused.` }));
}
