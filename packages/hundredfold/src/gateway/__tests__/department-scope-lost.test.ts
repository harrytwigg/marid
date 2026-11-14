import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { as, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";
import { SCOPED_ROUTES } from "../department-scope/rules.js";
import { refuseScopedTurn } from "../../sessions/turn/scoped-turn.js";
import { getSession } from "../../sessions/registry.js";

/**
 * A session whose binding is lost (FR-008): created before its department was scoped, or
 * its employee has since moved out, or the department was opened. It is refused on every
 * route except its own transcript, and `refuseScopedTurn` starts no turn in it.
 */

type Refresh = () => void;
let refresh: Refresh;

beforeAll(async () => {
  await startScopedHarness();
  const { refreshOrg } = await import("../org-registry.js");
  const { context } = await import("./department-scope-harness.js");
  refresh = () => refreshOrg(context.getConfig());
});

/** Every row of the table as a concrete request from session `id`. */
function everyRoute(id: string): Array<[string, string]> {
  return SCOPED_ROUTES.map((row) => [row.method === "*" ? "GET" : row.method, row.route.replace(":id", id).replace(/:[a-z]+/g, "x")]);
}

const OWN_READS = (id: string) => new Set([`GET /api/sessions/${id}`, `GET /api/sessions/${id}/messages`, `GET /api/sessions/${id}/transcript`]);

async function assertLost(id: string, reason: RegExp): Promise<void> {
  const caller = as(id);
  const allowed = OWN_READS(id);
  for (const [method, url] of everyRoute(id)) {
    const got = await caller(method, url, {});
    if (allowed.has(`${method} ${url}`)) {
      expect(got.status, `${method} ${url}`).toBe(200);
    } else {
      expect({ route: `${method} ${url}`, status: got.status }).toEqual({ route: `${method} ${url}`, status: 403 });
      expect(got.body.error).toMatch(/This department-scoped session cannot act/);
      expect(got.body.error).toMatch(reason);
    }
  }
  expect(refuseScopedTurn(getSession(id)!, undefined)).toMatch(/cannot start a turn/);
  expect(refuseScopedTurn(getSession(id)!, undefined)).toMatch(reason);
}

describe("a session created before its department was scoped", () => {
  it("has no binding, and is refused every route but its own transcript", async () => {
    writeEmployeeFile("late-project", "late-dev");
    refresh();
    const session = await sessionOf("late-dev");
    expect(session.scopeDepartment ?? null).toBeNull();
    expect((await as(session.id)("GET", "/api/cron")).status).toBe(200);
    writeDepartmentFile("late-project", "name: late-project\nscope: scoped\n");
    refresh();
    await assertLost(session.id, /was created before department "late-project" was scoped/);
  });
});

describe("a session whose employee has moved out", () => {
  it("is refused every route but its own transcript, and starts no turn", async () => {
    writeEmployeeFile("side-project", "mover-dev", { department: "side-project" });
    refresh();
    const session = await sessionOf("mover-dev");
    expect(session.scopeDepartment).toBe("side-project");
    expect((await as(session.id)("GET", "/api/org")).status).toBe(200);
    fs.rmSync(path.join(home, "org", "side-project", "mover-dev.yaml"));
    writeEmployeeFile("engineering", "mover-dev");
    refresh();
    await assertLost(session.id, /bound to department "side-project", which mover-dev is no longer confined to/);
  });

  it("is refused too when the department is opened", async () => {
    writeDepartmentFile("opening-project", "name: opening-project\nscope: scoped\n");
    writeEmployeeFile("opening-project", "opening-dev");
    refresh();
    const session = await sessionOf("opening-dev");
    expect(session.scopeDepartment).toBe("opening-project");
    writeDepartmentFile("opening-project", "name: opening-project\nscope: open\n");
    refresh();
    await assertLost(session.id, /bound to department "opening-project", which opening-dev is no longer confined to/);
  });
});

describe("a session bound to a department its employee is now in a different one of", () => {
  it("names both departments", async () => {
    writeDepartmentFile("from-project", "name: from-project\nscope: scoped\n");
    writeDepartmentFile("to-project", "name: to-project\nscope: scoped\n");
    writeEmployeeFile("from-project", "shifter-dev");
    refresh();
    const session = await sessionOf("shifter-dev");
    fs.rmSync(path.join(home, "org", "from-project", "shifter-dev.yaml"));
    writeEmployeeFile("to-project", "shifter-dev");
    refresh();
    await assertLost(session.id, /bound to department "from-project", but shifter-dev is now in department "to-project"/);
  });
});
