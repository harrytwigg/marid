/** PLA-157: the stop cause a blocked Todo carries on the wire, and the
 *  one rule for reading it.
 *
 *  A Todo waiting out a quota window and a Todo waiting on a person both sit in
 *  `blocked`. `parkedUntil` says the first is a clock-wait and when
 *  it ends; `unblockHint` says the second is a you-wait and whose move it is. */
export interface TodoUnblockHintWire {
  what: string
  who: string
}

export interface TodoStopCauseWire {
  /** ISO instant the wait is over (older gateways omit it, and the gateway drops
   *  it once it has passed). */
  parkedUntil?: string
  /** What has to happen and who has to do it (older gateways omit it). */
  unblockHint?: TodoUnblockHintWire
  /** Todo-recovery attention lane (older gateways omit it). */
  attentionLane?: "recovering" | "manager" | "operator" | null
}

/** Expiry is what the clock says, not what a sweeper got around to, so the board
 *  can stop showing a countdown the second it runs out without waiting for a
 *  refetch. A park that will not parse is not a park either: fail-open is the
 *  only safe direction for a field that hides work from the operator. */
export function isParked(parkedUntil: string | null | undefined, now = Date.now()): boolean {
  if (!parkedUntil) return false
  const at = Date.parse(parkedUntil)
  return !Number.isNaN(at) && at > now
}
