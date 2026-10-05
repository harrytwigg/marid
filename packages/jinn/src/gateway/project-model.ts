import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveJinnHome } from "../shared/paths.js";
import { normalisedWorkdir, workdirRefusal } from "./project-workdirs.js";

/** A project: a named grouping of Todos, defined by one YAML file under `projects/`. */
export interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  /** Parsed and carried; nothing enforces it until scoped employees exist. */
  dedicated: boolean;
  workdirs: string[];
  skills: string[];
  sharedNotes: string[];
  instructions: "project" | "project+company";
  /** The defining file, relative to the instance home. */
  file: string;
}

export const PROJECT_ID_PATTERN = /^prj_[0-9a-f]{12}$/;
export const PROJECT_NAME_MAX = 100;
/** The filter grammar uses these two words, so no project may carry them. */
const RESERVED_NAMES = new Set(["none", "all"]);

/** A problem with a single field: that entry is dropped, the project stays loaded. */
export interface ProjectProblem {
  field: string;
  message: string;
}

export type ParsedProject =
  | { ok: true; project: Project; problems: ProjectProblem[] }
  | { ok: false; error: string };

type Doc = Record<string, unknown>;

function stringList(value: unknown, field: string, problems: ProjectProblem[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ field, message: `${field} must be a list; ignored` });
    return [];
  }
  return value.filter((entry): entry is string => {
    const ok = typeof entry === "string" && entry.trim() !== "";
    if (!ok) problems.push({ field, message: `${field} entry ${JSON.stringify(entry)} is not a string; dropped` });
    return ok;
  }).map((entry) => entry.trim());
}

/** A skill the allow-list names must still exist as a directory under `skills/`. */
function keepSkills(names: string[], problems: ProjectProblem[]): string[] {
  const skillsDir = path.join(resolveJinnHome(), "skills");
  return names.filter((name) => {
    const ok = !/[\\/]/.test(name) && name !== "." && name !== ".."
      && fs.existsSync(path.join(skillsDir, name));
    if (!ok) problems.push({ field: "skills", message: `skill "${name}" does not exist; dropped` });
    return ok;
  });
}

function keepWorkdirs(entries: string[], problems: ProjectProblem[]): string[] {
  const kept: string[] = [];
  for (const entry of entries) {
    const refusal = workdirRefusal(entry);
    if (refusal) problems.push({ field: "workdirs", message: `${refusal}; dropped` });
    else kept.push(normalisedWorkdir(entry));
  }
  return kept;
}

/** Shared Notes are paths under `knowledge/` or `docs/`, relative to the home. */
function keepSharedNotes(entries: string[], problems: ProjectProblem[]): string[] {
  return entries.filter((entry) => {
    const clean = path.posix.normalize(entry.replaceAll("\\", "/"));
    const ok = !path.isAbsolute(entry) && !clean.startsWith("..") && /^(knowledge|docs)(\/|$)/.test(clean);
    if (!ok) problems.push({ field: "sharedNotes", message: `shared note path "${entry}" is outside knowledge/ and docs/; dropped` });
    return ok;
  });
}

/** A flag that is present but not a boolean could silently turn off a restriction, so it refuses the file. */
function flag(doc: Doc, key: "archived" | "dedicated"): boolean | string {
  const value = doc[key];
  if (value === undefined || value === null) return false;
  return typeof value === "boolean" ? value : `${key} must be true or false`;
}

/** The identity of a file: its id and name. Anything wrong here refuses the file. */
function identityOf(doc: Doc): { id: string; name: string } | string {
  if (typeof doc.id !== "string" || !PROJECT_ID_PATTERN.test(doc.id)) return "id must be prj_ followed by 12 hex characters";
  if (typeof doc.name !== "string" || !doc.name.trim()) return "name is required";
  const name = doc.name.trim();
  if (name.length > PROJECT_NAME_MAX) return `name is longer than ${PROJECT_NAME_MAX} characters`;
  if (RESERVED_NAMES.has(name.toLowerCase())) return `"${name}" is a reserved name`;
  return { id: doc.id, name };
}

/** The scalar fields whose wrong value would silently loosen a restriction: wrong, they refuse the file. */
function scalarsOf(doc: Doc): { archived: boolean; dedicated: boolean; instructions: Project["instructions"] } | string {
  const archived = flag(doc, "archived");
  const dedicated = flag(doc, "dedicated");
  if (typeof archived === "string") return archived;
  if (typeof dedicated === "string") return dedicated;
  const mode = doc.instructions ?? "project";
  if (mode !== "project" && mode !== "project+company") return "instructions must be project or project+company";
  return { archived, dedicated, instructions: mode };
}

/** Parse and validate one project document. `file` is its path relative to the home. */
export function parseProject(text: string, file: string): ParsedProject {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return { ok: false, error: `YAML does not parse: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "the file is not a YAML mapping" };
  const data = doc as Doc;
  const identity = identityOf(data);
  if (typeof identity === "string") return { ok: false, error: identity };
  const scalars = scalarsOf(data);
  if (typeof scalars === "string") return { ok: false, error: scalars };
  const problems: ProjectProblem[] = [];
  const project: Project = {
    ...identity,
    ...scalars,
    description: typeof data.description === "string" ? data.description : "",
    workdirs: keepWorkdirs(stringList(data.workdirs, "workdirs", problems), problems),
    skills: keepSkills(stringList(data.skills, "skills", problems), problems),
    sharedNotes: keepSharedNotes(stringList(data.sharedNotes, "sharedNotes", problems), problems),
    file,
  };
  return { ok: true, project, problems };
}

/** The YAML a project definition is written as. Keys the file carried beyond these are the caller's to merge. */
export function dumpProjectDoc(doc: Doc): string {
  return yaml.dump(doc, { lineWidth: -1 });
}
