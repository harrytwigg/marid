import { beforeAll, describe, expect, it } from "vitest";
import { as, call, sessionOf, startScopedHarness } from "./department-scope-harness.js";

/**
 * The gate's wiring, end to end through `handleApiRequest`: a scoped session is held to
 * its department; an unscoped one is unchanged. The full allow/refuse matrix for every
 * table row lives in its own suite.
 */

type WorkItems = Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let workItems: WorkItems;

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
});

describe("a scoped session", () => {
  it("lists only its department's Todos, and reads another's as unknown", async () => {
    const mine = workItems.createWorkItem({ title: "mine", department: "side-project" });
    const company = workItems.createWorkItem({ title: "company" });
    const scoped = as((await sessionOf("side-dev")).id);
    const list = await scoped("GET", "/api/work-items?limit=100");
    expect(list.status).toBe(200);
    const ids = list.body.workItems.map((row: { workItem?: { id: string }; id?: string }) => row.workItem?.id ?? row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(company.id);
    const outside = await scoped("GET", `/api/work-items/${company.id}`);
    const unknown = await scoped("GET", `/api/work-items/${company.id.replace(/\d+$/, "99999")}`);
    expect(outside).toMatchObject({ status: 404, body: unknown.body });
    expect((await scoped("GET", `/api/work-items/${mine.id}`)).status).toBe(200);
  });

  it("creates in its department whatever it names", async () => {
    const scoped = as((await sessionOf("side-dev")).id);
    const created = await scoped("POST", "/api/work-items", { title: "new", department: "engineering" });
    expect(created.status).toBe(201);
    expect(created.body.workItem.department).toBe("side-project");
  });

  it("is refused the company control plane, with the reason", async () => {
    const scoped = as((await sessionOf("side-dev")).id);
    const cron = await scoped("GET", "/api/cron");
    expect(cron.status).toBe(403);
    expect(cron.body.error).toMatch(/cron is outside department "side-project"/);
  });

  it("delegates only to its department's members", async () => {
    const scoped = as((await sessionOf("side-dev")).id);
    const refused = await scoped("POST", "/api/delegations", { employee: "eng-dev", task: "do it", title: "do it" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/eng-dev is not a member of department "side-project"/);
  });

  it("sees only sessions bound to its department, and may reply to its requester", async () => {
    const coo = await sessionOf(null);
    const peer = await sessionOf("side-qa");
    const self = await sessionOf("side-dev", { parentSessionId: coo.id });
    const scoped = as(self.id);
    expect((await scoped("GET", `/api/sessions/${coo.id}`)).status).toBe(404);
    expect((await scoped("GET", `/api/sessions/${peer.id}`)).status).toBe(200);
    const listed = await scoped("GET", "/api/sessions?limit=0");
    expect(listed.body.map((session: { id: string }) => session.id).sort()).toEqual(expect.arrayContaining([peer.id, self.id]));
    expect(listed.body.some((session: { id: string }) => session.id === coo.id)).toBe(false);
  });
});

describe("an unscoped session", () => {
  it("still reaches every department", async () => {
    const mine = workItems.createWorkItem({ title: "scoped work", department: "side-project" });
    const open = as((await sessionOf("eng-dev")).id);
    expect((await open("GET", `/api/work-items/${mine.id}`)).status).toBe(200);
    expect((await call("GET", "/api/cron")).status).toBe(200);
  });
});
