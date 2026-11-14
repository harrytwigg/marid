import type { UpdateSessionFields } from "../registry.js";
import { getSession } from "../registry.js";
import { withServedTarget } from "../fallback-served.js";
import type { TurnInput } from "./types.js";

/** `fields` with the target that answered recorded as the one that served the turn (`fallbackServedBy`), when the turn answered and the session has walked a fallback chain. */
export function servedFields(input: Pick<TurnInput, "config" | "session">, fields: UpdateSessionFields, answered: boolean): UpdateSessionFields {
  return answered ? withServedTarget(input.config, getSession(input.session.id), fields) : fields;
}
