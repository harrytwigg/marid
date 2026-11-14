import type { PluginHostVerb } from "./permissions.js";

/**
 * What a backend verb throws when it could not do the thing.
 *
 * The in-process functions behind the door answer in their own vocabularies: the
 * notes store returns a `NoteStoreResult` discriminated union, the gateway link
 * has no gateway to call. Handing either of those to a plugin as a *successful*
 * return would make the caller parse an internal shape this contract never
 * described — and the `{ ok: false }` case is the one a plugin is most likely to
 * skip. So every one of them becomes this: a rejection, naming the verb.
 *
 * `PluginHostDeniedError` is the sibling case, thrown by the permission gate and
 * carrying the same `verb`, so one catch can read both.
 */
export class PluginHostError extends Error {
  readonly verb: PluginHostVerb;
  /** The failing function's own reason code, passed through rather than
   *  flattened, so a plugin can branch on "not-found" without reading prose. */
  readonly reason: string;

  constructor(verb: PluginHostVerb, reason: string, message: string) {
    super(message);
    this.name = "PluginHostError";
    this.verb = verb;
    this.reason = reason;
  }
}
