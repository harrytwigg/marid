/**
 * Guards for scripts/build.mjs: the clean of the compiled output has to be
 * verifiably complete, and a build that exits 0 has to have produced a
 * complete, internally consistent dist/.
 *
 * Both exist because `fs.rmSync` can throw ENOTEMPTY/EBUSY when another process
 * is reading or writing under the tree while it is removed (a watcher, an
 * editor, a second build). A build that survived that and compiled over a
 * half-removed tree could report success over a dist/ that was missing modules
 * its other files import.
 */
import fs from "node:fs";
import path from "node:path";

/** Errors worth another attempt: the directory changed or was held while it was removed. */
const TRANSIENT = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EMFILE", "ENFILE"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove `target` and prove it is gone. Retries transient failures, then throws:
 * a tree that could not be fully removed must stop the build, never be compiled over.
 *
 * `rm` and `exists` are injectable so the failure modes can be exercised without
 * needing a real race.
 */
export function removeTreeVerified(target, options = {}) {
  const { attempts, retryDelayMs, rm, exists, sleep } = {
    attempts: 5,
    retryDelayMs: 100,
    rm: fs.rmSync,
    exists: fs.existsSync,
    sleep: sleepSync,
    ...options,
  };
  let failure = "it still exists after removal";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const error = tryRemove(rm, target, retryDelayMs);
    if (!error && !exists(target)) return;
    if (error) failure = `${error.code}: ${error.message}`;
    if (attempt < attempts) sleep(retryDelayMs * attempt);
  }
  throw new Error(`build: could not clean ${target} (${failure}); refusing to compile over a partial tree`);
}

/** One removal attempt: the transient error it hit, or undefined. Anything else is thrown. */
function tryRemove(rm, target, retryDelayMs) {
  try {
    // maxRetries makes Node retry its own unlink/rmdir calls; the caller's loop
    // covers a whole-tree race that outlasts them.
    rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: retryDelayMs });
    return undefined;
  } catch (error) {
    if (!TRANSIENT.has(error?.code)) throw error;
    return error;
  }
}

/** Paths tsc reports on `--listEmittedFiles` (`TSFILE: <path>` lines). */
export function parseEmittedFiles(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^TSFILE:\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean);
}

/** Every file in `expected` must be on disk. */
export function assertFilesExist(expected, { exists = fs.existsSync } = {}) {
  const missing = expected.filter((file) => !exists(file));
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join("\n  ");
    const more = missing.length > 10 ? `\n  …and ${missing.length - 10} more` : "";
    throw new Error(`build: ${missing.length} compiled file(s) missing from dist/:\n  ${shown}${more}`);
  }
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s*\*\s*from\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Relative module specifiers a compiled JavaScript file imports or re-exports. */
export function relativeImports(source) {
  return [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[1]);
}

/**
 * Every relative import in the compiled JavaScript under `roots` must resolve
 * to a file that exists. This is the check the runtime would otherwise make at
 * startup, as "Cannot find module".
 */
export function assertRelativeImportsResolve(roots) {
  const dangling = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) check(full);
    }
  };
  const check = (file) => {
    for (const specifier of relativeImports(fs.readFileSync(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), specifier);
      // Only specifiers naming a file are checked; extensionless directory
      // imports do not exist under NodeNext.
      if (!path.extname(resolved)) continue;
      if (!fs.existsSync(resolved)) dangling.push(`${file} imports ${specifier}`);
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) walk(root);
  }
  if (dangling.length > 0) {
    const shown = dangling.slice(0, 10).join("\n  ");
    const more = dangling.length > 10 ? `\n  …and ${dangling.length - 10} more` : "";
    throw new Error(`build: dist/ is internally inconsistent, ${dangling.length} unresolved relative import(s):\n  ${shown}${more}`);
  }
}
