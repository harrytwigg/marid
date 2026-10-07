import fs from "node:fs";
import path from "node:path";
import { createNote, listNotes, NOTE_FILE_MAX_BYTES, readNote, searchKnowledge, slugify, updateNote } from "../../notes/store.js";
import type { NoteStoreResult } from "../../shared/types.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { hasControlBytes } from "../../shared/sanitize.js";
import { departmentRecord } from "../department-registry.js";
import { readJsonBody } from "../http-helpers.js";
import { badRequest, json } from "../route-helpers.js";
import { readCleanSearchParam, SEARCH_QUERY_ROUTE_CHAR_CAP } from "../work-item-query.js";
import { departmentNotesFolder, seedDepartmentState } from "./department-state.js";
import { forbid, type GateRequest } from "./gate.js";

/**
 * Notes and knowledge for a scoped session (FR-028): rooted at the department's own
 * folder, `knowledge/departments/<slug>/`, plus whatever the department shares
 * (`sharedNotes`). Writes go only into the department's folder, and never to its
 * `INSTRUCTIONS.md`: that file becomes the stage directory's `CLAUDE.md` (FR-029), so a
 * session that could write it would write what every later session of the department
 * loads (FR-029a). The company `knowledge/state.md`, `knowledge/employees/` and `docs/`
 * are out of reach unless shared.
 *
 * The gate serves these routes itself, from the same stores the routes use, so a
 * scoped session has its Notes even where `gateway.notesEnabled` is off: the folder is
 * the department's, so the flag's reason does not apply. A path outside the roots
 * answers as a missing file does.
 */

const NOTES_BODY_MAX_BYTES = NOTE_FILE_MAX_BYTES * 6 + 64_000;
const FAILURE_STATUS = { "invalid-path": 400, forbidden: 403, "not-found": 404, conflict: 409, "too-large": 413, "already-exists": 409 } as const;

function normal(relPath: string): string | null {
  const cleaned = path.posix.normalize(relPath.replace(/\\/g, "/")).replace(/^\.\//, "");
  return cleaned.startsWith("..") || cleaned.startsWith("/") ? null : cleaned;
}

/** Whether an instance-relative path (`knowledge/...`, `docs/...`) is inside D's roots. */
export function inDepartmentKnowledge(slug: string, relPath: string, { writable = false } = {}): boolean {
  const target = normal(relPath);
  if (!target) return false;
  const own = `knowledge/${departmentNotesFolder(slug)}`;
  if (target === own || target.startsWith(`${own}/`)) return true;
  if (writable) return false;
  return (departmentRecord(slug).definition?.sharedNotes ?? []).some((shared) => {
    const root = normal(shared)?.replace(/\/$/, "");
    return !!root && (target === root || target.startsWith(`${root}/`));
  });
}

const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

function sameFile(a: string, b: string): boolean {
  try {
    const first = fs.statSync(a);
    const second = fs.statSync(b);
    return first.ino === second.ino && first.dev === second.dev;
  } catch {
    return false;
  }
}

/**
 * Whether an instance-relative path (`knowledge/...`) is department `slug`'s
 * `INSTRUCTIONS.md`. The name is judged in any case, and a file that is the same file on
 * disk counts too: on a case-insensitive filesystem `Instructions.md`, or any spelling the
 * filesystem folds to it, reaches the same file, and so does a hard link.
 */
export function isDepartmentInstructions(slug: string, relPath: string): boolean {
  const target = normal(relPath);
  if (!target) return false;
  if (path.posix.basename(target).toLowerCase() === INSTRUCTIONS_FILE.toLowerCase()) return true;
  return sameFile(path.join(resolveJinnHome(), target), path.join(resolveJinnHome(), "knowledge", departmentNotesFolder(slug), INSTRUCTIONS_FILE));
}

/** The refusal for a write to the department's instructions. */
function refuseInstructions(g: GateRequest): true {
  return forbid(g, `${INSTRUCTIONS_FILE} is set by the operator and cannot be written by a department-scoped session`);
}

function isDirectory(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directories a scoped search walks (FR-028): the department's folder and what it
 * shares. A shared file is reached through its own folder, and the search accepts it by
 * name. A root inside another is dropped, so no file is found twice.
 */
export function departmentSearchRoots(slug: string): string[] {
  const home = resolveJinnHome();
  const shared = (departmentRecord(slug).definition?.sharedNotes ?? []).map((entry) => (isDirectory(path.join(home, entry)) ? entry : path.posix.dirname(entry)));
  const roots = [...new Set([`knowledge/${departmentNotesFolder(slug)}`, ...shared])];
  return roots.filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)));
}

/** The first note a department writes also creates its state file; clients are told of both. */
function seedState(g: GateRequest): void {
  const seeded = seedDepartmentState(g.caller.department);
  if (seeded) g.deps.context.emit("notes:changed", { path: seeded.path, revision: seeded.revision, action: "created" });
}

function failure(g: GateRequest, result: Extract<NoteStoreResult<unknown>, { ok: false }>): true {
  json(g.res, { error: result.detail, ...(result.currentRevision ? { currentRevision: result.currentRevision } : {}) }, FAILURE_STATUS[result.reason]);
  return true;
}

function knowledgeSearch(g: GateRequest): boolean {
  const q = readCleanSearchParam(g.route.url, "q");
  if (!q || q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) return false; // the route refuses it in its own words
  const { department } = g.caller;
  const results = searchKnowledge(q, resolveJinnHome(), departmentSearchRoots(department), (hit) => inDepartmentKnowledge(department, hit));
  json(g.res, { query: q, results });
  return true;
}

function knowledgeRead(g: GateRequest): boolean {
  // A path with control bytes is refused by the route before anything else; let it.
  if (hasControlBytes(g.route.url.searchParams.get("path") ?? "")) return false;
  const rel = readCleanSearchParam(g.route.url, "path");
  if (!rel || inDepartmentKnowledge(g.caller.department, rel)) return false;
  json(g.res, { error: `no such instance file: ${rel}` }, 404);
  return true;
}

function notesList(g: GateRequest): boolean {
  const q = readCleanSearchParam(g.route.url, "q") ?? undefined;
  if (q && q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) return badRequest(g.res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`), true;
  const all = listNotes({ home: resolveJinnHome(), ...(q ? { query: q } : {}) });
  const visible = (notePath: string) => inDepartmentKnowledge(g.caller.department, notePath.startsWith("knowledge/") ? notePath : `knowledge/${notePath}`);
  json(g.res, { notes: all.notes.filter((note) => visible(note.path)), folders: all.folders.filter((folder) => visible(folder.path)) });
  return true;
}

function notesRead(g: GateRequest): boolean {
  const raw = g.route.url.searchParams.get("path");
  if (!raw || hasControlBytes(raw)) return false;
  if (!inDepartmentKnowledge(g.caller.department, raw.startsWith("knowledge/") ? raw : `knowledge/${raw}`)) {
    return json(g.res, { error: `no such note: ${raw}` }, 404), true;
  }
  const result = readNote(raw, resolveJinnHome());
  if (!result.ok) return failure(g, result);
  json(g.res, { note: result.value });
  return true;
}

type Check = [(body: Record<string, unknown>) => boolean, string];

const CREATE_CHECKS: Check[] = [
  [(body) => typeof body.title !== "string", "title is required and must be a string"],
  [(body) => body.body !== undefined && typeof body.body !== "string", "body must be a string"],
  [(body) => body.folder !== undefined && typeof body.folder !== "string", "folder must be a string"],
];

const UPDATE_CHECKS: Check[] = [
  [(body) => typeof body.path !== "string", "path is required and must be a string"],
  [(body) => typeof body.expectedRevision !== "string", "expectedRevision is required and must be a string"],
  ...(["title", "body", "append"] as const).map((field): Check => [(body) => body[field] !== undefined && typeof body[field] !== "string", `${field} must be a string`]),
  [(body) => body.body !== undefined && body.append !== undefined, "body and append are mutually exclusive"],
  [(body) => body.title === undefined && body.body === undefined && body.append === undefined, "at least one of title, body, or append is required"],
];

/** The JSON object body of a note write, validated as the route validates it; null once it has answered. */
async function noteWriteBody(g: GateRequest, checks: readonly Check[]): Promise<Record<string, string | undefined> | null> {
  const parsed = await readJsonBody(g.req, g.res, { maxBytes: NOTES_BODY_MAX_BYTES });
  if (!parsed.ok) return null;
  const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body as Record<string, unknown> : {};
  const failed = checks.find(([fails]) => fails(body));
  if (failed) return badRequest(g.res, failed[1]), null;
  return body as Record<string, string | undefined>;
}

/** The fields of a note write that are present. */
function present<K extends string>(body: Record<string, string | undefined>, keys: readonly K[]): Partial<Record<K, string>> {
  return Object.fromEntries(keys.filter((key) => typeof body[key] === "string").map((key) => [key, body[key]])) as Partial<Record<K, string>>;
}

async function notesCreate(g: GateRequest): Promise<boolean> {
  const body = await noteWriteBody(g, CREATE_CHECKS);
  if (!body) return true;
  const own = departmentNotesFolder(g.caller.department);
  const folder = body.folder?.trim() || own;
  if (!inDepartmentKnowledge(g.caller.department, `knowledge/${folder}`, { writable: true })) return forbid(g, `Notes are written only under knowledge/${own}/`);
  // The file a title gets is `<slug>.md`: a title that slugs to `instructions` would be the instructions file on a filesystem that folds case.
  if (isDepartmentInstructions(g.caller.department, `knowledge/${folder}/${slugify(body.title!)}.md`)) return refuseInstructions(g);
  const result = createNote({ title: body.title!, ...present(body, ["body"]), folder }, resolveJinnHome());
  if (!result.ok) return failure(g, result);
  g.deps.context.emit("notes:changed", { path: result.value.path, revision: result.value.revision, action: "created" });
  seedState(g);
  json(g.res, { note: result.value }, 201);
  return true;
}

async function notesUpdate(g: GateRequest): Promise<boolean> {
  const body = await noteWriteBody(g, UPDATE_CHECKS);
  if (!body) return true;
  const notePath = body.path!.startsWith("knowledge/") ? body.path! : `knowledge/${body.path}`;
  if (!inDepartmentKnowledge(g.caller.department, notePath, { writable: true })) {
    return forbid(g, `Notes are written only under knowledge/${departmentNotesFolder(g.caller.department)}/`);
  }
  if (isDepartmentInstructions(g.caller.department, notePath)) return refuseInstructions(g);
  const result = updateNote({ path: body.path!, expectedRevision: body.expectedRevision!, ...present(body, ["title", "body", "append"]) }, resolveJinnHome());
  if (!result.ok) return failure(g, result);
  g.deps.context.emit("notes:changed", { path: result.value.path, revision: result.value.revision, action: "updated" });
  seedState(g);
  json(g.res, { note: result.value });
  return true;
}

export function handleKnowledgeRoute(g: GateRequest): boolean | Promise<boolean> {
  const { method, pathname } = g.route;
  if (pathname === "/api/knowledge/search") return knowledgeSearch(g);
  if (pathname === "/api/knowledge/read") return knowledgeRead(g);
  if (pathname === "/api/notes/read") return notesRead(g);
  if (method === "POST") return notesCreate(g);
  if (method === "PUT") return notesUpdate(g);
  return notesList(g);
}
