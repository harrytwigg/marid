import type { EngineLimitEngineSnapshot } from "./types.js";

/**
 * The last reading the gateway took of each account it reads over SSH
 * (FR-072). A remote host that is asleep is never woken to be read, so its card
 * shows this reading and its age, and the backoff reset time for a remote
 * account comes from here. Only the parsed snapshot is kept: the access token
 * that produced it was held for the one usage call and is not part of it.
 * In memory, so a restart forgets it, which reads as "no reading yet".
 */

export interface AccountReading {
  snapshot: EngineLimitEngineSnapshot;
  /** Epoch ms the reading was taken. */
  at: number;
}

const readings = new Map<string, AccountReading>();

export function rememberAccountReading(account: string, snapshot: EngineLimitEngineSnapshot, at: number = Date.now()): void {
  readings.set(account, { snapshot, at });
}

export function lastAccountReading(account: string): AccountReading | undefined {
  return readings.get(account);
}

/** Test seam. */
export function clearAccountReadings(): void {
  readings.clear();
}
