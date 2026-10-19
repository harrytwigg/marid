import os from "node:os";
import { logger } from "../shared/logger.js";
import { NAMES } from "../shared/codename.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { getPackageVersion } from "../shared/version.js";
import type { MspClient } from "./musecode-msp.js";
import { MspProcess } from "./musecode-process.js";
import { buildMuseServeArgs } from "./musecode-protocol.js";

/**
 * A short-lived `muse serve` for a question that is not a turn: which models
 * the catalog lists, what the account's usage is. It is started with exactly
 * the flags a turn's host gets, asked one thing, and gone again.
 */

/** How long the host gets to shut down before it is signalled: nothing is running in it. */
const PROBE_EXIT_GRACE_MS = 500;

export interface MuseProbeOptions {
  /** The operator's own `cliFlags`, appended after the base flags as on a turn. */
  cliFlags?: string[];
  /** The whole probe (start, initialize, the question) gets this long. */
  timeoutMs: number;
}

/**
 * Run `ask` against a freshly started host that has been initialized. Resolves
 * with its answer, or `undefined` when the binary would not start, the host
 * died, the question failed or the time ran out. Never throws; the host is
 * always shut down.
 */
export async function askMuseHost<T>(bin: string, opts: MuseProbeOptions, ask: (client: MspClient) => Promise<T>): Promise<T | undefined> {
  const proc = new MspProcess({
    bin,
    args: buildMuseServeArgs({ cliFlags: opts.cliFlags }),
    cwd: os.tmpdir(),
    env: buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true }),
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), opts.timeoutMs);
    timer.unref?.();
  });
  try {
    const answer = (async () => {
      await proc.client.initialize({ clientInfo: { name: NAMES.codename, version: packageVersion() }, userInputDialogs: false });
      return await ask(proc.client);
    })();
    // Whichever loses the race must not become an unhandled rejection.
    answer.catch(() => undefined);
    const result = await Promise.race([answer, timedOut]);
    if (result === undefined) logger.debug("Muse Code probe gave no answer");
    return result;
  } catch (err) {
    logger.debug(`Muse Code probe failed: ${err instanceof Error ? err.message : err}`);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    proc.client.close("probe finished");
    await proc.shutdown(PROBE_EXIT_GRACE_MS).catch(() => undefined);
  }
}

function packageVersion(): string {
  try {
    return getPackageVersion();
  } catch {
    return "0.0.0";
  }
}
