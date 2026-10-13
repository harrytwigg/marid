/**
 * Which opencode releases each mode talks to.
 *
 * Server mode speaks the 1.x HTTP API (`/global/health`, `/event`,
 * `/session/...`). OpenCode 2 replaces that API with `/api/*` and answers every
 * route it does not know with 200 `text/html` (its web UI's fallback page), so
 * a v2 server looks alive but reports no version where server mode reads it.
 * `opencode run --format json` keeps its 1.x output on 2.x, but the v2 CLI
 * starts (and reuses) a background `serve --service` daemon unless it is passed
 * `--standalone`.
 */

/** The newest major whose HTTP API server mode speaks. */
export const MAX_OPENCODE_SERVER_MAJOR = 1;

/** The major of a dotted version (`v2.0.28` → 2), or undefined when it has none. */
export function opencodeMajor(version: string | undefined): number | undefined {
  const major = Number.parseInt((version ?? "").replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
}

/** Whether a `run` turn against this version needs `--standalone`: OpenCode 2's
 *  CLI otherwise leaves a background service behind, and a 1.x CLI rejects the flag. */
export function needsStandalone(version: string | undefined): boolean {
  return (opencodeMajor(version) ?? 0) > MAX_OPENCODE_SERVER_MAJOR;
}

/** The refusal for a server that is OpenCode 2 or newer. */
export function newerMajorReason(version: string, minServerVersion: string): string {
  return `OpenCode ${opencodeMajor(version)} (${version}) is not supported by server mode: it replaces the HTTP API server mode speaks `
    + `(server mode needs opencode ${MAX_OPENCODE_SERVER_MAJOR}.x >= ${minServerVersion}); this host's turns run in run mode`;
}

/** The refusal for a health answer that was not JSON and whose `/api/info`
 *  did not confirm what the server is. */
export function notJsonHealthReason(minServerVersion: string): string {
  return "the server answered /global/health with something other than JSON, which is how an OpenCode 2 server answers it "
    + `(OpenCode 2 is not supported by server mode, which needs opencode ${MAX_OPENCODE_SERVER_MAJOR}.x >= ${minServerVersion})`;
}
