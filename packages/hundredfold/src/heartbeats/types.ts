/**
 * A wake-up a session scheduled for itself: `message` is delivered back into
 * `ownerSessionId` every `everySeconds`, verbatim, until it is stopped or one of
 * its own limits disarms it. `nextFireAt` is persisted so a gateway restart
 * resumes the interval instead of replaying every tick it slept through.
 */
export interface Heartbeat {
  id: string;
  ownerSessionId: string;
  message: string;
  everySeconds: number;
  nextFireAt: number;
  fireCount: number;
  maxFires: number | null;
  expiresAt: number | null;
  status: "armed" | "disarmed";
  createdAt: string;
  disarmedAt: string | null;
  disarmedReason: string | null;
  /** Set on a gateway-owned heartbeat (e.g. `child-watch`); null when a session armed it. */
  purpose: string | null;
}
