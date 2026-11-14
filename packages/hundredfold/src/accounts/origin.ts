import type { IncomingMessage } from "node:http";
import { requestArrivedOverHttps } from "../gateway/auth.js";

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const head = raw?.split(",")[0]?.trim();
  return head ? head : undefined;
}

/** The origin a person reached the gateway at, which is what an invite or reset link has to point back to. */
export function requestOrigin(req: Pick<IncomingMessage, "headers" | "socket">): string | null {
  const host = first(req.headers["x-forwarded-host"]) ?? first(req.headers.host);
  if (!host) return null;
  try {
    return new URL(`${requestArrivedOverHttps(req) ? "https" : "http"}://${host}`).origin;
  } catch {
    return null;
  }
}
