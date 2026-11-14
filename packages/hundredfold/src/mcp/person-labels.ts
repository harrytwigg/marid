/* How an agent reads the person responsible for a Todo: the gateway's `humanAssignee` turned into words an agent can repeat
 * without mistaking a board member for the operator. */

/**
 * The person responsible for a Todo as an agent reads it: "operator", or "<name> (board member)", never a bare `user:` id
 * in the person field and never a user as the operator (a board member's words and standing are not the operator's). The
 * gateway sends the names it knows in a `members` map beside the Todos; a user it no longer knows reads "Former member".
 */
export function personLabel(person: unknown, members: unknown): string | null {
  if (typeof person !== "string") return null;
  if (person === "@operator") return "operator";
  if (!person.startsWith("user:")) return null;
  const named = (members as Record<string, { displayName?: unknown }> | undefined)?.[person]?.displayName;
  return typeof named === "string" && named !== "Former member" ? `${named} (board member)` : "Former member";
}

/**
 * A person that no name map accompanies (the tree, a mutation's reply) reads "a board member": a raw `user:` id is a
 * meaningless token an agent may echo back, and a name lookup here would call a real person a former member. The operator
 * keeps reading "operator". The detail and list replies, which do carry names, are already labelled and pass through. Only
 * the person field is relabelled: event details and the `members` map keep their `user:` ids, as `createdBy` and actors do.
 */
export function neutralisePeople(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(neutralisePeople);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "humanAssignee" && typeof entry === "string") out[key] = entry === "@operator" ? "operator" : entry.startsWith("user:") ? "a board member" : entry;
    else out[key] = neutralisePeople(entry);
  }
  return out;
}

/** A detail body with its Todo's `humanAssignee` read as `personLabel` reads it. */
export function withPersonLabel(body: unknown): unknown {
  const detail = body as { workItem?: Record<string, unknown>; members?: unknown } | null;
  if (!detail?.workItem || !("humanAssignee" in detail.workItem)) return body;
  return { ...detail, workItem: { ...detail.workItem, humanAssignee: personLabel(detail.workItem.humanAssignee, detail.members) } };
}
