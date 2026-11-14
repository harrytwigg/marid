import type { DelegatedActivity, Session } from "../shared/types.js";
import { serializeRuntimeActivity, type RuntimeActivityInfo } from "../sessions/background-work.js";
import type { SessionTreeActivity } from "../sessions/session-tree.js";

/**
 * The runtime activity a Todo's session tree reports per node, serialized the
 * way the session list serializes it so the Todo page and the chat describe a
 * finished turn from the same facts.
 */
export function sessionTreeActivity(
  delegated: ReadonlyMap<string, DelegatedActivity>,
  runtime: (session: Session) => RuntimeActivityInfo | undefined,
): SessionTreeActivity {
  return {
    backgroundActivity: (session) => {
      const info = runtime(session);
      return info ? serializeRuntimeActivity(info) : null;
    },
    delegatedActivity: (session) => delegated.get(session.id) ?? null,
  };
}
