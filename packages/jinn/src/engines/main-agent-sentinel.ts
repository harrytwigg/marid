import { NAMES, nameAliases } from "../shared/codename.js";

/** Gateway-controlled marker injected into the MAIN agent's appended system prompt.
 *  The proxy tees only requests whose system carries it — Task sub-agents get Claude
 *  Code's own system prompt (no sentinel) and are therefore suppressed. This is the
 *  one main-vs-sub signal the gateway fully owns, so it cannot drift like a request
 *  fingerprint does. It is an HTML comment so the model ignores it. */
export const MAIN_AGENT_SENTINEL = `<!-- ${NAMES.codename}-main-agent:5c1f -->`;

/** A session started before a codename change still carries the earlier sentinel in its system prompt, for as long as that process lives. */
const MAIN_AGENT_SENTINELS = nameAliases((n) => `<!-- ${n.codename}-main-agent:5c1f -->`);

/** Whether `text` carries the main-agent sentinel of this build or of an earlier one. */
export function hasMainAgentSentinel(text: string): boolean {
  return MAIN_AGENT_SENTINELS.some((sentinel) => text.includes(sentinel));
}
