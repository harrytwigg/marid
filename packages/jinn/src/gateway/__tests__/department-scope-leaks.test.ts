import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { as, call, callRaw, home, sessionHeaders, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { makeOutsideFile, makeWorkdir, rewriteSideProject } from "./department-scope-fixtures.js";

/**
 * Regression cases from review: the FR-018 path check whatever the Content-Type, ids
 * outside the department in any part of a successful answer, a scope change that would
 * drop members, a spawn's parent, and malformed bodies answered as the route answers them.
 */

type Modules = Awaited<ReturnType<typeof startScopedHarness>>;
let workItems: Modules["workItems"];

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
  const work = makeWorkdir("leaks");
  await rewriteSideProject([`workdirs: ["${work.dir}"]`]);
});

describe("FR-018 on the JSON path upload", () => {
  const upload = async (sessionId: string, todo: string, file: string, type: string | undefined) =>
    callRaw("POST", `/api/work-items/${todo}/attachments`, JSON.stringify({ path: file }), { ...sessionHeaders(sessionId), "content-type": type });

  it.each([["text/plain"], [undefined], ["application/x-www-form-urlencoded"], ["application/json"]])("refuses a path outside the roots sent as %s", async (type) => {
    const mine = workItems.createWorkItem({ title: "mine", department: "side-project" });
    const self = await sessionOf("side-dev");
    const refused = await upload(self.id, mine.id, makeOutsideFile(), type);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/outside this department's working directories/);
  });

  it.each([["text/plain"], ["application/json"]])("answers an outside path sent as %s the same for a Todo outside D as for an unknown id", async (type) => {
    const theirs = workItems.createWorkItem({ title: "theirs" });
    const self = await sessionOf("side-dev");
    const file = makeOutsideFile();
    const outside = await upload(self.id, theirs.id, file, type);
    const unknown = await upload(self.id, theirs.id.replace(/\d+$/, "99999"), file, type);
    expect(outside).toEqual(unknown);
  });
});

describe("no id outside the department in a successful answer", () => {
  it("leaves no related Todo or unbound session in a Todo's read, its list row or its tree", async () => {
    const mine = workItems.createWorkItem({ title: "mine", department: "side-project" });
    const company = workItems.createWorkItem({ title: "company" });
    const { addRelation } = await import("../../work-items/relations.js");
    addRelation(mine.id, company.id, "blocks", "operator");
    const coo = await sessionOf(null);
    workItems.linkSession(mine.id, coo.id, `session:${coo.id}`, "review");
    const scoped = as((await sessionOf("side-dev")).id);
    for (const url of [`/api/work-items/${mine.id}`, `/api/work-items?ids=${mine.id}`, `/api/work-items?limit=100`, `/api/work-items/${mine.id}/tree`, `/api/work-items/${mine.id}/comments`]) {
      const answer = await scoped("GET", url);
      expect(answer.status, url).toBe(200);
      const text = JSON.stringify(answer.body);
      expect(text, url).not.toContain(company.id);
      expect(text, url).not.toContain(coo.id);
    }
  });

  it("names the caller's own requester, and hides any other unbound session", async () => {
    const coo = await sessionOf(null);
    const other = await sessionOf(null);
    const peer = await sessionOf("side-qa", { parentSessionId: other.id });
    const self = await sessionOf("side-dev", { parentSessionId: coo.id });
    const scoped = as(self.id);
    expect((await scoped("GET", `/api/sessions/${self.id}`)).body.parentSessionId).toBe(coo.id);
    expect((await scoped("GET", `/api/sessions/${peer.id}`)).body.parentSessionId).toBe("hidden");
  });

  it("leaves error answers alone, so an outside id still reads as an unknown one", async () => {
    const theirs = workItems.createWorkItem({ title: "theirs" });
    const scoped = as((await sessionOf("side-dev")).id);
    const outside = await scoped("POST", `/api/work-items/${theirs.id}/dispatch`);
    expect(outside).toMatchObject({ status: 404, body: { error: `Todo ${theirs.id} not found` } });
  });
});

describe("a scope change through the API", () => {
  it("is refused, naming them, when a member could not be a scoped employee", async () => {
    const dir = path.join(home, "org", "workshop");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "department.yaml"), "name: workshop\n");
    fs.writeFileSync(path.join(dir, "shop-codex.yaml"), "name: shop-codex\ndisplayName: shop-codex\ndepartment: workshop\nrank: employee\nengine: codex\nmodel: gpt-5.6-sol\npersona: Works.\n");
    const { refreshOrg } = await import("../org-registry.js");
    refreshOrg();
    const refused = await call("PATCH", "/api/departments/workshop", { scope: "scoped" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "department-members", members: [{ name: "shop-codex" }] });
    expect(fs.readFileSync(path.join(dir, "department.yaml"), "utf-8")).not.toMatch(/scope/);
  });
});

describe("a spawn naming a parent outside D", () => {
  it("is answered as for an unknown parent: the caller becomes the parent", async () => {
    const coo = await sessionOf(null);
    const self = await sessionOf("side-dev");
    const spawned = await as(self.id)("POST", "/api/sessions", { prompt: "help", employee: "side-qa", parentSessionId: coo.id });
    expect(spawned.status).toBe(201);
    expect(spawned.body.parentSessionId).toBe(self.id);
  });
});

describe("a malformed body", () => {
  it.each([
    ["POST", "/api/work-items", "{not json"],
    ["POST", "/api/work-items", "[1,2]"],
    ["POST", "/api/delegations", "{not json"],
    ["POST", "/api/delegations", "{}"],
  ])("%s %s with %s is answered by the route, as for an unscoped session", async (method, url, raw) => {
    const scoped = await callRaw(method, url, raw, { ...sessionHeaders((await sessionOf("side-dev")).id), "content-type": "application/json" });
    const open = await callRaw(method, url, raw, { ...sessionHeaders((await sessionOf("eng-dev")).id), "content-type": "application/json" });
    expect(scoped).toEqual(open);
  });
});
