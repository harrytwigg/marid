const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
const KNOWLEDGE_ROOTS = new Set(["knowledge", "docs"]);
const MANAGED_ROOTS = new Set(["files", "uploads"]);

export type FileReadRequest =
  | { ok: true; url: string; rawUrl?: string }
  | { ok: false; error: string };

const SUPPORTED_ROOT_RE = /^(?:knowledge|docs|files|uploads)\//;

/**
 * A path outside the instance's own roots is read where the SESSION that named
 * it runs (absolute, `~/`, or relative to its working directory; local or on a
 * build host). Only a link that knows its session can be opened this way.
 */
function sessionFileRequest(path: string, sessionId: string): FileReadRequest {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/files`;
  try {
    const query = `?path=${encodeURIComponent(path)}`;
    return { ok: true, url: `${base}/read${query}`, rawUrl: `${base}/raw${query}` };
  } catch {
    return { ok: false, error: "File path contains invalid Unicode" };
  }
}

/** Build the scoped gateway request for a path already decoded once by the UI.
 *  `sessionId` is the chat the path was linked from, when there is one. */
export function buildFileReadRequest(path: string, sessionId?: string | null): FileReadRequest {
  if (!path) return { ok: false, error: "No file path provided" };
  if (path !== path.trim()) {
    return { ok: false, error: "File path must not have leading or trailing whitespace" };
  }
  if (CONTROL_BYTES.test(path)) {
    return { ok: false, error: "File path contains control bytes" };
  }
  if (sessionId && !SUPPORTED_ROOT_RE.test(path)) return sessionFileRequest(path, sessionId);
  if (path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return { ok: false, error: "File path must be relative to a supported root" };
  }
  if (path.includes("\\")) {
    return { ok: false, error: "File path must use forward slash separators" };
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, error: "File path contains traversal segments" };
  }
  if (segments.some((segment) => segment === "")) {
    return { ok: false, error: "File path must be a normalized relative path" };
  }

  const root = segments[0];
  try {
    if (KNOWLEDGE_ROOTS.has(root)) {
      return { ok: true, url: `/api/knowledge/read?path=${encodeURIComponent(path)}` };
    }
    if (MANAGED_ROOTS.has(root)) {
      // `path` is already decoded once by URLSearchParams. Encode its segments
      // once for this request so literal `%2F` filename text travels as `%252F`
      // and the gateway receives `%2F` as data, never as a path separator.
      const encodedPath = segments.map(encodeURIComponent).join("/");
      return { ok: true, url: `/api/files/read?path=${encodedPath}` };
    }
  } catch {
    return { ok: false, error: "File path contains invalid Unicode" };
  }

  return {
    ok: false,
    error: "Unsupported file root; expected knowledge/, docs/, files/, or uploads/",
  };
}
