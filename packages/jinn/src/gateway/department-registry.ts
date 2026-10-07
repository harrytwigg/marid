import fs from "node:fs";
import path from "node:path";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { resolveJinnHome } from "../shared/paths.js";
import type { DepartmentScope } from "../work-items/department-scope.js";
import { setDepartmentScopeResolver, setDepartmentSkillsResolver } from "../work-items/department-scope.js";
import { parseDepartmentYaml, UNSCOPABLE_DEPARTMENTS, type DepartmentDefinition } from "./department-definition.js";
import { reportStraddlingSubtasks } from "./department-straddle.js";
import { departmentWorkdirOptions, type WorkdirOptions } from "./department-workdirs.js";

/**
 * What every department's `org/<slug>/department.yaml` says, and the scope each
 * department is held to. It follows the shape of `refreshOrg` (org-registry.ts) and
 * runs inside it, so the existing `org/` watcher covers the files.
 *
 * Scope fails closed (FR-001): a department that has loaded a scope keeps it in the
 * `department_scopes` table, so a file that is refused, or deleted, never opens a
 * scoped department. A refused file with no recorded scope counts as `dedicated`
 * when it asks for a scope other than `open` (see `parseDepartmentYaml`) or cannot be
 * read at all, and stays open otherwise, so an old file nothing ever read confines no
 * one on upgrade.
 */

export interface DepartmentRecord {
  slug: string;
  /** The scope the gateway holds the department to. */
  scope: DepartmentScope;
  /** What the last good file said, or null when it has none, or none that ever loaded. */
  definition: DepartmentDefinition | null;
  /** Why the file was refused; null when it loaded or does not exist. */
  definitionError: string | null;
  /** The file, relative to the instance home; null when the department has none. */
  definitionFile: string | null;
  /** Content problems that dropped an entry. */
  warnings: string[];
}

interface FileState {
  definition: DepartmentDefinition | null;
  error: string | null;
  /** For a refused file: whether it asks for a non-open scope. An unreadable file is taken to. */
  asksToConfine: boolean;
  /** The file exists but could not be read. */
  unreadable?: boolean;
  file: string;
  warnings: string[];
}

let files: Map<string, FileState> | null = null;
let lastGood = new Map<string, DepartmentScope>();
let announced = new Set<string>();
let signatures = new Map<string, string>();
let notifyChange: ((slug: string) => void) | null = null;

const DEPARTMENT_FILE = "department.yaml";
const NEAR_MISS = /^departments?\.(ya?ml)$/i;

/** One listener: called with a slug whenever its definition, scope or refusal changes after the first load. The gateway's watcher callbacks hand it the client broadcast. */
export function setDepartmentChangeListener(listener: ((slug: string) => void) | null): void {
  notifyChange = listener;
}

function readLastGood(): Map<string, DepartmentScope> {
  try {
    const rows = initDb().prepare("SELECT slug, scope FROM department_scopes").all() as Array<{ slug: string; scope: DepartmentScope }>;
    return new Map(rows.map((row) => [row.slug, row.scope]));
  } catch (err) {
    logger.error(`Could not read the recorded department scopes: ${err instanceof Error ? err.message : err}`);
    return new Map(lastGood);
  }
}

function recordScope(slug: string, scope: DepartmentScope): void {
  try {
    initDb()
      .prepare(
        `INSERT INTO department_scopes (slug, scope, recorded_at) VALUES (?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET scope = excluded.scope, recorded_at = excluded.recorded_at`,
      )
      .run(slug, scope, new Date().toISOString());
  } catch (err) {
    logger.error(`Could not record the scope of department "${slug}": ${err instanceof Error ? err.message : err}`);
  }
}

/** Say something once, until it stops being true. */
function say(level: "warn" | "error" | "info", message: string, current: Set<string>): void {
  current.add(message);
  if (!announced.has(message)) logger[level](message);
}

function departmentDirs(orgDir: string): string[] {
  try {
    return fs
      .readdirSync(orgDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Whether the directory holds a file named exactly `department.yaml`, warning about near misses; null when it cannot be listed. */
function hasDefinitionFile(slug: string, dir: string, current: Set<string>): boolean | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name !== DEPARTMENT_FILE && NEAR_MISS.test(name)) {
      say("warn", `org/${slug}/${name} is not read: a department's definition is org/${slug}/${DEPARTMENT_FILE}`, current);
    }
  }
  return names.includes(DEPARTMENT_FILE);
}

function readFileState(slug: string, pass: Pass): FileState | undefined {
  const { orgDir, home, current } = pass;
  const dir = path.join(orgDir, slug);
  // Only the exact name counts. A case-insensitive filesystem would otherwise open
  // `Department.yaml` for it, and the department would load while the log says it is not read.
  // A directory that cannot be listed is reported by the read below.
  if (hasDefinitionFile(slug, dir, current) === false) return undefined;
  const fullPath = path.join(dir, DEPARTMENT_FILE);
  const file = path.relative(home, fullPath).split(path.sep).join("/");
  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // What an unreadable file asks for is unknown, so it fails closed.
    return { definition: null, error: `the file cannot be read: ${(err as Error).message}`, asksToConfine: true, unreadable: true, file, warnings: [] };
  }
  const parsed = parseDepartmentYaml(slug, raw, { home, workdirOptions: pass.workdirOptions() });
  if (!parsed.ok) return { definition: null, error: parsed.error, asksToConfine: parsed.asksToConfine, file, warnings: [] };
  return { definition: parsed.definition, error: null, asksToConfine: false, file, warnings: parsed.warnings };
}

function signature(slug: string): string {
  const state = files?.get(slug);
  return JSON.stringify([departmentScopeOf(slug), state?.error ?? null, state?.definition ?? null]);
}

interface Pass {
  home: string;
  orgDir: string;
  /** Last good scopes, updated as files load. */
  known: Map<string, DepartmentScope>;
  next: Map<string, FileState>;
  /** Everything said so far in this pass; the next pass only logs what is new. */
  current: Set<string>;
  /** The working-directory options, read at most once a pass. */
  workdirOptions: () => WorkdirOptions;
}

/** Read one department's file; record its scope when it loads, say why when it does not. */
function loadDepartment(slug: string, pass: Pass): void {
  const state = readFileState(slug, pass);
  if (!state) return;
  pass.next.set(slug, state);
  for (const warning of state.warnings) say("warn", `Department "${slug}" (${state.file}): ${warning}`, pass.current);
  if (state.definition) {
    pass.known.set(slug, state.definition.scope);
    recordScope(slug, state.definition.scope);
  } else if (state.error) {
    const fallback = pass.known.get(slug);
    const kept = fallback
      ? `The department keeps its last good scope, ${fallback}.`
      : state.unreadable
        ? "It has no last good scope and what it asks for cannot be known, so it is treated as dedicated until the file loads."
        : state.asksToConfine
        ? "It has no last good scope and names a scope, so it is treated as dedicated until the file loads."
        : "It has no last good scope and has no scope other than open, so the department stays open until the file loads.";
    say("error", `Refusing ${state.file}: ${state.error}. ${kept}`, pass.current);
  }
}

/** A department that was scoped and lost its file stays scoped; say so, since nothing else will. */
function reportKeptScopes(pass: Pass): void {
  for (const [slug, scope] of pass.known) {
    if (pass.next.has(slug) || scope === "open" || !fs.existsSync(path.join(pass.orgDir, slug))) continue;
    say("warn", `Department "${slug}" has no ${DEPARTMENT_FILE}; it keeps its last good scope, ${scope}. Write scope: open to open it.`, pass.current);
  }
}

function notifyChanges(previous: Map<string, string>): void {
  for (const [slug, sig] of signatures) if (previous.get(slug) !== sig) notifyChange?.(slug);
  for (const slug of previous.keys()) if (!signatures.has(slug)) notifyChange?.(slug);
}

/**
 * Re-read every department file and record the scopes that loaded.
 *
 * The first call at gateway boot (the roster load in `server.ts`) also hands the
 * work-items layer its scope lookup. Every later call re-installs the same function.
 */
export function refreshDepartments(): void {
  setDepartmentScopeResolver(departmentScopeOf);
  setDepartmentSkillsResolver(departmentSkills);
  const home = resolveJinnHome();
  let workdirOptions: WorkdirOptions | undefined;
  const pass: Pass = {
    home,
    orgDir: path.join(home, "org"),
    known: readLastGood(),
    next: new Map(),
    current: new Set(),
    workdirOptions: () => (workdirOptions ??= departmentWorkdirOptions(home)),
  };
  const firstLoad = files === null;
  for (const slug of departmentDirs(pass.orgDir)) loadDepartment(slug, pass);
  reportKeptScopes(pass);
  const previous = signatures;
  files = pass.next;
  lastGood = pass.known;
  signatures = new Map([...new Set([...pass.next.keys(), ...pass.known.keys()])].map((slug) => [slug, signature(slug)]));
  reportStraddlingSubtasks((message) => say("warn", message, pass.current), departmentScopeOf);
  announced = pass.current;
  if (!firstLoad) notifyChanges(previous);
}

function loaded(): Map<string, FileState> {
  if (!files) refreshDepartments();
  return files!;
}

/** The scope a department is held to now: its file, else its last good scope, else `dedicated` for a refused file that never loaded and asks to confine (or cannot be read), else open. */
export function departmentScopeOf(slug: string): DepartmentScope {
  if (UNSCOPABLE_DEPARTMENTS.has(slug)) return "open";
  const state = loaded().get(slug);
  if (state?.definition) return state.definition.scope;
  const recorded = lastGood.get(slug);
  if (recorded) return recorded;
  return state?.error && state.asksToConfine ? "dedicated" : "open";
}

/** The skills a scoped department offers (FR-027): its allow-list, nothing when it has none, no restriction when it is open. */
function departmentSkills(slug: string): readonly string[] | null {
  return departmentScopeOf(slug) === "open" ? null : departmentRecord(slug).definition?.skills ?? [];
}

export function departmentRecord(slug: string): DepartmentRecord {
  const state = loaded().get(slug);
  return {
    slug,
    scope: departmentScopeOf(slug),
    definition: state?.definition ?? null,
    definitionError: state?.error ?? null,
    definitionFile: state?.file ?? null,
    warnings: state?.warnings ?? [],
  };
}

/** Slugs that carry a definition file, loaded or refused. */
export function departmentSlugsWithFiles(): string[] {
  return [...loaded().keys()].sort();
}

export function resetDepartmentRegistryForTests(): void {
  files = null;
  lastGood = new Map();
  announced = new Set();
  signatures = new Map();
  notifyChange = null;
  setDepartmentScopeResolver(null);
  setDepartmentSkillsResolver(null);
}
