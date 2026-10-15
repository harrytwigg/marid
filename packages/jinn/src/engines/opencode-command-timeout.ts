import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpencodeApi } from "./opencode-version.js";

/**
 * A ceiling on how long one shell command of an opencode turn may run
 * (`engines.opencode.commandTimeoutMs`).
 *
 * opencode's shell tool (`bash` on 1.x, `shell` on 2.x) runs a command for as
 * long as the model asks: 1.x takes any `timeout`, and 2.x also takes `0` for
 * none. A hung command then holds the turn for as long. Both kill a command
 * at its timeout and tell the model (verified on 1.19.0 and 2.0.29), so the
 * ceiling caps that timeout: a small opencode plugin, shipped in this package
 * (`assets/opencode/command-timeout/`), rewrites each shell call's timeout to
 * at most the ceiling, and 2.x background commands are left alone. Marid lists
 * the plugin in the session's staged config, and passes the ceiling in
 * {@link COMMAND_TIMEOUT_ENV}.
 *
 * How each version takes a plugin from the staged config, alongside the
 * operator's own (both checked on the real binaries): 1.x merges a
 * `plugin: ["file://<module>"]` entry into the list; 2.x installs a
 * `plugins: ["file:<package dir>"]` entry as a package. 2.x reads no local
 * module path from config, and its `OPENCODE_CONFIG_DIR` replaces the
 * operator's config directory rather than adding one.
 */

export const COMMAND_TIMEOUT_ENV = "JINN_OPENCODE_COMMAND_TIMEOUT_MS";
export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;

/** The ceiling the config asks for, in ms: the default when unset, 0 (off) for
 *  0 or anything that is not a positive number. */
export function resolveCommandTimeoutMs(cfg: { commandTimeoutMs?: unknown } | undefined): number {
  const value = cfg?.commandTimeoutMs;
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The plugin's config entry for a binary of `api`, given the package's
 *  `assets/` directory on the host that runs it. */
export function commandTimeoutPluginEntry(api: OpencodeApi, assetsDir: string, join: (...parts: string[]) => string): string {
  const dir = join(assetsDir, "opencode", "command-timeout");
  return api === 2 ? `file:${join(dir, "v2")}` : `file://${join(dir, "v1.js")}`;
}

/** This install's `assets/` directory: at a different depth from this module
 *  when it runs from `dist/` than from a worktree. */
export function localAssetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = [path.join(here, "..", "..", "..", "assets"), path.join(here, "..", "..", "assets")]
    .find((dir) => fs.existsSync(path.join(dir, "opencode", "command-timeout")));
  if (!found) throw new Error("the opencode command-timeout plugin is not in this install's assets");
  return found;
}

/** A remote host's `assets/`, from its jinn-cli install: the facts name that
 *  install's `dist/src/mcp`. */
export function remoteAssetsDir(entryDir: string): string {
  return path.posix.join(entryDir, "..", "..", "..", "assets");
}

/** The plugin entry for a local binary, or none when the ceiling is off. */
export function localCommandTimeoutPlugins(api: OpencodeApi, ceilingMs: number): string[] {
  return ceilingMs > 0 ? [commandTimeoutPluginEntry(api, localAssetsDir(), path.join)] : [];
}
