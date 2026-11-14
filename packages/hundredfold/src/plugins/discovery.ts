import fs from "node:fs/promises";
import path from "node:path";
import { PLUGINS_DIR } from "../shared/paths.js";
import { resolveContainedPath, validateManifest, type PluginManifest } from "./manifest.js";

/** `disabled` is applied by the caller that knows the operator's lists, not here. */
export type PluginStatus = "loaded" | "disabled" | "error";

/** One inventory row. A directory that fails validation still gets one, because a
 *  plugin that vanishes from the settings list when it breaks is one nobody can fix. */
export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  kind: "client" | "client+server";
  status: PluginStatus;
  error?: string;
}

/** An inventory row plus the paths the gateway serves that plugin from. */
export interface DiscoveredPlugin extends PluginRecord {
  /** Absolute plugin directory. */
  dir: string;
  /** Absolute client entry, or null when the plugin failed to load. */
  client: string | null;
  /** Absolute server entry, or null when it is absent or was rejected. */
  server: string | null;
}

/** The wire shape, built field by field so a resolved local path cannot ride along. */
export function inventoryRow(plugin: DiscoveredPlugin): PluginRecord {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    kind: plugin.kind,
    status: plugin.status,
    ...(plugin.error ? { error: plugin.error } : {}),
  };
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isPresent(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** An unloadable directory, recorded under its folder name. `kind` states the
 *  minimum a plugin is made of, since a row that never loaded declared nothing. */
function errorRow(dir: string, error: string): DiscoveredPlugin {
  return {
    id: path.basename(dir),
    name: path.basename(dir),
    version: "0.0.0",
    kind: "client",
    status: "error",
    error,
    dir,
    client: null,
    server: null,
  };
}

type ManifestRead = { dir: string; manifest: PluginManifest };

async function readManifest(dir: string): Promise<ManifestRead | DiscoveredPlugin | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf-8"));
  } catch (err) {
    // The folder can vanish between the scan listing it and this read. Gone is
    // "not installed", not a load error; still there with no manifest is an error.
    if (isMissing(err) && !(await isPresent(dir))) return null;
    if (isMissing(err)) return errorRow(dir, "plugin.json is missing");
    return errorRow(dir, `plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateManifest(raw, dir);
  if (!result.ok) return errorRow(dir, result.error);

  const resolvedDir = await fs.realpath(dir).catch(() => null);
  if (!resolvedDir) return errorRow(dir, "plugin directory is unavailable");
  return { dir: resolvedDir, manifest: result.manifest };
}

async function readPlugin(dir: string): Promise<DiscoveredPlugin | null> {
  const loaded = await readManifest(dir);
  if (!loaded || "status" in loaded) return loaded;

  const { manifest, dir: resolvedDir } = loaded;
  if (!(await exists(manifest.client))) {
    return errorRow(dir, `client entry "${path.relative(dir, manifest.client)}" is missing`);
  }
  const client = await resolveContainedPath(resolvedDir, manifest.client);
  if (!client) {
    return errorRow(dir, `client entry "${path.relative(resolvedDir, manifest.client)}" resolves outside the plugin directory`);
  }

  const declaredServer = manifest.server;
  let server = declaredServer;
  let serverError = manifest.serverError;
  if (declaredServer && (await exists(declaredServer))) {
    const resolvedServer = await resolveContainedPath(resolvedDir, declaredServer);
    if (resolvedServer) server = resolvedServer;
    else {
      server = null;
      serverError = `server entry "${path.relative(resolvedDir, declaredServer)}" resolves outside the plugin directory`;
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: server ? "client+server" : "client",
    status: "loaded",
    ...(serverError ? { error: serverError } : {}),
    dir: resolvedDir,
    client,
    server,
  };
}

async function readInstalledPlugins(): Promise<DiscoveredPlugin[]> {
  let entries;
  try {
    entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  } catch (err) {
    // An absent plugins/ directory is zero plugins, not an error.
    if (isMissing(err)) return [];
    throw err;
  }
  const dirs = (
    await Promise.all(
      entries.map(async (entry) => {
        const dir = path.join(PLUGINS_DIR, entry.name);
        if (entry.isDirectory()) return dir;
        if (!entry.isSymbolicLink()) return null;
        try {
          return (await fs.stat(dir)).isDirectory() ? dir : null;
        } catch {
          return dir;
        }
      }),
    )
  ).filter((dir): dir is string => dir !== null);
  const plugins = await Promise.all(dirs.map(readPlugin));
  return plugins
    .filter((plugin): plugin is DiscoveredPlugin => plugin !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

let inFlight: Promise<DiscoveredPlugin[]> | null = null;

/**
 * The whole inventory, read from disk.
 *
 * Concurrent callers share one scan: reads can outlast the watcher's debounce
 * window, and a rescan landing on top of a scan that is still running would
 * report an inventory assembled from two different moments.
 */
export function scanPlugins(): Promise<DiscoveredPlugin[]> {
  if (inFlight) return inFlight;
  inFlight = readInstalledPlugins().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The one plugin an `/api/plugins/<id>/…` request names, or null when nothing is
 *  installed under that id. */
export function loadPlugin(id: string): Promise<DiscoveredPlugin | null> {
  return readPlugin(path.join(PLUGINS_DIR, id));
}
