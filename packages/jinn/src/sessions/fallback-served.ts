import { declaredAccountByKey, declaredRemoteAccountByKey } from "../shared/claude-accounts-config.js";
import { fallbackLinkKey, fallbackLinkLabel } from "../shared/fallback-chain-wire.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { metaOf, servedBy, withServedBy } from "./fallback-run.js";
import { currentClaudeAccount } from "./session-account.js";
import type { UpdateSessionFields } from "./registry.js";

/**
 * `fallbackServedBy` for a turn that settled in the ordinary way (the target the
 * session was on answered it: its own, or the stand-in a standing run holds it
 * on). A hop's own turn records it where the hop is made. Only a session that
 * has walked a chain keeps the record; one that never was limited has nothing to
 * name, and its latest turn was served by its own target by definition.
 */

function hasWalkedChain(meta: Record<string, unknown>): boolean {
  return meta.fallbackRun !== undefined || (Array.isArray(meta.fallbackHops) && meta.fallbackHops.length > 0) || meta.fallbackServedBy !== undefined;
}

/** The target a session is running on now, as a chain link names it. */
function currentTarget(config: Pick<JinnConfig, "engines">, session: Session): { key: string; label: string } {
  const account = session.engine === "claude" ? currentClaudeAccount(session) : undefined;
  const profile = account === undefined ? undefined : (declaredAccountByKey(config, account) ?? declaredRemoteAccountByKey(config, account))?.name;
  const link = { engine: session.engine, ...(profile === undefined ? {} : { profile }), ...(session.model ? { model: session.model } : {}) };
  return { key: fallbackLinkKey(link), label: fallbackLinkLabel(link) };
}

/** `fields` with the session's current target recorded as the one that served this turn, when the session keeps that record. */
export function withServedTarget(config: Pick<JinnConfig, "engines">, session: Session | undefined, fields: UpdateSessionFields): UpdateSessionFields {
  if (!session) return fields;
  const meta = metaOf({ transportMeta: fields.transportMeta ?? session.transportMeta });
  if (!hasWalkedChain(meta)) return fields;
  return { ...fields, transportMeta: withServedBy(meta, servedBy(currentTarget(config, session))) as never };
}
