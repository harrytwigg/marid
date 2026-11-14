import { isEngineExhausted, type EngineHealthReading } from "../shared/engine-health.js";
import type { DoctorFinding } from "./doctor.js";

/**
 * Opencode providers and models the gateway is holding out of routing, and why.
 *
 * Only a dead key is something to act on (`problem`): a spent allowance reopens
 * by itself and a model the account cannot use is the operator's to enable, so
 * both are notes. Read-only, like the rest of `doctor`.
 */
export function opencodeHealthFindings(health: EngineHealthReading, now: Date = new Date()): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const [key, record] of Object.entries(health)) {
    if (!key.startsWith("opencode/") || record.failureClass === undefined || !isEngineExhausted(health, key, now)) continue;
    const target = key.slice("opencode/".length);
    const until = record.until ? ` until ${record.until}` : "";
    if (record.failureClass === "auth") {
      findings.push({
        level: "problem",
        message: `opencode provider ${target} is signed out: its API key is expired or invalid. Create a new key and sign in again; it is tried again once the credential changes, or clear it now with \`hundredfold limits --clear ${key}\`.`,
      });
    } else if (record.failureClass === "model-access") {
      findings.push({ level: "info", message: `opencode model ${target} is not enabled for this account (or its region has not opted in), so it is skipped${until}. Enable it in the provider's console, or clear it with \`hundredfold limits --clear ${key}\`.` });
    } else {
      findings.push({ level: "info", message: `opencode provider ${target} has no usable allowance, so it is skipped${until}; it is offered a turn again after that.` });
    }
  }
  return findings;
}
