/**
 * Which opencode releases each mode talks to.
 *
 * Server mode speaks two HTTP APIs. opencode 1.x serves `/global/health`,
 * `/event` and `/session/...`; OpenCode 2 replaces them with `/api/*`
 * (`/api/info`, `/api/event`, `/api/session/...`) and answers every route it
 * does not know with 200 `text/html` (its web UI's fallback page). So a server's
 * health answer says which API it speaks: JSON from 1.x, the web page from 2.x,
 * whose version is then on `/api/info`. A host can be upgraded on its own: each
 * server is driven in the API its own version speaks (`opencode-server-turn.ts`
 * for 1.x, `opencode-v2-turn.ts` for 2.x).
 *
 * `opencode run --format json` keeps its 1.x output on 2.x, but the v2 CLI
 * starts (and reuses) a background `serve --service` daemon unless it is passed
 * `--standalone`.
 */

/** The newest major whose HTTP API server mode speaks. */
export const MAX_OPENCODE_SERVER_MAJOR = 2;

/** The oldest OpenCode 2 server mode runs against: the version its `/api/*`
 *  routes, event stream and message shapes were verified on. */
export const MIN_OPENCODE_V2_SERVER_VERSION = "2.0.28";

/** Which HTTP API a server speaks. */
export type OpencodeApi = 1 | 2;

/** The major of a dotted version (`v2.0.28` → 2), or undefined when it has none. */
export function opencodeMajor(version: string | undefined): number | undefined {
  const major = Number.parseInt((version ?? "").replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
}

/** The API a server of this version speaks. */
export function opencodeApiOf(version: string | undefined): OpencodeApi {
  return opencodeMajor(version) === 2 ? 2 : 1;
}

/** Whether a `run` turn against this version needs `--standalone`: OpenCode 2's
 *  CLI otherwise leaves a background service behind, and a 1.x CLI rejects the
 *  flag. Only 2.x is known to take it; a later major is left as it is. */
export function needsStandalone(version: string | undefined): boolean {
  return opencodeMajor(version) === 2;
}

/** The refusal for a server newer than the newest API server mode speaks. */
export function newerMajorReason(version: string): string {
  return `OpenCode ${opencodeMajor(version)} (${version}) is not supported by server mode, which speaks the opencode 1.x and `
    + `OpenCode ${MAX_OPENCODE_SERVER_MAJOR}.x APIs; this host's turns run in run mode`;
}

/** The refusal for a health answer that was not JSON and whose `/api/info`
 *  did not say what the server is. */
export function notJsonHealthReason(): string {
  return "the server answered /global/health with something other than JSON, as an OpenCode 2 server does, "
    + "but did not report its version on /api/info";
}
