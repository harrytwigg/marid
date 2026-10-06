import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { BodyTooLargeError, peekedBody, readBody } from "../http-helpers.js";
import { json } from "../route-helpers.js";

/**
 * The gate decides some routes by what the body names (a target employee, a parent
 * Todo, a path), and rewrites one field on a create. It reads the JSON body once and
 * leaves it on the request for the route's own `readBody`, which returns it instead of
 * reading the (already drained) stream. The route therefore sees exactly the bytes the
 * gate judged, so there is no second parse to disagree with the first.
 */

const PEEKED = Symbol.for("jinn.department-scope.peeked-body");
const PEEK_MAX_BYTES = 4 * 1024 * 1024;

type Carrier = HttpRequest & { [PEEKED]?: string };

/** Replace the body the route will read. */
export function setPeekedBody(req: HttpRequest, body: Record<string, unknown>): void {
  (req as Carrier)[PEEKED] = JSON.stringify(body);
}

/**
 * Read the body as a JSON object for a decision. A body that is not one is left for the
 * route to refuse in its own words: the gate then has nothing to judge and returns `{}`.
 * Answers 413 itself, and returns null, for a body over the cap.
 */
export async function peekJsonObject(req: HttpRequest, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const existing = peekedBody(req);
  let raw: string;
  try {
    raw = existing ?? await readBody(req, { maxBytes: PEEK_MAX_BYTES });
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    json(res, { error: "Payload too large" }, 413);
    return null;
  }
  (req as Carrier)[PEEKED] = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
