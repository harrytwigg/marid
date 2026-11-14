import { beforeAll, describe, expect, it } from "vitest";
import { as, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import type { Session } from "../../shared/types.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * FR-009, FR-013 and FR-016: an unscoped session (the COO's) working a Todo in D is
 * invisible and unreachable from D; the one send outside D is the live reply to the
 * caller's own requester; spawn and delegation reach only D's members, under a parent
 * bound to D.
 */

let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let registry: Awaited<ReturnType<typeof startScopedHarness>>["registry"];
let todo: WorkItem;
let coo: Session;
let worker: Session;
let otherUnscoped: Session;
let otherScoped: Session;
let self: Session;
let peer: Session;

const unknownSession = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  ({ workItems, registry } = await startScopedHarness());
  todo = workItems.createWorkItem({ title: "sessions-todo", department: "side-project", assignee: "side-dev" });
  coo = await sessionOf(null);
  worker = await sessionOf(null);
  otherUnscoped = await sessionOf("eng-dev");
  otherScoped = await sessionOf("other-dev");
  self = await sessionOf("side-dev", { parentSessionId: coo.id });
  peer = await sessionOf("side-qa");
  workItems.linkSession(todo.id, worker.id, "operator", "review");
  workItems.linkSession(todo.id, peer.id, "operator", "execute");
  registry.insertMessage(worker.id, "assistant", "sessions-secret from the coo");
});

describe("an unscoped session working a Todo in D (FR-009)", () => {
  const scoped = () => as(self.id);

  it("cannot be read: the session, its messages, transcript, children and context answer as unknown ids do", async () => {
    for (const suffix of ["", "/messages", "/transcript", "/children"]) {
      const hidden = await scoped()("GET", `/api/sessions/${worker.id}${suffix}`);
      const unknown = await scoped()("GET", `/api/sessions/${unknownSession}${suffix}`);
      expect({ suffix, status: hidden.status, body: hidden.body }).toEqual({ suffix, status: 404, body: unknown.body });
    }
  });

  it("is absent from every list and search a scoped session can run", async () => {
    const ids = async (url: string, pick: (body: any) => Array<{ id: string }>) => pick((await scoped()("GET", url)).body).map((row) => row.id);
    expect(await ids("/api/sessions", (body) => body.sessions)).not.toContain(worker.id);
    expect(await ids("/api/sessions?limit=0", (body) => body)).not.toContain(worker.id);
    expect(await ids(`/api/work-items/${todo.id}/sessions`, (body) => body)).toEqual([peer.id]);
    const hits = await scoped()("GET", "/api/search/messages?q=sessions-secret");
    expect(hits.body.results).toEqual([]);
    const tree = await scoped()("GET", `/api/work-items/${todo.id}/sessions?tree=1`);
    expect(Object.keys(tree.body.directory)).not.toContain(worker.id);
  });

  it("cannot be messaged or stopped, whether or not it works a D Todo", async () => {
    for (const target of [worker, otherUnscoped, otherScoped]) {
      const sent = await scoped()("POST", `/api/sessions/${target.id}/message`, { message: "psst" });
      const unknown = await scoped()("POST", `/api/sessions/${unknownSession}/message`, { message: "psst" });
      expect({ status: sent.status, body: sent.body }).toEqual({ status: unknown.status, body: unknown.body });
    }
    expect(registry.getMessages(worker.id).some((message) => message.content === "psst")).toBe(false);
    expect((await scoped()("POST", `/api/sessions/${worker.id}/stop`, {})).status).toBe(404);
  });
});

describe("replying to the requester (FR-013)", () => {
  it("lets a session send to its own parent, though the parent is unscoped", async () => {
    const sent = await as(self.id)("POST", `/api/sessions/${coo.id}/message`, { message: "done, see the Todo" });
    expect(sent.status).toBe(200);
    expect(registry.getMessages(coo.id).some((message) => message.content.includes("done, see the Todo"))).toBe(true);
  });

  it("grants no read access to that parent", async () => {
    expect((await as(self.id)("GET", `/api/sessions/${coo.id}`)).status).toBe(404);
    expect((await as(self.id)("GET", `/api/sessions/${coo.id}/transcript`)).status).toBe(404);
  });

  it("refuses any other unscoped target, and a parent that is not the caller's own", async () => {
    expect((await as(self.id)("POST", `/api/sessions/${otherUnscoped.id}/message`, { message: "hi" })).status).toBe(404);
    const orphan = await sessionOf("side-qa");
    expect((await as(orphan.id)("POST", `/api/sessions/${coo.id}/message`, { message: "hi" })).status).toBe(404);
  });
});

describe("spawn and delegation (FR-016)", () => {
  it("spawns only D's members, and binds the child to D", async () => {
    const made = await as(self.id)("POST", "/api/sessions", { employee: "side-qa", prompt: "go" });
    expect(made.status).toBe(201);
    expect(made.body.scopeDepartment).toBe("side-project");
    for (const employee of ["eng-dev", "other-dev", "nobody-here"]) {
      const refused = await as(self.id)("POST", "/api/sessions", { employee, prompt: "go" });
      expect({ employee, status: refused.status }).toEqual({ employee, status: 403 });
    }
  });

  it("answers a spawn naming a parent outside D as one naming an unknown parent (the caller becomes the parent), and keeps one bound to D", async () => {
    const outside = await as(self.id)("POST", "/api/sessions", { employee: "side-qa", prompt: "go", parentSessionId: otherUnscoped.id });
    const unknown = await as(self.id)("POST", "/api/sessions", { employee: "side-qa", prompt: "go", parentSessionId: "00000000-0000-4000-8000-000000000000" });
    expect([outside.status, outside.body.parentSessionId]).toEqual([201, self.id]);
    expect([unknown.status, unknown.body.parentSessionId]).toEqual([201, self.id]);
    const scopedOther = await as(self.id)("POST", "/api/sessions", { employee: "side-qa", prompt: "go", parentSessionId: otherScoped.id });
    expect([scopedOther.status, scopedOther.body.parentSessionId]).toEqual([201, self.id]);
    const own = await as(self.id)("POST", "/api/sessions", { employee: "side-qa", prompt: "go", parentSessionId: peer.id });
    expect([own.status, own.body.parentSessionId]).toEqual([201, peer.id]);
  });

  it("delegates only to D's members, and drops a named parent outside D", async () => {
    const refused = await as(self.id)("POST", "/api/delegations", { employee: "other-dev", task: "x", title: "x" });
    expect(refused.status).toBe(403);
    const made = await as(self.id)("POST", "/api/delegations", { employee: "side-qa", task: "x", title: "x", parentSessionId: coo.id });
    expect(made.status).toBe(201);
    const child = registry.getSession(made.body.sessionId)!;
    expect(child.scopeDepartment).toBe("side-project");
    expect(child.parentSessionId).toBe(self.id);
  });

  it("dispatches a D Todo only to a member", async () => {
    const held = workItems.createWorkItem({ title: "sessions-held", department: "side-project", assignee: "eng-dev" });
    const refused = await as(self.id)("POST", `/api/work-items/${held.id}/dispatch`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/eng-dev is not a member of department "side-project"/);
  });
});
