/**
 * The bounded ring one plugin's backend writes through `ctx.emit`, read back by
 * cursor over polling and over the events socket.
 *
 * In memory and per process by design: this is the channel a plugin's own UI
 * watches, not a record anything may depend on. The cursor is what makes polling
 * a complete fallback for the socket, so a client that can only poll still sees
 * every event the ring still holds.
 */

/** How many events one plugin retains. Past this the oldest are dropped, and a
 *  reader whose cursor predates the oldest survivor is told so rather than
 *  handed a silent gap. */
export const PLUGIN_EVENT_RING_SIZE = 200;

export interface PluginEventRecord {
  /** Strictly increasing per plugin for the life of the process. Never reused,
   *  and never reset when the ring wraps — a cursor names a position in the
   *  plugin's whole emission history, not a slot in the buffer. */
  cursor: number;
  event: unknown;
}

export interface PluginEventPage {
  events: PluginEventRecord[];
  /** What to ask for next. The newest cursor this plugin has reached, which is
   *  the last of `events` whenever the page is not empty. */
  cursor: number;
  /** True when events after the caller's cursor were evicted before it read
   *  them. The caller has a gap, and saying so beats letting it assume it does
   *  not. */
  dropped: boolean;
}

type PluginEventListener = (record: PluginEventRecord) => void;

interface Ring {
  records: PluginEventRecord[];
  nextCursor: number;
  listeners: Set<PluginEventListener>;
}

/** One ring per plugin id. A plugin cannot name another's, because nothing a
 *  plugin calls takes an id — `ctx.emit` closes over its own. */
const rings = new Map<string, Ring>();

function ringFor(id: string): Ring {
  const existing = rings.get(id);
  if (existing) return existing;
  const ring: Ring = { records: [], nextCursor: 1, listeners: new Set() };
  rings.set(id, ring);
  return ring;
}

/** The event as JSON, or null when it is not something the wire can carry. */
function serializable(event: unknown): boolean {
  try {
    return JSON.stringify(event) !== undefined;
  } catch {
    // Circular structures and BigInt throw rather than returning undefined.
    return false;
  }
}

/**
 * Append one event to a plugin's ring and hand it to that plugin's subscribers.
 *
 * Listener errors are not caught here: the only subscriber is the events socket,
 * which guards its own send, and swallowing here would hide a gateway bug inside
 * a plugin's call to `emit`.
 */
export function appendPluginEvent(id: string, event: unknown): void {
  if (!serializable(event)) {
    // Refused before it reaches the ring, so the failure lands on the plugin's
    // own `emit()` call rather than later, inside a send it cannot see.
    throw new TypeError(`plugin events must be JSON-serializable; emit() got ${typeof event}`);
  }
  const ring = ringFor(id);
  const record: PluginEventRecord = { cursor: ring.nextCursor++, event };
  ring.records.push(record);
  if (ring.records.length > PLUGIN_EVENT_RING_SIZE) ring.records.shift();
  for (const listener of [...ring.listeners]) listener(record);
}

/** This plugin's events after `since`, or its whole retained buffer when the
 *  caller has no cursor yet. */
export function readPluginEvents(id: string, since?: number): PluginEventPage {
  const ring = rings.get(id);
  if (!ring) return { events: [], cursor: 0, dropped: false };

  const cursor = ring.nextCursor - 1;
  if (since === undefined) return { events: [...ring.records], cursor, dropped: false };

  // The next event the caller wants is `since + 1`. If the oldest survivor is
  // newer than that, everything between the two was evicted unread.
  const oldest = ring.records[0]?.cursor ?? ring.nextCursor;
  return {
    events: ring.records.filter((record) => record.cursor > since),
    cursor,
    dropped: since < oldest - 1,
  };
}

/** Follow one plugin's appends. The returned function unsubscribes. */
export function subscribePluginEvents(id: string, listener: PluginEventListener): () => void {
  const ring = ringFor(id);
  ring.listeners.add(listener);
  return () => {
    ring.listeners.delete(listener);
  };
}
