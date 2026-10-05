import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveJinnHome } from "../shared/paths.js";
import { dumpProjectDoc, parseProject, type Project } from "./project-model.js";
import { getProject, projectsDir, readProjects, refreshProjects } from "./project-registry.js";

/**
 * Writing project definitions from the UI and the API (FR-042). The YAML stays
 * the source of truth: every write rewrites the one file, atomically, and
 * refreshes the in-memory set before it returns, so a Todo created straight
 * after a project is never told the project is unknown.
 */

/** A refusal the route turns into a 4xx: `not_found` 404, `conflict` 409, the rest 400. */
export class ProjectWriteError extends Error {
  constructor(message: string, readonly code: "not_found" | "conflict" | "invalid") {
    super(message);
    this.name = "ProjectWriteError";
  }
}

/** The fields a write may carry. `dedicated` is accepted only so it can be refused by name. */
export interface ProjectWriteInput {
  name?: string;
  description?: string;
  archived?: boolean;
  dedicated?: boolean;
  workdirs?: string[];
  skills?: string[];
  sharedNotes?: string[];
  instructions?: "project" | "project+company";
}

const LIST_FIELDS = ["workdirs", "skills", "sharedNotes"] as const;
const WRITABLE = ["name", "description", "archived", "dedicated", "instructions", ...LIST_FIELDS] as const;

/** What each writable field must be, and how the refusal reads. */
const SHAPES: Record<(typeof WRITABLE)[number], { valid: (value: unknown) => boolean; message: string }> = {
  name: { valid: (v) => typeof v === "string" && v.trim() !== "", message: "name must be a non-empty string" },
  description: { valid: (v) => typeof v === "string", message: "description must be a string" },
  archived: { valid: (v) => typeof v === "boolean", message: "archived must be true or false" },
  dedicated: { valid: (v) => typeof v === "boolean", message: "dedicated must be true or false" },
  instructions: { valid: (v) => v === "project" || v === "project+company", message: "instructions must be project or project+company" },
  workdirs: { valid: isStringList, message: "workdirs must be a list of strings" },
  skills: { valid: isStringList, message: "skills must be a list of strings" },
  sharedNotes: { valid: isStringList, message: "sharedNotes must be a list of strings" },
};

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Check a request body's shape. Content is checked later, by the same parser the scan uses. */
export function readProjectInput(body: Record<string, unknown>): ProjectWriteInput {
  const unknown = Object.keys(body).filter((key) => !(key in SHAPES));
  if (unknown.length > 0) throw new ProjectWriteError(`unknown field(s): ${unknown.join(", ")}`, "invalid");
  for (const key of WRITABLE) {
    if (body[key] !== undefined && !SHAPES[key].valid(body[key])) throw new ProjectWriteError(SHAPES[key].message, "invalid");
  }
  return body as ProjectWriteInput;
}

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, "utf-8");
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

function freeFileName(name: string): string {
  const dir = projectsDir();
  for (let n = 1; ; n++) {
    const candidate = `${slugOf(name)}${n === 1 ? "" : `-${n}`}.yaml`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** The seed for a new project's own state file, in the format the company state file uses. */
function seedStateFile(project: Project): void {
  const file = path.join(resolveJinnHome(), "knowledge", "projects", project.id, "state.md");
  if (fs.existsSync(file)) return;
  writeFileAtomic(file, `# ${project.name} — Current State\n\n## Current Workings\n`);
}

function assertNameFree(name: string, exceptId?: string): void {
  const clash = readProjects().projects.find((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new ProjectWriteError(`a project named "${clash.name}" already exists`, "conflict");
}

/** Parse the document that would be written, so a write is refused for what a scan would refuse or drop. */
function validated(doc: Record<string, unknown>, file: string, touched: readonly string[]): Project {
  const parsed = parseProject(dumpProjectDoc(doc), file);
  if (!parsed.ok) throw new ProjectWriteError(parsed.error, "invalid");
  const mine = parsed.problems.filter((problem) => touched.includes(problem.field));
  if (mine.length > 0) throw new ProjectWriteError(mine.map((problem) => problem.message).join("; "), "invalid");
  return parsed.project;
}

const DEDICATED_REFUSAL = "dedicated cannot be changed through the API yet: nothing enforces it until scoped employees ship. Edit the project's YAML file to set it";

/** Create a project: a new file with a generated id, and its state note. */
export function createProject(input: ProjectWriteInput): Project {
  if (typeof input.name !== "string") throw new ProjectWriteError("name is required", "invalid");
  if (input.dedicated === true) throw new ProjectWriteError(DEDICATED_REFUSAL, "invalid");
  refreshProjects();
  assertNameFree(input.name.trim());
  const id = `prj_${crypto.randomBytes(6).toString("hex")}`;
  const fileName = freeFileName(input.name);
  const doc: Record<string, unknown> = {
    id,
    name: input.name.trim(),
    description: input.description ?? "",
    archived: input.archived ?? false,
    dedicated: false,
    workdirs: input.workdirs ?? [],
    skills: input.skills ?? [],
    sharedNotes: input.sharedNotes ?? [],
    instructions: input.instructions ?? "project",
  };
  const project = validated(doc, path.posix.join("projects", fileName), Object.keys(doc));
  writeFileAtomic(path.join(projectsDir(), fileName), dumpProjectDoc(doc));
  seedStateFile(project);
  return loadedOrThrow(id);
}

/** Rewrite one project's file with the fields the patch names. Keys the file carries beyond those are kept. */
export function updateProject(id: string, patch: ProjectWriteInput): Project {
  refreshProjects();
  const current = getProject(id);
  if (!current) throw new ProjectWriteError(`project ${id} not found`, "not_found");
  if (patch.dedicated !== undefined && patch.dedicated !== current.dedicated) throw new ProjectWriteError(DEDICATED_REFUSAL, "invalid");
  const file = path.join(resolveJinnHome(), current.file);
  const raw = readRawDoc(file);
  if (!raw || raw.id !== id) {
    throw new ProjectWriteError(`${current.file} is not readable as project ${id}; fix the YAML first`, "invalid");
  }
  const changes: ProjectWriteInput = { ...patch };
  delete changes.dedicated; // unchanged, or refused above
  const doc: Record<string, unknown> = { ...raw, ...changes };
  if (typeof changes.name === "string") {
    doc.name = changes.name.trim();
    assertNameFree(doc.name as string, id);
  }
  validated(doc, current.file, Object.keys(changes));
  for (const field of LIST_FIELDS) {
    if (changes[field]) doc[field] = mergeList(field, raw[field], changes[field]);
  }
  writeFileAtomic(file, dumpProjectDoc(doc));
  return loadedOrThrow(id);
}

/** What the scan makes of one list entry: its normalised form, or undefined when the scan would drop it. */
function keptForm(field: (typeof LIST_FIELDS)[number], entry: string): string | undefined {
  const parsed = parseProject(dumpProjectDoc({ id: "prj_000000000000", name: "probe", [field]: [entry] }), "probe.yaml");
  return parsed.ok ? parsed.project[field][0] : undefined;
}

/**
 * The list to write when a patch carries the list as the API shows it. The API shows only the
 * entries the scan kept, in normalised form, so a plain overwrite would delete the entries the scan
 * dropped (a skill not installed yet, an unmounted directory) and respell the rest. Entries the file
 * holds keep their spelling and place; ones the patch no longer lists are removed; new ones go last.
 */
function mergeList(field: (typeof LIST_FIELDS)[number], current: unknown, patch: string[]): string[] {
  const rawEntries = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
  const wanted = new Set(patch);
  const written: string[] = [];
  const matched = new Set<string>();
  for (const entry of rawEntries) {
    const kept = keptForm(field, entry);
    if (kept === undefined) written.push(entry);
    else if (wanted.has(kept)) {
      written.push(entry);
      matched.add(kept);
    }
  }
  return [...written, ...patch.filter((entry) => !matched.has(entry))];
}

/** The file as a plain mapping, or null when it no longer parses (the registry then serves its last good definition). */
function readRawDoc(file: string): Record<string, unknown> | null {
  try {
    const raw = yaml.load(fs.readFileSync(file, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function loadedOrThrow(id: string): Project {
  const project = refreshProjects().byId.get(id);
  if (!project) throw new ProjectWriteError(`project ${id} was written but did not load; see the gateway log`, "invalid");
  return project;
}
