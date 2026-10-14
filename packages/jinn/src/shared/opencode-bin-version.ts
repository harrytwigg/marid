import { execFile } from "node:child_process";
import fs from "node:fs";

/**
 * Which opencode release a local binary is, from `opencode --version`.
 *
 * OpenCode 2 changes what Jinn must hand the binary before it starts: the
 * staged MCP config's shape, `--standalone` for anything that would otherwise
 * start its background service, and the terminal view's argv. So the version
 * is read from the binary itself, once per binary file: the answer is cached
 * by its real path and modification time, which a symlink swap or an
 * in-place upgrade both change.
 */

const PROBE_TIMEOUT_MS = 10_000;
const cache = new Map<string, Promise<string | undefined>>();

/** The version in a `--version` line (`opencode v2.0.29`, `1.19.0`). */
export function parseOpencodeVersion(output: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

function cacheKey(bin: string): string | undefined {
  try {
    const real = fs.realpathSync(bin);
    return `${real}:${fs.statSync(real).mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Never rejects: a binary that cannot say is treated as 1.x, as before. */
function probe(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ["--version"], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
        resolve(err ? undefined : parseOpencodeVersion(String(stdout)));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** The version of the opencode binary at `bin` (an absolute path), or
 *  undefined when it cannot be read. */
export function localOpencodeVersion(bin: string): Promise<string | undefined> {
  const key = cacheKey(bin);
  if (!key) return probe(bin);
  let pending = cache.get(key);
  if (!pending) {
    pending = probe(bin);
    cache.set(key, pending);
    // A failed probe is not remembered: the next turn asks again.
    void pending.then((version) => { if (!version) cache.delete(key); });
  }
  return pending;
}

/** Exported for tests. */
export function clearOpencodeVersionCache(): void {
  cache.clear();
}
