import path from "node:path";
import { createNote, listNotes, NOTE_FILE_MAX_BYTES, readNote, searchKnowledge, updateNote } from "../../notes/store.js";
import type { NoteStoreResult } from "../../shared/types.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { departmentRecord } from "../department-registry.js";
import { readJsonBody } from "../http-helpers.js";
import { badRequest, json } from "../route-helpers.js";
import { readCleanSearchParam, SEARCH_QUERY_ROUTE_CHAR_CAP } from "../work-item-query.js";
import { forbid, type GateRequest } from "./gate.js";

/**
 * Notes and knowledge for a scoped session (FR-028): rooted at the department's own
 * folder, `knowledge/departments/<slug>/`, plus whatever the department shares
 * (`sharedNotes`). Writes go only into the department's folder. The company
 * `knowledge/state.md`, `knowledge/employees/` and `docs/` are out of reach unless
 * shared.
 *
 * The gate serves these routes itself, from the same stores the routes use, so a
 * scoped session has its Notes even where `gateway.notesEnabled` is off: the folder is
 * the department's, so the flag's reason does not apply. A path outside the roots
 * answers as a missing file does.
 */

const NOTES_BODY_MAX_BYTES = NOTE_FILE_MAX_BYTES * 6 + 64_000;
const FAILURE_STATUS = { "invalid-path": 400, forbidden: 403, "not-found": 404, conflict: 409, "too-large": 413, "already-exists": 409 } as const;

/** The department's own folder, relative to `knowledge/`. */
export function departmentNotesFolder(slug: string): string {
  return `departments/${slug}`;
}

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

function failure(g: GateRequest, result: Extract<NoteStoreResult<unknown>, { ok: false }>): true {
  json(g.res, { error: result.detail, ...(result.currentRevision ? { currentRevision: result.currentRevision } : {}) }, FAILURE_STATUS[result.reason]);
  return true;
}

function knowledgeSearch(g: GateRequest): boolean {
  const q = readCleanSearchParam(g.route.url, "q");
  if (!q || q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) return false; // the route refuses it in its own words
  const results = searchKnowledge(q, resolveJinnHome()).filter((hit) => inDepartmentKnowledge(g.caller.department, hit.path));
  json(g.res, { query: q, results });
  return true;
}

function knowledgeRead(g: GateRequest): boolean {
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
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return false;
  if (!inDepartmentKnowledge(g.caller.department, raw.startsWith("knowledge/") ? raw : `knowledge/${raw}`)) {
    return json(g.res, { error: `no such note: ${raw}` }, 404), true;
  }
  const result = readNote(raw, resolveJinnHome());
  if (!result.ok) return failure(g, result);
  json(g.res, { note: result.value });
  return true;
}

async function notesCreate(g: GateRequest): Promise<boolean> {
  const parsed = await readJsonBody(g.req, g.res, { maxBytes: NOTES_BODY_MAX_BYTES });
  if (!parsed.ok) return true;
  const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body as Record<string, unknown> : {};
  if (typeof body.title !== "string") return badRequest(g.res, "title is required and must be a string"), true;
  if (body.body !== undefined && typeof body.body !== "string") return badRequest(g.res, "body must be a string"), true;
  if (body.folder !== undefined && typeof body.folder !== "string") return badRequest(g.res, "folder must be a string"), true;
  const own = departmentNotesFolder(g.caller.department);
  const folder = typeof body.folder === "string" && body.folder.trim() ? body.folder.trim() : own;
  if (!inDepartmentKnowledge(g.caller.department, `knowledge/${folder}`, { writable: true })) {
    return forbid(g, `Notes are written only under knowledge/${own}/`);
  }
  const result = createNote({ title: body.title, ...(typeof body.body === "string" ? { body: body.body } : {}), folder }, resolveJinnHome());
  if (!result.ok) return failure(g, result);
  g.deps.context.emit("notes:changed", { path: result.value.path, revision: result.value.revision, action: "created" });
  json(g.res, { note: result.value }, 201);
  return true;
}

async function notesUpdate(g: GateRequest): Promise<boolean> {
  const parsed = await readJsonBody(g.req, g.res, { maxBytes: NOTES_BODY_MAX_BYTES });
  if (!parsed.ok) return true;
  const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body as Record<string, unknown> : {};
  if (typeof body.path !== "string") return badRequest(g.res, "path is required and must be a string"), true;
  if (typeof body.expectedRevision !== "string") return badRequest(g.res, "expectedRevision is required and must be a string"), true;
  for (const field of ["title", "body", "append"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") return badRequest(g.res, `${field} must be a string`), true;
  }
  if (body.body !== undefined && body.append !== undefined) return badRequest(g.res, "body and append are mutually exclusive"), true;
  if (body.title === undefined && body.body === undefined && body.append === undefined) return badRequest(g.res, "at least one of title, body, or append is required"), true;
  const notePath = body.path.startsWith("knowledge/") ? body.path : `knowledge/${body.path}`;
  if (!inDepartmentKnowledge(g.caller.department, notePath, { writable: true })) {
    return forbid(g, `Notes are written only under knowledge/${departmentNotesFolder(g.caller.department)}/`);
  }
  const result = updateNote({
    path: body.path,
    expectedRevision: body.expectedRevision,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.body === "string" ? { body: body.body } : {}),
    ...(typeof body.append === "string" ? { append: body.append } : {}),
  }, resolveJinnHome());
  if (!result.ok) return failure(g, result);
  g.deps.context.emit("notes:changed", { path: result.value.path, revision: result.value.revision, action: "updated" });
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
