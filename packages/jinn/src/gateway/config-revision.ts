import crypto from "node:crypto";
import fs from "node:fs";
import { CONFIG_PATH } from "../shared/paths.js";
import { wireHeader, wireHeaderDisplay, wireHeaderDisplayAliases } from "../shared/wire-names.js";

/**
 * Which config.yaml a page was looking at when it loaded, so a save that would
 * overwrite somebody else's edit can be refused instead of landing.
 *
 * The Settings page PUTs a whole config document it read at load time, and the
 * gateway merges that document over whatever is on disk now. Between those two
 * moments an operator can hand-edit the file, and a key they added is a key the
 * page never had — the merge keeps it, but a key they *changed* loses to the
 * page's stale copy, silently. The revision closes that window: it is taken from
 * the file, not from the in-memory config, because the file is what the merge
 * reads and therefore what a conflict is actually about.
 */
export const CONFIG_REVISION_HEADER = wireHeaderDisplay("config-revision");

/** Both spellings, for a response: a page from either build reads the one it knows. */
export const CONFIG_REVISION_RESPONSE_HEADERS = wireHeaderDisplayAliases("config-revision");

/** The lowercase key Node hands request headers over under. */
const REQUEST_HEADER_KEY = wireHeader("config-revision");

/** Put the revision on a response under every spelling of the header. */
export function setConfigRevisionHeaders(res: { setHeader(name: string, value: string): unknown }, revision: string): void {
  for (const name of CONFIG_REVISION_RESPONSE_HEADERS) res.setHeader(name, revision);
}

/**
 * A revision for config.yaml as it is on disk right now. Hashing the bytes rather
 * than reading an mtime keeps it honest across a rename-based atomic write, whose
 * mtime moves for a write that changed nothing.
 *
 * A file that is not there yet has the empty revision, which is a real value and
 * not an error: `jinn setup` has not run, and the first PUT is allowed to create
 * the file. It stops being empty the moment the file exists.
 */
export function currentConfigRevision(configPath: string = CONFIG_PATH): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Whether a PUT is writing over a config it has not seen.
 *
 * A request with no header is not stale — it opted out, and that is deliberate:
 * partial PUTs that touch one key (the Talk voice-setup card) never read the
 * document they are merging into, so there is no revision they could send and
 * nothing they could clobber by not sending one.
 */
export function isStaleConfigRevision(
  headers: Record<string, string | string[] | undefined>,
  current: string,
): boolean {
  const sent = headers[REQUEST_HEADER_KEY];
  if (typeof sent !== "string" || !sent) return false;
  return sent !== current;
}

/** What the operator is told when their save would have overwritten a hand edit. */
export const CONFIG_CONFLICT_BODY = {
  error: "config.yaml changed on disk after this page loaded it — saving now would overwrite that change",
  code: "CONFIG_CONFLICT",
  remedy: "Reload the config to pick up the change on disk, then reapply your edit and save again.",
} as const;
