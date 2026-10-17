import fs from "node:fs";
import path from "node:path";
import { Scalar, isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { LEGACY_CODENAME, NAMES, type Names } from "../shared/codename.js";
import { orgMcpKey } from "../shared/wire-names.js";

/**
 * Switching one instance over to this build's codename: the part of a rename that only the operator can
 * schedule, because it changes what the instance's agents are told their tools are called.
 *
 * An upgraded instance keeps registering its built-in MCP server as `jinn` (mcp/builtin-name.ts), so every
 * prompt, skill and permission allow-list that says `mcp__jinn__<tool>` keeps working. The switch-over
 * moves all of those to `mcp__<codename>__<tool>` and, last, flips the registered name, in one stopped
 * window, after a snapshot, keeping a copy of every file it edits. It reads the instance's own files and
 * the Claude profiles' settings; it never touches knowledge notes, sessions or logs.
 */

/** Trees that are data, not configuration: never scanned, never edited. */
const SKIPPED_TOP_LEVEL = new Set([
  "knowledge", "sessions", "logs", "tmp", "attachments", "files", "uploads", "cache", "state",
  "node_modules", ".git", ".migration-backups", "secrets", "connectors", "plugins",
]);
const SCANNED_EXTENSIONS = /\.(?:md|ya?ml|json|txt|sh|mjs|js|toml)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Where the originals of every edited file are kept, beside the other migrations' backups. */
export const SWITCHOVER_BACKUPS = ".migration-backups";
export const SWITCHOVER_RECEIPT = path.join("state", "rename-switchover.json");

/** What is wrong in a file and what the switch-over does about it. */
export interface SwitchoverFinding { file: string; what: string; count: number }

export interface SwitchoverReport {
  home: string;
  findings: SwitchoverFinding[];
  /** Why `apply` was refused, if it was. */
  blockers: string[];
  applied?: { changed: string[]; copies: string; snapshot?: string };
}

export interface SwitchoverOptions {
  home: string;
  /** Claude profile directories whose settings carry permission allow-lists. */
  profileDirs?: string[];
  names?: Names;
  apply?: boolean;
  now?: Date;
  gatewayRunning?: (home: string) => boolean;
  /** Snapshot the home before editing; rejects if it could not. */
  backup?: (home: string) => Promise<string | undefined>;
}

interface Edit {
  file: string;
  what: string;
  count: number;
  /** The file's new text. */
  text: string;
  /** Written after every other edit: the one that flips what the server is called. */
  last?: boolean;
}

function walk(directory: string, depth = 0): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    if (depth === 0 && SKIPPED_TOP_LEVEL.has(entry.name)) return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full, depth + 1);
    return entry.isFile() && SCANNED_EXTENSIONS.test(entry.name) ? [full] : [];
  });
}

function readText(file: string): string | undefined {
  try {
    return fs.statSync(file).size <= MAX_FILE_BYTES ? fs.readFileSync(file, "utf-8") : undefined;
  } catch {
    return undefined;
  }
}

/** `mcp__jinn__<tool>` and a bare `mcp__jinn` (every tool of the server) in an allow-list, a prompt or a skill. */
function toolTokenEdit(file: string, text: string, names: Names): Edit | undefined {
  const pattern = new RegExp(`\\bmcp__${LEGACY_CODENAME}(?=__|\\b)`, "g");
  const count = text.match(pattern)?.length ?? 0;
  return count === 0 ? undefined : {
    file,
    what: `names the built-in server's tools \`mcp__${LEGACY_CODENAME}__*\`; becomes \`mcp__${names.codename}__*\``,
    count,
    text: text.replace(pattern, `mcp__${names.codename}`),
  };
}

/** Rename a top-level key of a YAML document in place, keeping its position and comments. */
function renameKey(doc: Document, from: string, to: string): boolean {
  if (!isMap(doc.contents)) return false;
  const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === from);
  if (!pair || !isScalar(pair.key)) return false;
  if (doc.contents.items.some((item) => isScalar(item.key) && item.key.value === to)) return false;
  pair.key.value = to;
  return true;
}

/** Replace `from` with `to` among the strings of a top-level `mcp:` list. */
function renameMcpListEntry(doc: Document, from: string, to: string): number {
  const list = isMap(doc.contents) ? doc.contents.get("mcp", true) : undefined;
  if (!isSeq(list)) return 0;
  let changed = 0;
  for (const item of list.items) {
    if (isScalar(item) && item.value === from) {
      item.value = to;
      changed += 1;
    }
  }
  return changed;
}

function orgEdit(file: string, text: string, names: Names): Edit | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  const key = renameKey(doc, `${LEGACY_CODENAME}Mcp`, orgMcpKey(names)) ? 1 : 0;
  const list = renameMcpListEntry(doc, LEGACY_CODENAME, names.codename);
  if (key + list === 0) return undefined;
  const parts = [key ? `\`${LEGACY_CODENAME}Mcp\` becomes \`${orgMcpKey(names)}\`` : "", list ? `its \`mcp\` list names \`${LEGACY_CODENAME}\`, which becomes \`${names.codename}\`` : ""].filter(Boolean);
  return { file, what: parts.join("; "), count: key + list, text: doc.toString() };
}

/** The instance's own block, keyed by the codename, and the name the built-in server is registered by. */
function configEdit(file: string, text: string, names: Names): Edit | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  let count = renameKey(doc, LEGACY_CODENAME, names.codename) ? 1 : 0;
  const block = isMap(doc.contents) ? doc.contents.get(names.codename, true) : undefined;
  const current = isMap(block) ? block.get("mcpServerName") : undefined;
  if (current !== names.codename) {
    if (isScalar(block) && block.value == null) doc.set(names.codename, doc.createNode({ mcpServerName: names.codename }));
    else doc.setIn([names.codename, "mcpServerName"], new Scalar(names.codename));
    count += 1;
  }
  return count === 0 ? undefined : {
    file,
    what: `the instance block \`${LEGACY_CODENAME}:\` becomes \`${names.codename}:\` and records \`mcpServerName: ${names.codename}\`: the built-in server is registered under the new name from the next start`,
    count,
    text: doc.toString(),
    last: true,
  };
}

function editsFor(file: string, home: string, names: Names): Edit[] {
  const text = readText(file);
  if (text === undefined) return [];
  const relative = path.relative(home, file);
  const edits: Edit[] = [];
  if (relative === "config.yaml") {
    const edit = configEdit(file, text, names);
    if (edit) edits.push(edit);
    return edits;
  }
  let working = text;
  if (/^org(?:\/|\\)/.test(relative) && /\.ya?ml$/i.test(file)) {
    const edit = orgEdit(file, text, names);
    if (edit) { edits.push(edit); working = edit.text; }
  }
  const tokens = toolTokenEdit(file, working, names);
  if (tokens) {
    const merged = edits[0];
    if (merged) { merged.text = tokens.text; merged.count += tokens.count; merged.what += `; ${tokens.what}`; }
    else edits.push(tokens);
  }
  return edits;
}

function profileSettingFiles(profileDirs: readonly string[]): string[] {
  return profileDirs.flatMap((dir) => ["settings.json", "settings.local.json"].map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file)));
}

/** Every edit the switch-over would make, without making any. */
export function planSwitchover(home: string, profileDirs: readonly string[] = [], names: Names = NAMES): Edit[] {
  const files = [...new Set([...walk(home), ...profileSettingFiles(profileDirs)])];
  return files.flatMap((file) => (file.startsWith(`${home}${path.sep}`) ? editsFor(file, home, names) : profileEdit(file, names)));
}

function profileEdit(file: string, names: Names): Edit[] {
  const text = readText(file);
  const edit = text === undefined ? undefined : twinEntriesEdit(file, text, names);
  return edit ? [edit] : [];
}

/**
 * A Claude profile's settings are shared by every instance on the host, and one that has not been switched
 * over still registers the server under the old name. So an entry naming the old tools gets the new name
 * added beside it, never in its place: both builds are right, a second run adds nothing, and there is
 * nothing to put back on a rollback. Only the lists are touched; a file that is not JSON is left alone.
 */
function twinEntriesEdit(file: string, text: string, names: Names): Edit | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const pattern = new RegExp(`\\bmcp__${LEGACY_CODENAME}(?=__|\\b)`);
  let added = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(walk(item));
        const twin = typeof item === "string" && pattern.test(item) ? item.replace(pattern, `mcp__${names.codename}`) : undefined;
        if (twin !== undefined && !value.includes(twin) && !out.includes(twin)) { out.push(twin); added += 1; }
      }
      return out;
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const next = walk(document);
  if (added === 0) return undefined;
  return {
    file,
    what: `lists the built-in server's tools as \`mcp__${LEGACY_CODENAME}__*\`; \`mcp__${names.codename}__*\` is added beside them (shared by every instance, so the old ones stay)`,
    count: added,
    text: `${JSON.stringify(next, null, 2)}${text.endsWith("\n") ? "\n" : ""}`,
  };
}

function defaultGatewayRunning(home: string): boolean {
  return ["gateway.pid", "gateway.json"].some((name) => {
    try {
      const raw = fs.readFileSync(path.join(home, name), "utf-8").trim();
      const pid = name.endsWith(".json") ? (JSON.parse(raw) as { pid?: number }).pid : Number.parseInt(raw, 10);
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
}

function blockers(options: SwitchoverOptions, names: Names): string[] {
  const reasons: string[] = [];
  if (!names.renamed) reasons.push(`this build's codename is "${names.codename}": there is nothing to switch over`);
  if ((options.gatewayRunning ?? defaultGatewayRunning)(options.home)) reasons.push("a gateway is running at this home: stop it first, so every session restarts under the new names");
  return reasons;
}

function writeAtomically(file: string, text: string): void {
  const mode = fs.statSync(file).mode & 0o777;
  const temporary = `${file}.${process.pid}.rename-tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function keepCopies(edits: readonly Edit[], home: string, stamp: string): string {
  const copies = path.join(home, SWITCHOVER_BACKUPS, `rename-${stamp}`);
  for (const edit of edits) {
    const inside = edit.file.startsWith(`${home}${path.sep}`);
    const target = path.join(copies, inside ? path.relative(home, edit.file) : path.join("profiles", edit.file.replace(/[^a-zA-Z0-9._-]+/g, "_")));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(edit.file, target);
  }
  fs.writeFileSync(path.join(copies, "files.json"), `${JSON.stringify(edits.map((edit) => ({ file: edit.file, what: edit.what })), null, 2)}\n`);
  return copies;
}

function restore(applied: readonly Edit[], originals: ReadonlyMap<string, string>): void {
  for (const edit of applied) {
    const original = originals.get(edit.file);
    if (original !== undefined) writeAtomically(edit.file, original);
  }
}

/** Snapshot, keep copies, write every edit (the flip last) and leave a receipt; put the files back if a write fails. */
async function applyEdits(edits: readonly Edit[], options: SwitchoverOptions, report: SwitchoverReport): Promise<void> {
  const now = options.now ?? new Date();
  let snapshot: string | undefined;
  try {
    snapshot = await options.backup?.(options.home);
  } catch (error) {
    report.blockers.push(`it was not changed because the snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // The snapshot can take minutes; a gateway started meanwhile must not have its files rewritten under it.
  if ((options.gatewayRunning ?? defaultGatewayRunning)(options.home)) {
    report.blockers.push("a gateway started at this home while it was being backed up, so nothing was changed: stop it and run again");
    return;
  }
  const originals = new Map(edits.map((edit) => [edit.file, fs.readFileSync(edit.file, "utf-8")]));
  const copies = keepCopies(edits, options.home, now.toISOString().replace(/[:.]/g, "-"));
  const written: Edit[] = [];
  try {
    for (const edit of [...edits.filter((found) => !found.last), ...edits.filter((found) => found.last)]) {
      writeAtomically(edit.file, edit.text);
      written.push(edit);
    }
  } catch (error) {
    restore(written, originals);
    report.blockers.push(`it was rolled back after a write failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  report.applied = { changed: edits.map((edit) => edit.file), copies, ...(snapshot ? { snapshot } : {}) };
  const receipt = path.join(options.home, SWITCHOVER_RECEIPT);
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, `${JSON.stringify({ at: now.toISOString(), ...report.applied }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Report what the switch-over would change in `options.home` and, with `apply`, change it: copies of
 * every edited file, a snapshot of the home, then the edits, the flip of the registered name last. A
 * failure part-way puts the files already written back as they were.
 */
export async function switchOver(options: SwitchoverOptions): Promise<SwitchoverReport> {
  const names = options.names ?? NAMES;
  const edits = planSwitchover(options.home, options.profileDirs, names);
  const report: SwitchoverReport = {
    home: options.home,
    findings: edits.map(({ file, what, count }) => ({ file, what, count })),
    blockers: options.apply ? blockers(options, names) : [],
  };
  if (options.apply && report.blockers.length === 0 && edits.length > 0) await applyEdits(edits, options, report);
  return report;
}

/** The receipt a switch-over left, or undefined if the instance has not been switched. */
export function readSwitchoverReceipt(home: string): { at: string; changed: string[]; copies: string; snapshot?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, SWITCHOVER_RECEIPT), "utf-8"));
  } catch {
    return undefined;
  }
}
