/** Content-Type by extension for the files served out of the built web UI.
 *
 * Anything absent falls back to application/octet-stream at the call site, and
 * a browser will not execute or parse that — so an extension the web build
 * starts emitting has to be added here or it fails opaquely. */
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
