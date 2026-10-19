import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../shared/logger.js";

/**
 * Finding an opencode internal model fallback on a host.
 *
 * Marid owns fallback (docs/fallback-chains.md): opencode runs without one of
 * its own. A host can still carry one the operator installed, either the
 * `opencode-rate-limit` plugin or a `model-fallback.js` plugin file, driven by
 * a `rate-limit-fallback.json`. Such a plugin moves a turn to another model
 * on a usage limit, behind the gateway's back, so the gateway's chain and the
 * plugin would both fall back.
 *
 * It cannot be switched off for gateway sessions alone (verified on opencode
 * 1.19.0 and 2.0.29): a staged `OPENCODE_CONFIG` merges its plugin list into
 * the operator's, a same-named staged plugin does not replace it, 2.x has no
 * environment switch, and 1.x's `OPENCODE_PURE` drops every external plugin,
 * the operator's provider-auth plugins and the gateway's own staged plugin
 * included. So it is reported rather than neutralised, and `neutralised` is
 * always false. Nothing here writes to the operator's files.
 */

export interface OpencodeInternalFallback {
  detected: boolean;
  /** Whether the gateway switches the fallback off for its sessions. Never, today. */
  neutralised: boolean;
  /** Where it was found: the operator's own paths, so keep them out of info-level logs. */
  sources: string[];
  /** The remote hosts' share of `sources`, by host label (additive; absent when none reported one). */
  remote?: Array<{ host: string; sources: string[] }>;
}

/** Plugin names (a package name, or a plugin file's name without extension) that are a model fallback. */
const FALLBACK_PLUGINS = ["opencode-rate-limit", "model-fallback"];
const PLUGIN_FILE_RE = /^(opencode-rate-limit|model-fallback)\.(?:[cm]?js|ts)$/;
const CONFIG_FILES = ["opencode.json", "opencode.jsonc", "config.json"];
const PLUGIN_DIRS = ["plugin", "plugins"];
const FALLBACK_SETTINGS = "rate-limit-fallback.json";

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Project directories whose `.opencode/` and `opencode.json` opencode also reads. */
  projectDirs?: string[];
}

/** The index just past the string literal that starts at `start`. */
function endOfString(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The index just past the comment that starts at `start`, or `start` when none does. */
function endOfComment(text: string, start: number): number {
  if (text[start] !== "/") return start;
  if (text[start + 1] === "/") {
    const eol = text.indexOf("\n", start);
    return eol < 0 ? text.length : eol;
  }
  if (text[start + 1] === "*") {
    const close = text.indexOf("*/", start + 2);
    return close < 0 ? text.length : close + 2;
  }
  return start;
}

/** JSON with `//` and block comments and trailing commas, as `opencode.jsonc` allows. */
export function parseJsonc(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, "");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const next = text[i] === '"' ? endOfString(text, i) : endOfComment(text, i);
    if (text[i] === '"') out += text.slice(i, next);
    else out += next === i ? text[i] : " ";
    i = next === i ? i + 1 : next;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, "$1"));
}

function readJson(file: string): unknown {
  try {
    return parseJsonc(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The package or file a plugin entry names: a string, a `[name, options]` tuple (1.x), or `{ package }` (2.x). */
export function pluginEntrySpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return typeof entry[0] === "string" ? entry[0] : undefined;
  return isRecord(entry) && typeof entry.package === "string" ? entry.package : undefined;
}

/** The name a plugin entry goes by: the package without its version (and `npm:`), or a file path's base name. */
export function pluginEntryName(entry: unknown): string | undefined {
  const spec = pluginEntrySpec(entry);
  if (!spec) return undefined;
  if (/^(?:file:|[./~]|[a-z]:[\\/])/i.test(spec)) return path.basename(spec).replace(/\.[cm]?[jt]s$/, "").toLowerCase();
  const bare = spec.replace(/^npm:/i, "");
  const at = bare.lastIndexOf("@");
  return (at > 0 ? bare.slice(0, at) : bare).toLowerCase();
}

/** A plugin name without its npm scope: a fork under another scope is the same plugin. */
function unscoped(name: string): string {
  return name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
}

/** One place a fallback is configured, as `jinn doctor` tells the operator what to change. */
export type FallbackFinding =
  | { kind: "config-plugin"; file: string; key: "plugin" | "plugins"; entry: string }
  | { kind: "plugin-file"; path: string }
  | { kind: "settings"; file: string };

/** The finding as one `sources` string: the operator's own path. */
export function describeFinding(finding: FallbackFinding): string {
  if (finding.kind === "config-plugin") return `${finding.file} (plugin ${finding.entry})`;
  return finding.kind === "plugin-file" ? finding.path : finding.file;
}

function configEntries(config: unknown): Array<{ key: "plugin" | "plugins"; entry: unknown }> {
  if (!isRecord(config)) return [];
  return (["plugin", "plugins"] as const).flatMap((key) => {
    const list = config[key];
    return Array.isArray(list) ? list.map((entry) => ({ key, entry })) : [];
  });
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function configFindings(file: string): FallbackFinding[] {
  return configEntries(readJson(file))
    .filter(({ entry }) => FALLBACK_PLUGINS.includes(unscoped(pluginEntryName(entry) ?? "")))
    .map(({ key, entry }): FallbackFinding => ({ kind: "config-plugin", file, key, entry: pluginEntrySpec(entry) ?? "" }));
}

function pluginDirFindings(dir: string): FallbackFinding[] {
  const found: FallbackFinding[] = [];
  for (const sub of PLUGIN_DIRS) {
    const pluginDir = path.join(dir, sub);
    if (!isDirectory(pluginDir)) continue;
    for (const name of fs.readdirSync(pluginDir)) {
      if (PLUGIN_FILE_RE.test(name) || (FALLBACK_PLUGINS.includes(name) && isDirectory(path.join(pluginDir, name)))) {
        found.push({ kind: "plugin-file", path: path.join(pluginDir, name) });
      }
    }
  }
  return found;
}

/** The plugin looks for its settings at `<base>/.opencode/`, `<base>/opencode/` and `<base>/`. */
function settingsFindings(base: string): FallbackFinding[] {
  return [path.join(base, ".opencode"), path.join(base, "opencode"), base]
    .map((dir) => path.join(dir, FALLBACK_SETTINGS))
    .filter((file) => {
      const settings = readJson(file);
      return isRecord(settings) && settings.enabled !== false;
    })
    .map((file): FallbackFinding => ({ kind: "settings", file }));
}

/** The opencode config directories of an operator, and the project directories that add their own. */
function layout(options: DetectOptions): { configDirs: string[]; configFiles: string[]; bases: string[]; projectDirs: string[] } {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const projectDirs = options.projectDirs ?? [];
  const configDirs = [path.join(xdg, "opencode"), path.join(home, ".opencode"), ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : []), ...projectDirs.map((dir) => path.join(dir, ".opencode"))];
  const configFiles = [
    ...configDirs.flatMap((dir) => CONFIG_FILES.map((name) => path.join(dir, name))),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...projectDirs.flatMap((dir) => ["opencode.json", "opencode.jsonc"].map((name) => path.join(dir, name))),
  ];
  return { configDirs, configFiles, bases: [...projectDirs, home, xdg], projectDirs };
}

/**
 * Where the host's opencode carries a model fallback of its own.
 * Reads the operator's opencode config (plugin lists), plugin directories and
 * `rate-limit-fallback.json` files; changes nothing.
 */
export function detectOpencodeInternalFallbackFindings(options: DetectOptions = {}): FallbackFinding[] {
  const { configDirs, configFiles, bases } = layout(options);
  const found = [
    ...configFiles.flatMap(configFindings),
    ...configDirs.flatMap(pluginDirFindings),
    ...bases.flatMap(settingsFindings),
  ];
  const seen = new Set<string>();
  return found.filter((finding) => {
    const key = JSON.stringify(finding);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** Whether the host's opencode carries a model fallback of its own, and where (the operator's own paths). */
export function detectOpencodeInternalFallback(options: DetectOptions = {}): OpencodeInternalFallback {
  const sources = [...new Set(detectOpencodeInternalFallbackFindings(options).map(describeFinding))];
  return { detected: sources.length > 0, neutralised: false, sources };
}

/** What `jinn doctor` says first about an internal fallback; the fix lines follow it. */
export const INTERNAL_FALLBACK_WARNING =
  "opencode has an internal model fallback configured (the opencode-rate-limit plugin or a model-fallback.js plugin). "
  + "It switches models on a usage limit without the gateway knowing, beside the gateway's own fallback chains. To fix it:";

/** The start-up (and first-contact) warning: where, and what to run. No paths. */
export function internalFallbackWarning(label: string): string {
  return `opencode internal fallback detected on ${label}: run \`jinn doctor\` for the files to change, then \`jinn fallback migrate-opencode\``;
}

/** Detection results are cached: they are read by every `/api/engines` request. */
let cached: { at: number; value: OpencodeInternalFallback } | undefined;
const CACHE_MS = 30_000;

/** {@link detectOpencodeInternalFallback} for this process, at most every 30 s. */
export function currentOpencodeInternalFallback(now = Date.now()): OpencodeInternalFallback {
  if (!cached || now - cached.at > CACHE_MS) {
    cached = { at: now, value: detectOpencodeInternalFallback({ projectDirs: [process.cwd()] }) };
  }
  return cached.value;
}

/** What each remote host's facts reported, by destination. A host is read when the gateway first reaches it. */
const remoteSources = new Map<string, string[]>();

/** Remember what a remote host reported, and warn the first time a host reports one (no paths). */
export function recordRemoteInternalFallback(destination: string, sources: string[]): void {
  const had = (remoteSources.get(destination) ?? []).length > 0;
  remoteSources.set(destination, sources);
  if (sources.length === 0 || had) return;
  logger.warn(internalFallbackWarning(`remote host ${destination}`));
  logger.debug(`opencode internal fallback on ${destination}: ${sources.join("; ")}`);
}

/** The gateway host's reading with every remote host's reported sources added, as `host: path`. */
export function combinedOpencodeInternalFallback(): OpencodeInternalFallback {
  const local = currentOpencodeInternalFallback();
  const remote = [...remoteSources].flatMap(([host, sources]) => sources.map((source) => `${host}: ${source}`));
  const sources = [...local.sources, ...remote];
  const hosts = [...remoteSources].filter(([, found]) => found.length > 0).map(([host, found]) => ({ host, sources: found }));
  return { detected: sources.length > 0, neutralised: false, sources, ...(hosts.length ? { remote: hosts } : {}) };
}

/** Test hook: forget the cached reading and the remote reports. */
export function resetOpencodeInternalFallbackCache(): void {
  cached = undefined;
  remoteSources.clear();
}

/** `/api/engines` as the Settings card reads it: the opencode entry also says whether the host has an internal fallback. */
export function withInternalFallback<T extends Record<string, object>>(
  engines: T,
  read: () => OpencodeInternalFallback = combinedOpencodeInternalFallback,
): T {
  const opencode = engines.opencode;
  return opencode ? { ...engines, opencode: { ...opencode, internalFallback: read() } } : engines;
}

/** Warn once at gateway start. The paths are the operator's own, so they go to debug only. */
export function warnOpencodeInternalFallback(read: () => OpencodeInternalFallback = currentOpencodeInternalFallback): OpencodeInternalFallback {
  const found = read();
  if (!found.detected) return found;
  logger.warn(internalFallbackWarning("local"));
  logger.debug(`opencode internal fallback found in: ${found.sources.join("; ")}`);
  return found;
}

/** Whether the opencode on a host has a model-fallback plugin: the gateway host's own reading, or what a remote host reported. */
export function hostHasInternalFallback(remoteDestination?: string): boolean {
  if (remoteDestination === undefined) return currentOpencodeInternalFallback().detected;
  return (remoteSources.get(remoteDestination) ?? []).length > 0;
}
