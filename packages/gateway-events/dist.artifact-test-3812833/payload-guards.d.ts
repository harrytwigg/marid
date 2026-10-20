/** The runtime half of the event protocol: one guard per event name, checking an
 *  untrusted frame's payload against the shape ./index.js declares for it. Kept
 *  beside the map rather than in it so the protocol reads as a list of events. */
import type { GatewayEventName } from "./index.js";
type WireRecord = Record<string, unknown>;
export declare function isRecord(value: unknown): value is WireRecord;
type PayloadGuard = (value: unknown) => boolean;
/**
 * One guard per event, keyed by name. `Record<GatewayEventName, …>` is what
 * keeps the set exhaustive: adding an event to `GatewayEventMap` without a
 * guard for it fails to compile.
 */
export declare const payloadGuards: Record<GatewayEventName, PayloadGuard>;
export {};
//# sourceMappingURL=payload-guards.d.ts.map