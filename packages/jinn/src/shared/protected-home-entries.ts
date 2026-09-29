import fs from "node:fs";
import path from "node:path";
import { MOUNT_SENTINEL } from "./remote-target.js";

/**
 * The Jinn instance-home half of the file-read policy: which files
 * inside ANY Jinn home a host can reach are never readable for ingestion, and
 * how a directory is recognized as such a home. Split from
 * shared/file-read-policy.ts, which composes it with the name- and
 * location-based refusals.
 */

export function realpathOrResolved(absPath: string): string {
  const resolved = path.resolve(absPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isInsidePath(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

const CONFIG_YAML = /^config\.yaml(?:\..+)?$/;

/**
 * Instance-home entries that hold credentials or a session's engine config —
 * never attachable. `secrets/` is the store itself; `gateway.json` carries the
 * gateway token; the device/pairing files are auth state; `config.yaml` (and
 * its `.pre-*` / `.bak-*` copies) can carry literal connector and MCP keys; the
 * `tmp/` entries are what the gateway and the remote stage write per session
 * (MCP configs carrying the session capability, `session-env.sh` exporting the
 * gateway token, engine settings, codex homes with their auth). The rest of
 * `tmp/` stays readable: it is also where agents park ordinary scratch output.
 * Each entry is its path segments below a home; a RegExp segment is a pattern.
 */
const PROTECTED_HOME_ENTRIES: ReadonlyArray<ReadonlyArray<string | RegExp>> = [
  ["secrets"],
  ["gateway.json"],
  ["auth-devices.json"],
  ["pairing-codes.json"],
  [CONFIG_YAML],
  ["tmp", "mcp"],
  ["tmp", "mcp.json"],
  ["tmp", "session-env.sh"],
  ["tmp", "settings"],
  ["tmp", "settings.json"],
  ["tmp", "codex-homes"],
  ["tmp", "opencode"],
  ["tmp", "opencode.json"],
  ["tmp", "pi-mcp"],
  ["tmp", CONFIG_YAML],
];

/** Windows and macOS filesystems are case-insensitive by default, and realpath
 *  returns the on-disk case: `Secrets` there is `secrets`. */
function foldsCase(p: path.PlatformPath): boolean {
  return p.sep === "\\" || process.platform === "darwin";
}

function segmentMatches(actual: string, wanted: string | RegExp, fold: boolean): boolean {
  const name = fold ? actual.toLowerCase() : actual;
  return typeof wanted === "string" ? name === wanted : wanted.test(name);
}

function listDirOnce(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every path the protected entries name under `home` that exists: string
 *  segments joined, pattern segments matched against the directory listing. */
function concreteEntries(home: string): string[] {
  const fold = foldsCase(path);
  const listings = new Map<string, string[]>();
  const listDir = (dir: string): string[] => {
    let names = listings.get(dir);
    if (!names) listings.set(dir, (names = listDirOnce(dir)));
    return names;
  };
  return PROTECTED_HOME_ENTRIES.flatMap((entry) =>
    entry.reduce<string[]>(
      (bases, wanted) =>
        bases.flatMap((base) =>
          typeof wanted === "string" && !fold
            ? [path.join(base, wanted)]
            : listDir(base).filter((name) => segmentMatches(name, wanted, fold)).map((name) => path.join(base, name)),
        ),
      [home],
    ),
  );
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `dir` is a Jinn instance home. A host can reach several besides the
 * session's own: on a remote build host, the gateway's home through the mount,
 * and every sibling session stage under the stage root (whose `gateway.json` and
 * `tmp/` are real files, not links into the mount). The mount and every stage —
 * including partial ones such as smoke-test stages that link nothing else —
 * carry the mount sentinel; any instance home carries `secrets` plus
 * `config.yaml` or `gateway.json`; the session's own home counts by name.
 * Presence is `lstat`, deliberately: a stage whose sentinel or `secrets` link
 * dangles (its old mount is gone) is still a stage, and its real `gateway.json`
 * and `tmp/` still hold a token.
 */
function isJinnHome(dir: string, knownHomes: ReadonlySet<string>): boolean {
  if (knownHomes.has(dir) || exists(path.join(dir, MOUNT_SENTINEL))) return true;
  return exists(path.join(dir, "secrets")) && (exists(path.join(dir, "config.yaml")) || exists(path.join(dir, "gateway.json")));
}

/** What one policy call knows about the session's own home — computed once. */
export interface HomeGuard {
  knownHomes: ReadonlySet<string>;
  /** Protected entries of the home that are themselves links elsewhere (a
   *  `secrets` link into a differently named vault, `tmp/mcp` moved off the
   *  disk): a path inside `real` is judged as if it sat at `named`. A link
   *  BELOW an entry is caught instead by judging the requested path as named. */
  aliases: ReadonlyArray<{ real: string; named: string }>;
}

export function homeGuard(jinnHomeRaw: string): HomeGuard {
  const home = path.resolve(jinnHomeRaw);
  const aliases: Array<{ real: string; named: string }> = [];
  for (const named of concreteEntries(home)) {
    const real = realpathOrResolved(named);
    if (real !== named) aliases.push({ real, named });
  }
  // The home by name and by realpath, and the home its `secrets` link resolves
  // into — on a remote stage, the gateway mount.
  const knownHomes = new Set([home, realpathOrResolved(home), path.dirname(realpathOrResolved(path.join(home, "secrets")))]);
  return { knownHomes, aliases };
}

/**
 * Every (home, entry) split of `resolved` whose tail names a protected entry —
 * pure path arithmetic, no filesystem. Built from the path's own root so a
 * drive-letter or UNC path splits correctly (`path` is injectable to test the
 * win32 form on any host).
 */
export function protectedEntryCandidates(resolved: string, p: path.PlatformPath = path): Array<{ home: string; entry: string }> {
  const root = p.parse(resolved).root;
  const fold = foldsCase(p);
  const segments = p.relative(root, resolved).split(p.sep).filter(Boolean);
  const out: Array<{ home: string; entry: string }> = [];
  for (const entry of PROTECTED_HOME_ENTRIES) {
    for (let i = 0; i + entry.length <= segments.length; i++) {
      if (!entry.every((wanted, k) => segmentMatches(segments[i + k], wanted, fold))) continue;
      out.push({ home: p.join(root, ...segments.slice(0, i)), entry: segments.slice(i, i + entry.length).join("/") });
    }
  }
  return out;
}

/**
 * The protected entry `resolved` falls inside, under ANY Jinn home it sits in —
 * judged at its own path and, when it lies inside a symlinked protected entry of
 * the session's home, at the name it has there. Name matching runs first, so
 * the filesystem is only consulted to confirm a candidate home.
 */
export function protectedHomeEntry(resolved: string, guard: HomeGuard): string | null {
  const views = [resolved];
  for (const { real, named } of guard.aliases) {
    if (isInsidePath(resolved, real)) views.push(path.join(named, path.relative(real, resolved)));
  }
  for (const view of views) {
    for (const { home, entry } of protectedEntryCandidates(view)) {
      if (isJinnHome(home, guard.knownHomes)) return entry;
    }
  }
  return null;
}
