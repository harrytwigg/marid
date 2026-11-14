import fs from "node:fs";
import { HUNDREDFOLD_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { assertPortTakeoverAllowed, restartDetached } from "../gateway/lifecycle.js";
import { requestRestartFromGateway } from "./restart-request.js";
import { missingAccountKeyWarning } from "./restart-account-keys.js";

/**
 * `hundredfold restart` — race-free, in-session-safe gateway restart.
 *
 * Forks a detached helper that does stop → wait-for-port-free → start out of
 * band, so it survives the gateway killing its own sessions. Safe to run from
 * inside a Hundredfold chat session: this command returns immediately, the helper
 * brings the gateway back, and the gateway resumes the interrupted session.
 */
export interface RestartOptions {
  takePort?: boolean;
}

function exitOnPortOwnershipError(err: unknown): never {
  if (err instanceof Error && (err.name === "PortOwnershipError" || err.name === "UnsafeContainerTakeoverError")) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

export async function runRestart(opts: RestartOptions = {}): Promise<void> {
  if (!fs.existsSync(HUNDREDFOLD_HOME)) {
    console.error(`Error: ${HUNDREDFOLD_HOME} does not exist. Run "hundredfold setup" first.`);
    process.exit(1);
  }

  const config = loadConfig();
  const port = config.gateway.port || 7777; // footgun: ok the CLI's pre-existing fallback for a config.yaml with no port, hoisted unchanged
  try {
    assertPortTakeoverAllowed(port, { takePort: opts.takePort });
  } catch (err) {
    exitOnPortOwnershipError(err);
  }

  if (await requestRestartFromGateway(fetch, { port })) {
    console.log("Gateway restart requested from the running gateway. It will be back in a few seconds.");
    return;
  }

  const keyWarning = missingAccountKeyWarning(config);
  if (keyWarning) console.error(keyWarning);
  restartDetached({ takePort: opts.takePort, port });
  console.log("Gateway restarting in the background (detached). It will be back in a few seconds.");
}
