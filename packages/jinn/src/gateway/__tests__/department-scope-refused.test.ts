import { beforeAll, describe, expect, it } from "vitest";
import { as, call, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { matchScopedRoute, REFUSED_ROUTES } from "../department-scope/rules.js";
import type { Session } from "../../shared/types.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * FR-010 and FR-017: default deny. Every route the table refuses answers 403 naming the
 * reason and the department; a route nobody classified answers 403 too. Beside it, the
 * same requests as an unscoped session and as the operator, which are unchanged (Q6-b).
 */

let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let self: Session;
let eng: Session;
let mine: WorkItem;
let company: WorkItem;

/** A concrete path for a table pattern: parameters filled in, a prefix's tail dropped. */
const sample = (route: string) => route.replace(/:[A-Za-z]+/g, "x").replace(/\*$/, "").replace(/\/$/, "");

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
  self = await sessionOf("side-dev");
  eng = await sessionOf("eng-dev");
  mine = workItems.createWorkItem({ title: "refused-mine", department: "side-project" });
  company = workItems.createWorkItem({ title: "refused-company" });
});

describe("refused routes", () => {
  it.each(Object.entries(REFUSED_ROUTES))("%s is refused with its reason", async (route, reason) => {
    const url = sample(route);
    expect(matchScopedRoute("POST", url)).toBeUndefined();
    const refused = await as(self.id)("POST", url, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain(`${reason} is outside department "side-project"`);
  });

  it("refuses a route nobody classified, by default", async () => {
    const refused = await as(self.id)("GET", "/api/brand-new-route");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/a route not open to department-scoped sessions is outside department "side-project"/);
  });

  it.each([
    ["GET", "/api/cron"],
    ["GET", "/api/config"],
    ["GET", "/api/skills"],
    ["GET", "/api/search/global?q=x"],
    ["GET", "/api/cost/report"],
    ["GET", "/api/connectors"],
    ["GET", "/api/departments/side-project"],
    ["PATCH", "/api/departments/side-project"],
    ["PATCH", "/api/org/employees/side-qa"],
    ["POST", "/api/sprints"],
  ])("refuses %s %s whatever the body", async (method, url) => {
    expect((await as(self.id)(method, url, {})).status).toBe(403);
  });

  it("refuses the Todo routes the table closes: sprint, archive and label creation", async () => {
    for (const [method, url] of [["PUT", `/api/work-items/${mine.id}/sprint`], ["POST", `/api/work-items/${mine.id}/archive`], ["POST", "/api/labels"]] as const) {
      const refused = await as(self.id)(method, url, {});
      expect(refused.status, `${method} ${url}`).toBe(403);
    }
  });
});

describe("a scoped session's Todo writes cannot move a Todo out of D", () => {
  it("is refused changing a Todo's department, by PATCH", async () => {
    const refused = await as(self.id)("PATCH", `/api/work-items/${mine.id}`, { department: "engineering", expectedVersion: mine.version });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(workItems.getWorkItem(mine.id)?.department).toBe("side-project");
  });
});

// Findings. Each states what the scoped route answers today against the route's own answer
// for the same request on an unknown id; the fix flips them red.
describe("known differences from the unscoped route", () => {
  it.fails("answers a search with no filter as the route does, a 400, not a 500", async () => {
    const unscoped = await as(eng.id)("GET", "/api/search/sessions?q=x");
    expect(unscoped.status).toBe(400);
    expect((await as(self.id)("GET", "/api/search/sessions?q=x")).status).toBe(400);
  });

  it.fails("answers a PATCH with no version on a Todo outside D as it does an unknown id (428, not 404)", async () => {
    const unknown = company.id.replace(/\d+$/, "99999");
    const outside = await as(self.id)("PATCH", `/api/work-items/${company.id}`, { title: "x" });
    const missing = await as(self.id)("PATCH", `/api/work-items/${unknown}`, { title: "x" });
    expect({ status: outside.status, body: outside.body }).toEqual({ status: missing.status, body: missing.body });
  });
});

describe("unscoped callers are unchanged", () => {
  const open = () => as(eng.id);

  it("reads every department's Todos, relations and sessions as before", async () => {
    expect((await open()("GET", `/api/work-items/${mine.id}`)).status).toBe(200);
    expect((await open()("GET", `/api/work-items/${company.id}`)).body.hiddenRelations).toBeUndefined();
    const list = await open()("GET", `/api/work-items?ids=${mine.id},${company.id}`);
    expect(list.body.workItems).toHaveLength(2);
    expect((await call("GET", `/api/work-items?ids=${mine.id},${company.id}`)).body.workItems).toHaveLength(2);
  });

  it("is refused nothing the scoped table refuses", async () => {
    for (const url of ["/api/cron", "/api/config", "/api/skills", "/api/org", "/api/departments", "/api/sessions?limit=0"]) {
      expect((await open()("GET", url)).status, url).toBe(200);
      expect((await call("GET", url)).status, url).toBe(200);
    }
  });

  it("sees the whole org and every department", async () => {
    const org = (await open()("GET", "/api/org")).body;
    expect(org.employees.map((employee: { name: string }) => employee.name)).toEqual(expect.arrayContaining(["eng-dev", "other-dev", "side-dev"]));
    const departments = (await call("GET", "/api/departments")).body.departments.map((department: { slug: string }) => department.slug);
    expect(departments).toEqual(expect.arrayContaining(["side-project", "other-side"]));
  });
});
