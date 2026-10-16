import fs from "node:fs/promises";
import path from "node:path";
import { nameAliases } from "../shared/codename.js";

/**
 * A plugin id is a namespace: it names a directory in the instance home, the
 * `/api/plugins/<id>` route prefix, and the inventory row. `jinn` is reserved for
 * the gateway itself, the same way a custom MCP server may not claim it
 * (mcp/resolver.ts) — a caller that trusts a well-known id must not be reachable
 * by a user-supplied one.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** Both codenames: a plugin installed before a rename may not take the new one either. */
const RESERVED_IDS = nameAliases((n) => n.codename);

/** The client half is optional to declare, not optional to have. */
const DEFAULT_CLIENT = "client.js";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Absolute path to the client entry. */
  client: string;
  /** Absolute path to the server entry; null when the manifest declares none. */
  server: string | null;
  /** Why a declared `server` entry was dropped. The client half still loads. */
  serverError?: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

/**
 * Is `target` inside `root`? Separator-aware on purpose. The string-prefix check
 * serveStatic uses (server.ts) accepts a sibling directory whose name merely
 * extends the root — `plugins/safe-extra` passes a prefix test against
 * `plugins/safe` — and every path this module resolves comes from a manifest.
 */
export function isContainedIn(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** Resolve both paths before testing containment, so a symlink cannot turn a
 * lexically-contained entry into one that reaches outside its permitted root. */
export async function resolveContainedPath(root: string, target: string): Promise<string | null> {
  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    return isContainedIn(resolvedRoot, resolvedTarget) ? resolvedTarget : null;
  } catch {
    return null;
  }
}

type EntryResult = { ok: true; path: string } | { ok: false; error: string };

/** One manifest entry resolved against the plugin directory it must stay inside. */
function resolveEntry(dir: string, field: "client" | "server", value: unknown): EntryResult {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${field} must be a non-empty relative path` };
  }
  // An absolute path swallows the base entirely: joining "/tmp/evil.js" onto the
  // plugin directory resolves to "/tmp/evil.js", and whatever resolves is what
  // gets imported or served.
  if (path.isAbsolute(value)) {
    return { ok: false, error: `${field} "${value}" must be relative to the plugin directory` };
  }
  const resolved = path.resolve(dir, value);
  if (!isContainedIn(dir, resolved)) {
    return { ok: false, error: `${field} "${value}" resolves outside the plugin directory` };
  }
  return { ok: true, path: resolved };
}

type StringResult = { ok: true; value: string } | { ok: false; error: string };

function optionalString(fields: Record<string, unknown>, field: string, fallback: string): StringResult {
  const value = fields[field];
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: `${field} must be a non-empty string` };
  return { ok: true, value: value.trim() };
}

/** The id, held to its shape, to the reserved name, and to its own folder — which
 *  the manifest repeats as a consistency check, not as a second source of truth,
 *  so a disagreement names both rather than silently preferring one. */
function validateId(value: unknown, folder: string): StringResult {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "id must be a non-empty string" };
  }
  const id = value.trim();
  if (!PLUGIN_ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: `id "${id}" must be 2-39 characters of lowercase letters, digits and hyphens, starting with a letter or digit`,
    };
  }
  if (RESERVED_IDS.includes(id)) return { ok: false, error: `id "${id}" is reserved for the gateway` };
  if (id !== folder) return { ok: false, error: `id "${id}" does not match its folder name "${folder}"` };
  return { ok: true, value: id };
}

type EntriesResult =
  | { ok: true; client: string; server: string | null; serverError?: string }
  | { ok: false; error: string };

/** Both halves resolved against the plugin directory, and checked against each other. */
function resolveEntries(fields: Record<string, unknown>, dir: string): EntriesResult {
  const client = resolveEntry(dir, "client", fields.client === undefined ? DEFAULT_CLIENT : fields.client);
  if (!client.ok) return client;

  // A rejected server path is a partial load: the plugin is degraded, not gone,
  // and its row says why. An equal pair below is the exception, because keeping
  // the client half is precisely what would serve the backend file.
  let server: string | null = null;
  let serverError: string | undefined;
  if (fields.server !== undefined) {
    const resolved = resolveEntry(dir, "server", fields.server);
    if (resolved.ok) server = resolved.path;
    else serverError = resolved.error;
  }

  // Sameness is decided on the resolved paths, not on the strings an author
  // wrote: "server.js", "./server.js" and "assets/../server.js" all name one file.
  if (server !== null && server === client.path) {
    return {
      ok: false,
      error: `client and server must name different files; both resolve to ${path.relative(dir, server)}`,
    };
  }
  return { ok: true, client: client.path, server, ...(serverError ? { serverError } : {}) };
}

/** Validate a parsed `plugin.json` against the directory it was read from. */
export function validateManifest(raw: unknown, dir: string): ManifestResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "plugin.json must contain a JSON object" };
  }
  const fields = raw as Record<string, unknown>;

  const id = validateId(fields.id, path.basename(dir));
  if (!id.ok) return id;
  const name = optionalString(fields, "name", id.value);
  if (!name.ok) return name;
  const version = optionalString(fields, "version", "0.0.0");
  if (!version.ok) return version;
  const entries = resolveEntries(fields, dir);
  if (!entries.ok) return entries;

  return {
    ok: true,
    manifest: {
      id: id.value,
      name: name.value,
      version: version.value,
      client: entries.client,
      server: entries.server,
      ...(entries.serverError ? { serverError: entries.serverError } : {}),
    },
  };
}
