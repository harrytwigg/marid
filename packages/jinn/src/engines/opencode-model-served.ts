import type { EngineRunOpts } from "../shared/types.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { localOpencodeVersion } from "../shared/opencode-bin-version.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { opencodeApiOf } from "./opencode-version.js";
import { gatherFacts } from "./remote-stage.js";
import type { OpencodeAccountStaging } from "./opencode-accounts.js";

/**
 * Whether the opencode a turn would run on can serve the turn's own model, before anything is launched.
 *
 * An account's model off the account's main endpoint is one a 1.x binary cannot serve (it sends every model to the
 * block's own endpoint), and it fails there with an `UnknownError` that says nothing of why. The error returned here
 * says it, and the turn is never started. A binary is only asked (the local version, or a remote host's facts) when the
 * model is one an account's 1.x block would leave out, so every other turn pays nothing.
 *
 * @returns the error to fail the turn with, or undefined when the turn can go ahead (a host whose version cannot be read
 *  is left for the launch itself to report).
 */
export async function unservedTurnModel(opts: EngineRunOpts, accounts: OpencodeAccountStaging | undefined): Promise<string | undefined> {
  const model = opts.model;
  if (!accounts || !model) return undefined;
  const onOne = accounts.unservedModel(model, 1);
  if (onOne === undefined) return undefined;
  if (!isRemoteTarget(opts)) {
    return opencodeApiOf(await localOpencodeVersion(resolveBin("opencode", opts.bin))) === 1 ? onOne : undefined;
  }
  const facts = await gatherFacts(sshDestination(opts)).catch(() => undefined);
  return facts !== undefined && opencodeApiOf(facts.opencodeVersion) === 1 ? onOne : undefined;
}
