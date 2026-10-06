import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { as, call, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { rewriteSideProject } from "./department-scope-fixtures.js";
import { createNote, searchKnowledge } from "../../notes/store.js";

/**
 * FR-028: a scoped department's Notes are rooted at `knowledge/departments/<slug>/`, so a
 * search is not crowded out by company Notes ahead of the result cap, a shared file is
 * shared alone, and the department's `state.md` is created by the first note write.
 */

const OWN = "knowledge/departments/side-project";
let scoped: ReturnType<typeof as>;

const hits = (body: { results: Array<{ path: string }> }) => body.results.map((hit) => hit.path);
const state = () => path.join(home, OWN, "state.md");
const make = (folder: string, title: string, body: string) => {
  const made = createNote({ title, body, folder }, home);
  if (!made.ok) throw new Error(made.detail);
};

beforeAll(async () => {
  await startScopedHarness();
  scoped = as((await sessionOf("side-dev")).id);
});

describe("searching past the result cap", () => {
  it("finds the department's note although more than twenty company notes outrank it", async () => {
    for (let i = 0; i < 25; i++) make("company", `Company note ${i}`, "quokka quokka quokka quokka quokka");
    make("departments/side-project", "Department note", "quokka once");
    // The operator's twenty best hits are all company notes: the department's is cut off.
    const operator = hits((await call("GET", "/api/knowledge/search?q=quokka")).body);
    expect(operator).toHaveLength(20);
    expect(operator.some((hit) => hit.includes("departments/side-project"))).toBe(false);
    // A scoped search walks only the department's folder, so nothing outranks it.
    expect(hits((await scoped("GET", "/api/knowledge/search?q=quokka")).body)).toEqual([`${OWN}/department-note.md`]);
  });

  it("takes its roots as a parameter, and an accept filter ahead of the cap", () => {
    expect(searchKnowledge("quokka", home, ["knowledge/departments/side-project"]).map((hit) => hit.path)).toEqual([`${OWN}/department-note.md`]);
    expect(searchKnowledge("quokka", home, ["knowledge/company"], (rel) => rel.endsWith("note-3.md")).map((hit) => hit.path)).toEqual(["knowledge/company/company-note-3.md"]);
    expect(searchKnowledge("quokka", home).length).toBe(20);
  });
});

describe("a shared file", () => {
  it("is shared alone: its siblings stay out of search and reads", async () => {
    make("shared", "Shared one", "narwhal here");
    make("shared", "Shared two", "narwhal here too");
    await rewriteSideProject(["sharedNotes: [knowledge/shared/shared-one.md]"]);
    expect(hits((await scoped("GET", "/api/knowledge/search?q=narwhal")).body)).toEqual(["knowledge/shared/shared-one.md"]);
    expect((await scoped("GET", "/api/knowledge/read?path=knowledge/shared/shared-one.md")).status).toBe(200);
    expect((await scoped("GET", "/api/knowledge/read?path=knowledge/shared/shared-two.md")).status).toBe(404);
  });

  it("is found with the department's own notes, once", async () => {
    await rewriteSideProject(["sharedNotes: [knowledge/shared, knowledge/shared/shared-one.md]"]);
    const found = hits((await scoped("GET", "/api/knowledge/search?q=narwhal")).body);
    expect(found.sort()).toEqual(["knowledge/shared/shared-one.md", "knowledge/shared/shared-two.md"]);
    await rewriteSideProject([]);
  });
});

describe("the department's state file", () => {
  it("does not exist until the first note write, and that write creates it", async () => {
    fs.rmSync(path.join(home, OWN), { recursive: true, force: true });
    expect((await scoped("GET", `/api/knowledge/read?path=${OWN}/state.md`)).status).toBe(404);
    const created = await scoped("POST", "/api/notes", { title: "First note", body: "hello" });
    expect(created.status).toBe(201);
    const text = fs.readFileSync(state(), "utf-8");
    expect(text.startsWith("# State\n")).toBe(true);
    expect(text).toContain("## Current");
    expect(text).toContain("- key: value");
    expect(text).not.toMatch(/\bmem\b/);
    expect((await scoped("GET", `/api/notes/read?path=${OWN}/state.md`)).status).toBe(200);
  });

  it("is a keyed-bullet file the note tools keep: an append lands in it and a later write leaves it alone", async () => {
    const read = (await scoped("GET", `/api/notes/read?path=${OWN}/state.md`)).body.note;
    const updated = await scoped("PUT", "/api/notes", { path: read.path, expectedRevision: read.revision, append: "- focus: the launch" });
    expect(updated.status).toBe(200);
    await scoped("POST", "/api/notes", { title: "Second note", body: "again" });
    expect(fs.readFileSync(state(), "utf-8")).toContain("- focus: the launch");
  });

  it("is not seeded over a state note the session created itself", async () => {
    fs.rmSync(path.join(home, OWN), { recursive: true, force: true });
    expect((await scoped("POST", "/api/notes", { title: "State", body: "my own shape" })).status).toBe(201);
    expect(fs.readFileSync(state(), "utf-8")).toContain("my own shape");
    expect(fs.readFileSync(state(), "utf-8")).not.toContain("## Current");
  });

  it("is never the company's state file, which stays out of reach", async () => {
    fs.writeFileSync(path.join(home, "knowledge", "state.md"), "# Company state\n- secret: x\n");
    expect((await scoped("GET", "/api/knowledge/read?path=knowledge/state.md")).status).toBe(404);
    expect(hits((await scoped("GET", "/api/knowledge/search?q=secret")).body)).toEqual([]);
  });
});
