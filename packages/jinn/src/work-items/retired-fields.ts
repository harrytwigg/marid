/**
 * Todo fields that no longer exist. `acceptance` was retired because a
 * Todo's criteria belong in its body, and `verifyPolicy` was removed
 * with the review-mode picker: cron Todos close on a clean run and everything
 * else goes to the operator, which is fixed by provenance, not configured.
 *
 * Their columns stay in the table so old rows keep their data, but a caller
 * still sending them is told so rather than having the value silently dropped.
 */

export const RETIRED_TODO_FIELDS = ['acceptance', 'verifyPolicy'] as const;

const RETIRED_FIELD_HINTS: Readonly<Record<(typeof RETIRED_TODO_FIELDS)[number], string>> = {
  acceptance: 'put acceptance criteria in body',
  verifyPolicy: 'review is no longer configurable per Todo',
};

/** The refusal for a request carrying a retired field, or null when it carries
 *  none. `ignoreNull` is for MCP arguments, where a model filling every optional
 *  parameter with null is common and means "not set". */
export function retiredTodoFieldError(args: Record<string, unknown>, opts: { ignoreNull?: boolean } = {}): string | null {
  const present = RETIRED_TODO_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(args, key)
    && args[key] !== undefined && !(opts.ignoreNull && args[key] === null));
  if (present.length === 0) return null;
  return `${present.join(' and ')} ${present.length === 1 ? 'was' : 'were'} removed from Todos: ${present.map((key) => RETIRED_FIELD_HINTS[key]).join('; ')}`;
}
