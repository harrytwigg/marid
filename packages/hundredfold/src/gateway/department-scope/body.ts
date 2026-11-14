import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { BodyTooLargeError, PEEKED_BODY as PEEKED, peekedBody, readBody } from "../http-helpers.js";
import { json } from "../route-helpers.js";

/**
 * The gate decides some routes by what the body names (a target employee, a parent
 * Todo, a path), and rewrites one field on a create. It reads the JSON body once and
 * leaves it on the request for the route's own `readBody`, which returns it instead of
 * reading the (already drained) stream. The route therefore sees exactly the bytes the
 * gate judged, so there is no second parse to disagree with the first.
 */


const PEEK_MAX_BYTES = 4 * 1024 * 1024;

type Carrier = HttpRequest & { [PEEKED]?: string };

/** Replace the body the route will read. */
export function setPeekedBody(req: HttpRequest, body: Record<string, unknown>): void {
  (req as Carrier)[PEEKED] = JSON.stringify(body);
}

/**
 * Read the body as a JSON object for a decision. Returns null once the gate has answered
 * (413 for a body over the cap), and undefined when the body is not a JSON object: the
 * route cannot act on such a body either, so the gate leaves it untouched for the route to
 * refuse in its own words.
 */
export async function peekJsonObject(req: HttpRequest, res: ServerResponse): Promise<Record<string, unknown> | null | undefined> {
  let raw: string;
  try {
    raw = peekedBody(req) ?? await readBody(req, { maxBytes: PEEK_MAX_BYTES });
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    json(res, { error: "Payload too large" }, 413);
    return null;
  }
  (req as Carrier)[PEEKED] = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
