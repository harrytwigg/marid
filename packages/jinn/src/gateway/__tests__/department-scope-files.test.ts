import { as, call, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { departmentMcpEnv } from "../department-scope/session-env.js";
import { departmentStageDir } from "../department-scope/paths.js";
import { makeOutsideFile, makeWorkdir, rewriteSideProject } from "./department-scope-fixtures.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * FR-018: the JSON `{path}` attachment route reads a local file for the caller, so for a
 * scoped session it accepts only a path whose realpath is inside one of D's working
 * directories or its stage directory. Unscoped callers are unchanged (Q6-b).
 */

let work: { dir: string; file: string };
let outside: string;
let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let todo: WorkItem;
let scopedId: string;
let engId: string;

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
  work = makeWorkdir("files");
  outside = makeOutsideFile();
  fs.symlinkSync(outside, path.join(work.dir, "escape.txt"));
  await rewriteSideProject([`workdirs: ["${work.dir}"]`]);
  todo = workItems.createWorkItem({ title: "files", department: "side-project", assignee: "side-dev" });
  scopedId = (await sessionOf("side-dev")).id;
  engId = (await sessionOf("eng-dev")).id;
});

const attach = (caller: ReturnType<typeof as>, file: string) => caller("POST", `/api/work-items/${todo.id}/attachments`, { path: file });

describe("a scoped session's JSON {path} attachment", () => {
  it("takes a file inside a working directory of its department", async () => {
    const made = await attach(as(scopedId), work.file);
    expect(made.status).toBe(201);
    expect(made.body.attachment.filename).toBe("notes.txt");
  });

  it("takes a file inside the department's stage directory", async () => {
    const stage = departmentStageDir("side-project");
    fs.mkdirSync(stage, { recursive: true });
    const staged = path.join(stage, "CLAUDE.md");
    fs.writeFileSync(staged, "generated\n");
    expect((await attach(as(scopedId), staged)).status).toBe(201);
  });

  it("refuses a file outside, naming where files may come from", async () => {
    const refused = await attach(as(scopedId), outside);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain(`${outside} is outside this department's working directories and stage directory`);
    expect(refused.body.error).toContain(work.dir);
  });

  it.each([
    ["a symlink inside the workdir that points out of it", () => path.join(work.dir, "escape.txt")],
    ["a path that climbs out with ..", () => path.join(work.dir, "..", path.basename(path.dirname(outside)), path.basename(outside))],
    ["a relative path", () => "notes.txt"],
    ["a path that does not exist", () => path.join(work.dir, "missing.txt")],
  ])("refuses %s", async (_why, file) => {
    expect((await attach(as(scopedId), file())).status).toBe(403);
  });

  it("answers 404, not 403, for another department's Todo, whatever the path", async () => {
    const company = workItems.createWorkItem({ title: "company" });
    expect((await as(scopedId)("POST", `/api/work-items/${company.id}/attachments`, { path: work.file })).status).toBe(404);
  });
});

describe("unscoped callers are unchanged", () => {
  it("reads a file anywhere the standing policy allows, as a session and as the operator", async () => {
    expect((await attach(as(engId), outside)).status).toBe(201);
    expect((await attach(call, outside)).status).toBe(201);
    expect((await attach(call, work.file)).status).toBe(201);
  });
});

describe("the roots a scoped session's MCP server is started with", () => {
  it("are its working directories and stage directory", async () => {
    const env = departmentMcpEnv(scopedId);
    expect(env.JINN_DEPARTMENT).toBe("side-project");
    expect(JSON.parse(env.JINN_DEPARTMENT_FILE_ROOTS)).toEqual([work.dir, departmentStageDir("side-project")]);
  });

  it("are not set for an unscoped session", async () => {
    expect(departmentMcpEnv(engId)).toEqual({});
  });
});
