import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_NAMES, NAMES, currentInstanceName, isDefaultInstanceName, sameInstanceName, type Names } from "../shared/codename.js";
import { readEnv } from "../shared/codename-env.js";

export const INSTANCE_DIRECTORY_SCHEMA_VERSION = 2 as const;

export interface InstanceAccessUrls {
  local?: string;
  remote?: string;
}

export interface Instance {
  id: string;
  name: string;
  displayName?: string;
  port: number;
  home: string;
  createdAt: string;
  kind?: "workspace" | "sandbox";
  pinned?: boolean;
  accessUrls?: InstanceAccessUrls;
}

export type InstanceInput = Omit<Instance, "id"> & { id?: string };

interface InstanceDirectoryFile {
  schemaVersion: typeof INSTANCE_DIRECTORY_SCHEMA_VERSION;
  instances: Instance[];
}

export interface HostPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DirectoryOptions {
  registryPath?: string;
  legacyRegistryPath?: string;
  /** Where an earlier codename kept the registry: read, and carried forward, when the current path has none. */
  previousRegistryPath?: string | null;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The host-level directory the registry lives in: named for the codename, in the form each platform uses. */
export function resolveHostDataDir(options: HostPathOptions & { names?: Names } = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const names = options.names ?? NAMES;
  const p = pathApi(platform);
  if (platform === "darwin") return p.join(home, "Library", "Application Support", names.title);
  if (platform === "win32") return p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), names.title);
  return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), names.codename);
}

export function resolveInstancesRegistryPath(options: HostPathOptions = {}): string {
  const env = options.env ?? process.env;
  return readEnv(env, "INSTANCES_REGISTRY") || pathApi(options.platform ?? process.platform).join(
    resolveHostDataDir(options),
    "instances.json",
  );
}

/** Where the legacy codename kept the registry, or null while the codename is unchanged or an override names the file. */
export function resolvePreviousInstancesRegistryPath(options: HostPathOptions = {}): string | null {
  const env = options.env ?? process.env; // footgun: ok the same fallback as resolveInstancesRegistryPath above, which decides the same override
  if (!NAMES.renamed || readEnv(env, "INSTANCES_REGISTRY")) return null;
  return pathApi(options.platform ?? process.platform).join(resolveHostDataDir({ ...options, names: LEGACY_NAMES }), "instances.json");
}

export function resolveLegacyInstancesRegistryPath(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  return pathApi(platform).join(options.home ?? os.homedir(), ".jinn", "instances.json");
}

function invalid(message: string): never {
  throw new Error(`Invalid workspace directory: ${message}`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeAccessUrls(value: unknown): InstanceAccessUrls | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("accessUrls must be an object");
  const raw = value as Record<string, unknown>;
  const local = optionalString(raw.local, "accessUrls.local");
  const remote = optionalString(raw.remote, "accessUrls.remote");
  for (const candidate of [local, remote]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid("access URLs must use http or https");
    } catch {
      invalid("access URLs must be valid URLs");
    }
  }
  return local || remote ? { ...(local ? { local } : {}), ...(remote ? { remote } : {}) } : undefined;
}

function normalizeInstance(value: unknown): Instance {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("each instance must be an object");
  const raw = value as Record<string, unknown>;
  const name = optionalString(raw.name, "name");
  const home = optionalString(raw.home, "home");
  const createdAt = optionalString(raw.createdAt, "createdAt");
  if (!name || !home || !createdAt) invalid("name, home, and createdAt are required");
  if (!Number.isSafeInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65_535) {
    invalid("port must be an integer between 1 and 65535");
  }
  if (!path.isAbsolute(home) && !path.win32.isAbsolute(home)) invalid("home must be absolute");
  const id = optionalString(raw.id, "id") ?? crypto.randomUUID();
  const displayName = optionalString(raw.displayName, "displayName");
  const kind = raw.kind;
  if (kind !== undefined && kind !== "workspace" && kind !== "sandbox") invalid("kind must be workspace or sandbox");
  if (raw.pinned !== undefined && typeof raw.pinned !== "boolean") invalid("pinned must be boolean");
  const normalizedKind = kind ?? "workspace";
  const pinned = typeof raw.pinned === "boolean" ? raw.pinned : normalizedKind === "workspace";
  return {
    id,
    name,
    ...(displayName ? { displayName } : {}),
    port: raw.port as number,
    home,
    createdAt,
    kind: normalizedKind,
    pinned,
    ...(raw.accessUrls === undefined ? {} : { accessUrls: normalizeAccessUrls(raw.accessUrls) }),
  };
}

function parseDirectory(contents: string): { instances: Instance[]; needsWrite: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return invalid("file is not valid JSON");
  }
  if (Array.isArray(parsed)) return { instances: parsed.map(normalizeInstance), needsWrite: true };
  if (!parsed || typeof parsed !== "object") return invalid("root must be an object");
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== INSTANCE_DIRECTORY_SCHEMA_VERSION) invalid(`unsupported schema version ${String(raw.schemaVersion)}`);
  if (!Array.isArray(raw.instances)) invalid("instances must be an array");
  const rawInstances = raw.instances as unknown[];
  const instances = rawInstances.map(normalizeInstance);
  const needsWrite = instances.some((instance, index) => {
    const original = rawInstances[index] as Record<string, unknown>;
    return original.id !== instance.id
      || original.kind !== instance.kind
      || original.pinned !== instance.pinned;
  });
  return { instances, needsWrite };
}

function writeDirectory(registryPath: string, instances: Instance[]): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  const file: InstanceDirectoryFile = { schemaVersion: INSTANCE_DIRECTORY_SCHEMA_VERSION, instances };
  const tmp = `${registryPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, registryPath);
    try { fs.chmodSync(registryPath, 0o600); } catch { /* Windows and restrictive filesystems */ }
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function loadInstances(options: DirectoryOptions = {}): Instance[] {
  const registryPath = options.registryPath ?? resolveInstancesRegistryPath();
  const legacyRegistryPath = options.legacyRegistryPath ?? resolveLegacyInstancesRegistryPath();
  const previousRegistryPath = options.previousRegistryPath === undefined ? resolvePreviousInstancesRegistryPath() : options.previousRegistryPath;
  let source = registryPath;
  if (!fs.existsSync(source)) {
    // The registry an earlier codename wrote is carried forward, as the v0.26 one always was.
    const carried = [previousRegistryPath, legacyRegistryPath].find((candidate): candidate is string => (
      candidate !== null && path.resolve(candidate) !== path.resolve(registryPath) && fs.existsSync(candidate)
    ));
    if (!carried) return [];
    source = carried;
  }
  let parsed: ReturnType<typeof parseDirectory>;
  try {
    parsed = parseDirectory(fs.readFileSync(source, "utf8"));
  } catch (error) {
    // v0.26/v0.27 treated a malformed ~/.jinn/instances.json as an empty
    // directory. Preserve that upgrade behavior, keep the legacy file intact
    // for recovery, and seed the new host-level registry with a valid schema.
    if (source === registryPath) throw error;
    parsed = { instances: [], needsWrite: true };
  }
  if (source !== registryPath || parsed.needsWrite) writeDirectory(registryPath, parsed.instances);
  return parsed.instances;
}

export function saveInstances(instances: InstanceInput[], options: Pick<DirectoryOptions, "registryPath"> = {}): void {
  const normalized = instances.map(normalizeInstance);
  writeDirectory(options.registryPath ?? resolveInstancesRegistryPath(), normalized);
}

export function nextAvailablePort(instances: Pick<Instance, "port">[]): number {
  const usedPorts = new Set(instances.map((instance) => instance.port));
  let port = 7777;
  while (usedPorts.has(port)) port += 1;
  return port;
}

export function ensureDefaultInstance(): void {
  const instances = loadInstances();
  // An entry an earlier codename wrote is the default instance too: a second one would be a second identity.
  if (instances.some((instance) => isDefaultInstanceName(instance.name))) return;
  saveInstances([{
    name: NAMES.codename,
    displayName: "Jinn",
    port: 7777,
    home: path.join(os.homedir(), `.${NAMES.codename}`),
    createdAt: new Date().toISOString(),
    kind: "workspace",
    pinned: true,
  }, ...instances]);
}

export function findInstance(name: string): Instance | undefined {
  return loadInstances().find((instance) => sameInstanceName(instance.name, name));
}

/**
 * Record that an instance's home has moved to this build's naming: its name takes the current
 * spelling and its home the new path. The entry is found by the home it had (or, failing that, by
 * name), so a registry that already says the new thing is left as it is. Returns whether it changed.
 */
export function recordInstanceRenamed(
  move: { fromHome: string; toHome: string; name?: string },
  options: DirectoryOptions = {},
): boolean {
  const instances = loadInstances(options);
  const index = instances.findIndex((instance) => path.resolve(instance.home) === path.resolve(move.fromHome));
  const byName = index >= 0 || move.name === undefined ? index : instances.findIndex((instance) => sameInstanceName(instance.name, move.name!));
  if (byName < 0) return false;
  const entry = instances[byName];
  const next: Instance = { ...entry, name: currentInstanceName(entry.name), home: path.resolve(move.toHome) };
  if (next.name === entry.name && next.home === entry.home) return false;
  instances[byName] = next;
  saveInstances(instances, options);
  return true;
}
