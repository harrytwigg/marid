import { as, call, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createNote } from "../../notes/store.js";
import { rewriteSideProject } from "./department-scope-fixtures.js";

/**
 * FR-017 and FR-028: a scoped session's Notes and knowledge are rooted at its
 * department's folder, plus what the department shares. The company state file, other
 * departments' folders and the rest of the instance read as missing, and writes go only
 * under the department's own folder, with `gateway.notesEnabled` off.
 */

const TERM = "zebrafish";
const OWN = "knowledge/departments/side-project";
let scoped: ReturnType<typeof as>;
let own: { path: string; revision: string };
let shared: { path: string; revision: string };

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), text);
};
const note = (folder: string, title: string) => {
  const made = createNote({ title, body: `${TERM} in ${title}`, folder }, home);
  if (!made.ok) throw new Error(made.detail);
  return { path: made.value.path, revision: made.value.revision };
};
const hits = (body: { results: Array<{ path: string }> }) => body.results.map((hit) => hit.path);
const full = (p: string) => (p.startsWith("knowledge/") ? p : `knowledge/${p}`);

beforeAll(async () => {
  await startScopedHarness();
  write("knowledge/state.md", `# State\n${TERM} current picture\n`);
  write("knowledge/employees/side-dev.md", `# side-dev\n${TERM}\n`);
  write("docs/guide.md", `# Guide\n${TERM}\n`);
  own = note("departments/side-project", "Plan");
  note("departments/other-side", "Other plan");
  note("company", "Company plan");
  shared = note("shared", "Shared guide");
  await rewriteSideProject(["sharedNotes: [knowledge/shared]"]);
  scoped = as((await sessionOf("side-dev")).id);
});

describe("reading", () => {
  it("answers the company state file as a missing file, and the operator reads it", async () => {
    const refused = await scoped("GET", "/api/knowledge/read?path=knowledge/state.md");
    expect(refused).toMatchObject({ status: 404, body: { error: "no such instance file: knowledge/state.md" } });
    expect((await call("GET", "/api/knowledge/read?path=knowledge/state.md")).status).toBe(200);
    for (const rel of ["knowledge/employees/side-dev.md", "docs/guide.md", "knowledge/departments/other-side/other-plan.md", "knowledge/departments/side-project/../../state.md"]) {
      expect((await scoped("GET", `/api/knowledge/read?path=${rel}`)).status, rel).toBe(404);
    }
  });

  it("reads the department's own folder and what it shares", async () => {
    expect((await scoped("GET", `/api/knowledge/read?path=${full(own.path)}`)).status).toBe(200);
    expect((await scoped("GET", `/api/knowledge/read?path=${full(shared.path)}`)).status).toBe(200);
    expect((await scoped("GET", `/api/notes/read?path=${own.path}`)).status).toBe(200);
    expect((await scoped("GET", `/api/notes/read?path=${shared.path}`)).status).toBe(200);
  });

  it("searches only the department's folder and its shared Notes", async () => {
    const operator = hits((await call("GET", `/api/knowledge/search?q=${TERM}`)).body);
    expect(operator.length).toBeGreaterThan(hits((await scoped("GET", `/api/knowledge/search?q=${TERM}`)).body).length);
    const found = hits((await scoped("GET", `/api/knowledge/search?q=${TERM}`)).body);
    expect(found.length).toBeGreaterThan(0);
    for (const hit of found) {
      expect(full(hit).startsWith(`${OWN}/`) || full(hit).startsWith("knowledge/shared/"), hit).toBe(true);
    }
    expect(found.map(full)).toEqual(expect.arrayContaining([full(own.path), full(shared.path)]));
  });

  it("lists only the department's folder and its shared Notes, and answers other Notes as missing", async () => {
    const listed = (await scoped("GET", "/api/notes")).body.notes.map((n: { path: string }) => full(n.path));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((p: string) => p.startsWith(`${OWN}/`) || p.startsWith("knowledge/shared/"))).toBe(true);
    expect((await scoped("GET", "/api/notes/read?path=company/company-plan.md")).status).toBe(404);
  });
});

describe("writing, with gateway.notesEnabled off", () => {
  it("is off for the operator, so the scoped session's Notes do not depend on it", async () => {
    expect((await call("GET", "/api/features")).body.notesEnabled).toBe(false);
    expect((await call("GET", "/api/notes")).status).toBe(404);
    expect((await scoped("GET", "/api/notes")).status).toBe(200);
  });

  it("creates in the department's folder by default, and in a folder beneath it", async () => {
    const made = await scoped("POST", "/api/notes", { title: "Created" });
    expect(made.status).toBe(201);
    expect(full(made.body.note.path).startsWith(`${OWN}/`)).toBe(true);
    const nested = await scoped("POST", "/api/notes", { title: "Nested", folder: "departments/side-project/sub" });
    expect(nested.status).toBe(201);
  });

  it.each(["company", "shared", "departments/other-side", "departments/side-project/../other-side", "departments", ""])("refuses a create in folder %j outside the department's own", async (folder) => {
    const refused = await scoped("POST", "/api/notes", { title: "Elsewhere", folder: folder || "." });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Notes are written only under knowledge/departments/side-project/ (this session is scoped to department \"side-project\")");
  });

  it("updates a Note in its own folder, and refuses a shared one or any other", async () => {
    const updated = await scoped("PUT", "/api/notes", { path: own.path, expectedRevision: own.revision, append: "more" });
    expect(updated.status).toBe(200);
    for (const target of [shared.path, "company/company-plan.md", "state.md"]) {
      const refused = await scoped("PUT", "/api/notes", { path: target, expectedRevision: "0".repeat(64), append: "x" });
      expect({ target, status: refused.status }).toEqual({ target, status: 403 });
    }
  });
});
