import fs from "node:fs";
import path from "node:path";
import { initDb } from "../shared/db.js";
import { resolveJinnHome } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { ProjectRef } from "../work-items/project-membership.js";
import { parseProject, type Project } from "./project-model.js";

/**
 * The one place production code asks "which projects exist". Project definitions
 * are YAML files under `$JINN_HOME/projects/`; this module scans them, caches the
 * result, and remembers the last good definition of every file so a typo in a
 * live project's file never turns it into an unknown one (FR-001).
 *
 * Invalidation is the `projects/` watcher plus the synchronous refresh the write
 * routes do before they respond, so a read never trails a write.
 */
export interface ProjectSet {
  /** In file-name order. */
  projects: Project[];
  byId: Map<string, Project>;
  /** Per project id: why the operator should look at it (e.g. a reused id). */
  notices: Map<string, string[]>;
}

const EMPTY: ProjectSet = { projects: [], byId: new Map(), notices: new Map() };

let cache: ProjectSet | undefined;
/** The last good definition each file path produced. Survives a broken edit. */
let lastGoodByPath = new Map<string, Project>();

export function projectsDir(): string {
  return path.join(resolveJinnHome(), "projects");
}

/** Project files in lexical order of file name: the order a fresh boot loads them in. */
function projectFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

interface Candidate {
  file: string;
  project: Project;
  /** True when a refused file is being represented by the definition it last loaded. */
  stale: boolean;
  /** What the file last loaded, for when this fresh definition loses an id or name clash. */
  fallback?: Project;
}

/** Read each file: its fresh definition when it parses, else the one it last loaded. */
function candidatesOf(dir: string, files: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const name of files) {
    const rel = path.posix.join("projects", name);
    const parsed = parseProject(readFile(path.join(dir, name)), rel);
    const previous = lastGoodByPath.get(rel);
    if (parsed.ok) {
      for (const problem of parsed.problems) logger.warn(`${rel}: ${problem.message}`);
      out.push({ file: rel, project: parsed.project, stale: false, fallback: previous });
      continue;
    }
    logger.warn(`${rel} refused: ${parsed.error}${previous ? `; keeping the last good definition of "${previous.name}"` : ""}`);
    if (previous) out.push({ file: rel, project: previous, stale: true });
  }
  return out;
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** The name each project id was last seen under, across boots. */
function seenNames(): Map<string, string> {
  const rows = initDb().prepare("SELECT project_id, last_name FROM project_ids_seen").all() as Array<{ project_id: string; last_name: string }>;
  return new Map(rows.map((row) => [row.project_id, row.last_name]));
}

/**
 * A definition that already holds an id and name keeps them: files that still say what they said
 * go before newcomers and before files whose edit changed their name, so a hand-edit that claims
 * another live project's name is the one refused. Within one process "said before" is the loaded
 * set; on a fresh boot it is the name the id was last seen under.
 */
function inLoadOrder(candidates: Candidate[], loaded: ProjectSet | undefined): Candidate[] {
  const seen = loaded ? undefined : seenNames();
  const heldBefore = (c: Candidate) => {
    const prior = loaded?.byId.get(c.project.id);
    return prior ? prior.file === c.file && prior.name === c.project.name : seen?.get(c.project.id) === c.project.name;
  };
  return [...candidates].sort((a, b) => Number(heldBefore(b)) - Number(heldBefore(a)) || a.file.localeCompare(b.file));
}

/** Why `project` cannot join the set already built, or null when it can. */
function clashWith(taken: { ids: Set<string>; names: Set<string> }, project: Project): string | null {
  if (taken.ids.has(project.id)) return `id ${project.id} is already defined`;
  return taken.names.has(project.name.toLowerCase()) ? `name "${project.name}" is already taken` : null;
}

/** What a candidate becomes under the clash rules: itself, what its file last loaded, or nothing. */
function resolveClash(taken: { ids: Set<string>; names: Set<string> }, candidate: Candidate): Candidate | undefined {
  const clash = clashWith(taken, candidate.project);
  if (!clash) return candidate;
  // A definition that loses a clash falls back to what its file last loaded, so the clash costs it nothing it already had.
  const { fallback } = candidate;
  const usable = !candidate.stale && fallback && !clashWith(taken, fallback) ? fallback : undefined;
  logger.warn(`${candidate.file} refused: ${clash} by another project file; the first one is kept${usable ? `, and this file keeps its last good definition of "${usable.name}"` : ""}`);
  return usable && { ...candidate, project: usable, stale: true };
}

/** Apply id and name uniqueness. The first definition to claim an id or a name keeps it. */
function uniqueSet(ordered: Candidate[]): Candidate[] {
  const taken = { ids: new Set<string>(), names: new Set<string>() };
  const kept: Candidate[] = [];
  for (const candidate of ordered) {
    const chosen = resolveClash(taken, candidate);
    if (!chosen) continue;
    taken.ids.add(chosen.project.id);
    taken.names.add(chosen.project.name.toLowerCase());
    kept.push(chosen);
  }
  return kept;
}

/** The notice a project carries after a scan: a reused id is new, an earlier notice is carried while the name holds. */
function noticesFor(project: Project, lastName: string | undefined, previous: ProjectSet | undefined): string[] {
  const before = previous?.byId.get(project.id);
  if (lastName !== undefined && lastName !== project.name && !before) {
    const message = `id previously used by "${lastName}"`;
    logger.warn(`${project.file}: ${message}`);
    return [message];
  }
  return before?.name === project.name ? previous?.notices.get(project.id) ?? [] : [];
}

/** Record every loaded id, and report one that comes back under a different name. */
function recordSeen(set: Project[], previous: ProjectSet | undefined): Map<string, string[]> {
  const db = initDb();
  const seen = new Map(
    (db.prepare("SELECT project_id, last_name FROM project_ids_seen").all() as Array<{ project_id: string; last_name: string }>)
      .map((row) => [row.project_id, row.last_name]),
  );
  const notices = new Map<string, string[]>();
  const upsert = db.prepare(
    `INSERT INTO project_ids_seen (project_id, last_name, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET last_name = excluded.last_name, last_seen_at = excluded.last_seen_at`,
  );
  const now = new Date().toISOString();
  for (const project of set) {
    const found = noticesFor(project, seen.get(project.id), previous);
    if (found.length > 0) notices.set(project.id, found);
    upsert.run(project.id, project.name, now);
  }
  return notices;
}

/** Report Todos that name a project id with no definition. They stay readable; nothing is refused. */
function reportDangling(set: ProjectSet): void {
  const rows = initDb().prepare("SELECT DISTINCT project_id FROM work_item_projects").pluck().all() as string[];
  const dangling = rows.filter((id) => !set.byId.has(id));
  if (dangling.length > 0) logger.warn(`projects: Todos reference unknown project id(s) ${dangling.join(", ")}; they read as an archived "unknown project"`);
}

/** Re-scan `projects/` and cache the result. Never throws: a failed scan keeps the last set. */
export function refreshProjects(): ProjectSet {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) {
    cache = EMPTY;
    lastGoodByPath = new Map();
    return cache;
  }
  try {
    const previous = cache;
    const kept = uniqueSet(inLoadOrder(candidatesOf(dir, projectFiles(dir)), previous));
    const projects = kept.map((c) => c.project).sort((a, b) => a.file.localeCompare(b.file));
    lastGoodByPath = new Map(kept.map((c) => [c.file, c.project]));
    const set: ProjectSet = { projects, byId: new Map(projects.map((p) => [p.id, p])), notices: new Map() };
    set.notices = recordSeen(projects, previous);
    reportDangling(set);
    cache = set;
  } catch (err) {
    logger.error(`Project scan failed, serving the last known set: ${err instanceof Error ? err.message : String(err)}`);
    cache ??= EMPTY;
  }
  return cache;
}

/** The cached set, scanning only when nothing has been scanned yet. */
export function readProjects(): ProjectSet {
  return cache ?? refreshProjects();
}

/** One project by id, or undefined. */
export function getProject(id: string): Project | undefined {
  return readProjects().byId.get(id);
}

/** How Todo payloads name a project. An id with no definition is "unknown" and reads as archived. */
export function projectRefOf(id: string): ProjectRef {
  const project = getProject(id);
  return project
    ? { id, name: project.name, archived: project.archived, known: true }
    : { id, name: id, archived: true, known: false };
}

export function resetProjectRegistryForTests(): void {
  cache = undefined;
  lastGoodByPath = new Map();
}
