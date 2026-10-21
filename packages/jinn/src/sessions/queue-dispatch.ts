// A queue row's dispatch payload: what its turn runs on besides its text.
// Split out of `queue-item-registry.ts`, which owns the rows and is at its size limit.

/** What a turn runs on besides its text. */
export interface QueueDispatch {
  attachments: string[];
  speechDerived: boolean;
  /** The other operator messages a send-now folded into this row (queue-merge.ts). */
  foldedMessageIds?: string[];
}

/**
 * Null and empty are NOT the same thing here, and conflating them drops files.
 * Null means no payload was ever recorded for this row - the notification,
 * workflow and plugin paths never record one - so the dispatch closure still
 * decides. An empty recorded payload means "this row runs with nothing extra",
 * which is what a message sent without a file must say, so that it never falls back
 * to whatever the dispatch closure captured.
 */
export function parseDispatchPayload(raw: string | null): QueueDispatch | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Partial<QueueDispatch>;
  const folded = parsed.foldedMessageIds?.length ? { foldedMessageIds: parsed.foldedMessageIds } : {};
  return { attachments: parsed.attachments ?? [], speechDerived: parsed.speechDerived === true, ...folded };
}

export function serializeDispatchPayload(dispatch: QueueDispatch | null): string | null {
  return dispatch === null ? null : JSON.stringify(dispatch);
}
