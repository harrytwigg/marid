/**
 * The talk-session runtime's own model. These types live here rather than in
 * shared/types.ts because nothing outside src/talk/session and the gateway's
 * talk router consumes them.
 */

/**
 * `parked` means the browser dropped its provider connection — the mic is cold
 * and the provider bills nothing — while the gateway keeps the turn history and
 * the exposed-tool set. `closed` is terminal.
 */
export type TalkSessionState = "live" | "parked" | "closed";

/** Public telemetry for the one bounded image fallback used by an operator
 * utterance. The image itself never crosses the gateway accounting route. */
export interface VisualCaptureReceipt {
  requestKey: string;
  contextRevision: number;
  reason: string;
  bytes: number;
  width: number;
  height: number;
  estimatedImageTokens: number;
  latencyMs: number;
}

/** One completed exchange. The transcript is kept only to estimate context; the
 *  gateway never replays it to the provider. */
export interface TalkTurnRecord {
  at: number;
  text: string;
  estimatedTokens: number;
  visualReceipts?: VisualCaptureReceipt[];
}

/**
 * One attempted write, logged whether or not it wrote anything: a write the
 * operator waved off is the decision the audit most needs to show. The log is
 * append-only, so "was this undone" is answered by a later entry's `undoOf`
 * rather than by editing this one — a record you can retroactively amend is not
 * a record.
 */
export interface TalkActionRecord {
  id: string;
  at: number;
  /** The tool that attempted the write. */
  tool: string;
  /** What it acted on, as an app-visible id. Null when the tool has no subject. */
  subject: string | null;
  lane: "fast" | "consent";
  /** `not-required` is the fast lane's undo-backed default; the consent lane
   *  records the operator's actual answer. */
  consent: "not-required" | "granted" | "refused";
  /** Set when this entry IS the reversal of an earlier one, naming its id. */
  undoOf?: string;
}

/** One provider-owned cancellation decision. Deliberately contains no provider
 * identities, transcript, or audio: it describes detection, not content. */
export interface TalkInterruptionRecord {
  at: number;
  kind: "speech_interruption";
  vadType: "server_vad" | "semantic_vad";
  cancelledBy: "provider";
  recovered: boolean;
  speechMs: number | null;
}

export interface TalkSession {
  id: string;
  /** Server-minted browser binding for provider evidence sent by this tab. */
  browserInstanceId: string;
  /** Increments whenever the gateway issues a successor provider credential. */
  credentialGeneration: number;
  /** The `sessions` row this talk session bills through, so its spend shows up
   *  in the cost report alongside every other session. */
  sessionId: string;
  state: TalkSessionState;
  model: string;
  /** What this instance is, built once when the session opens. The org is
   *  scanned from disk, and a conversation that re-read it per heartbeat would
   *  pay for a roster that cannot change under it mid-session. */
  brief: string;
  openedAt: number;
  /** Last heartbeat. The reaper closes a session that stops sending them. */
  lastSeenAt: number;
  turns: TalkTurnRecord[];
  /** How many turns truncation has dropped over this session's life. */
  truncatedTurns: number;
  /** Expiry of the credential last handed to the client, in provider seconds.
   *  Every credential after it has to outlive it, or the client cannot tell a
   *  re-mint from a replay of the one it already holds. */
  tokenExpiresAt: number;
  /** Tool names already in the provider's session, always-on set included. */
  exposedTools: string[];
  /** Every write this session attempted, oldest first. */
  actions: TalkActionRecord[];
  /** Bounded, content-free interruption decisions, oldest first. */
  interruptions?: TalkInterruptionRecord[];
  /** Receipt identities already accepted, bounded with the action audit. */
  visualReceiptKeys: string[];
}

export interface TalkSessionReadOptions {
  includeClosed?: boolean;
}

/** Storage boundary kept deliberately smaller than SQLite so tests and callers
 * can retain the existing in-memory registry construction. */
export interface TalkSessionStore {
  get(id: string, options?: TalkSessionReadOptions): TalkSession | undefined;
  list(options?: TalkSessionReadOptions): TalkSession[];
  save(session: TalkSession): void;
}
