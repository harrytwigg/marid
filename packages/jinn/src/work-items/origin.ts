/**
 * Declared write provenance for Todo mutations.
 *
 * The gateway authenticates the principal, not the surface: a write issued by a
 * talk tool arrives as the same authenticated operator as a click in the web UI,
 * so without this the audit log cannot tell them apart. A request may DECLARE
 * the surface it came from in `X-Jinn-Origin`, and the work-item write routes
 * fold the declaration into the event they append.
 *
 * It is audit colour, never authority — nothing is granted or withheld on it, so
 * a forged header buys a caller nothing but a wrong label on their own write.
 * Only allowlisted values survive; an unrecognised declaration is dropped rather
 * than persisted, so the header cannot be used to write arbitrary strings into
 * the audit trail.
 */

import { wireHeader } from '../shared/wire-names.js';

/** Node lowercases incoming header names. */
export const WRITE_ORIGIN_HEADER = wireHeader('origin');

export const WRITE_ORIGINS = ['talk'] as const;

export type WriteOrigin = (typeof WRITE_ORIGINS)[number];

/**
 * The surface a request declares it came from, or undefined when it declares
 * nothing we recognise. The match is exact and case-sensitive: the allowlist is
 * what our own tool surfaces send verbatim, and a near-miss is a caller bug
 * better left visible than guessed at. A repeated header (node hands those over
 * as an array) is ambiguous, so it counts as no declaration.
 */
export function readWriteOrigin(header: string | string[] | undefined): WriteOrigin | undefined {
  if (typeof header !== 'string') return undefined;
  return (WRITE_ORIGINS as readonly string[]).includes(header) ? (header as WriteOrigin) : undefined;
}

/** An event's detail with the caller's origin folded in. Stays undefined when
 *  there is nothing to say, because an empty object in the audit row reads as a
 *  payload that was lost rather than one that was never there. */
export function writeDetail(
  fields: Record<string, unknown>,
  origin: WriteOrigin | undefined,
): Record<string, unknown> | undefined {
  const detail = { ...fields, ...(origin ? { origin } : {}) };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** The `created` event's detail, which the store persists as a nullable column. */
export function createdEventDetail(
  sourceRef: string | null,
  origin: WriteOrigin | undefined,
): Record<string, unknown> | null {
  return writeDetail({ ...(sourceRef ? { sourceRef } : {}) }, origin) ?? null;
}
