/**
 * `GET /api/talk/config` — what the voice surface needs to know before it asks
 * for a session.
 *
 * The orb has to answer "is voice set up here?" without minting anything:
 * minting is a billed call to the provider, so an operator with no provider
 * configured would be charged to be told they have none. This route reports
 * capability only — the providers the gateway implements, and whether the
 * configured one would actually build. The answer is a boolean rather than the
 * `realtime` block itself so that no shape of this response can carry the key.
 * The voice list is the one piece of provider knowledge it does hand over: a
 * picker needs it, and it is public information about the provider, not about
 * this account.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HundredfoldConfig } from "../shared/types.js";
import { REALTIME_PROVIDERS, isRealtimeConfigured, realtimeProviderVoices } from "../talk/realtime/index.js";

/**
 * Handle `/api/talk/config`, returning false for anything else so the caller
 * falls through to the rest of the talk router.
 */
export function handleTalkConfigApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: HundredfoldConfig,
): boolean {
  if (pathname !== "/api/talk/config" || (req.method ?? "GET") !== "GET") return false;
  const realtime = config.realtime ?? {};
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      configured: isRealtimeConfigured(realtime),
      provider: realtime.provider ?? null,
      providers: REALTIME_PROVIDERS,
      // The configured provider's own voices, so Settings can offer a picker
      // without the browser bundle holding provider knowledge.
      voices: realtimeProviderVoices(realtime.provider),
    }),
  );
  return true;
}
