import { beforeAll, describe, expect, it } from "vitest";
import { as, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { createNote } from "../../notes/store.js";
import { SCOPED_ROUTES } from "../department-scope/rules.js";
import { makeWorkdir, rewriteSideProject } from "./department-scope-fixtures.js";
import { type CaseBuilder, type Fx, type MatrixCase, type Refusal, type Req } from "./department-scope-matrix-cases.js";
import { NOTES_CASES } from "./department-scope-notes-cases.js";
import { SESSION_CASES } from "./department-scope-session-cases.js";
import { TODO_CASES } from "./department-scope-todo-cases.js";

/**
 * Every row of the scoped-caller route table (plan.md, FR-010 to FR-019), keyed
 * `${method} ${route}` exactly as `SCOPED_ROUTES` lists it, has an allow case and a refuse
 * case here, each a real request to the real handler as a session of side-dev. A new row
 * in the table fails the coverage test until it gains a case.
 */

const CASES: Record<string, CaseBuilder> = { ...TODO_CASES, ...SESSION_CASES, ...NOTES_CASES };
const rowKey = (row: { method: string; route: string }) => `${row.method} ${row.route}`;

/**
 * Rows whose refusal is not yet identical to the route's answer for an unknown id: the
 * route checks its caller's standing, or answers an empty list, before it looks the Todo
 * up, so the gate's 404 tells a scoped session that the Todo exists. Kept as `it.fails`
 * so the fix flips them red.
 */
const KNOWN_BUGS: Record<string, string> = {
  "PUT /api/work-items/:id/status": "an unknown id answers 403 (operator-only) before looking the Todo up; an out-of-department Todo answers 404",
  "* /api/work-items/:id/kept": "an unknown id answers 403 (operator-only) before looking the Todo up; an out-of-department Todo answers 404",
  "GET /api/work-items/:id/sessions": "an unknown id answers 200 [] (the route never checks existence); an out-of-department Todo answers 404",
};

let fx: Fx;
let count = 0;

beforeAll(async () => {
  const { workItems } = await startScopedHarness();
  const work = makeWorkdir("matrix");
  await rewriteSideProject([`workdirs: ["${work.dir}"]`, `sharedNotes: []`]);
  const own = createNote({ title: "Plan", body: "zebrafish plan", folder: "departments/side-project" }, home);
  const company = createNote({ title: "Company", body: "zebrafish company", folder: "company" }, home);
  if (!own.ok || !company.ok) throw new Error("note fixtures failed");
  const make = (department: string, assignee: string | null) => workItems.createWorkItem({ title: `todo-${count++}-${Math.random().toString(36).slice(2, 8)}`, department, ...(assignee ? { assignee } : {}) });
  fx = {
    self: await sessionOf("side-dev"),
    peer: await sessionOf("side-qa"),
    coo: await sessionOf(null),
    eng: await sessionOf("eng-dev"),
    note: { path: own.value.path, revision: own.value.revision },
    companyNote: { path: company.value.path },
    workdirFile: work.file,
    mine: (assignee = "side-dev") => make("side-project", assignee),
    theirs: () => make("engineering", null),
  };
});

const mask = (value: unknown, ids: [string, string]) => JSON.stringify(value).replaceAll(ids[0], "<id>").replaceAll(ids[1], "<id>");

async function run(req: Req) {
  return as(fx.self.id)(...req);
}

async function assertRefusal(refusal: Refusal): Promise<void> {
  const got = await run(refusal.req);
  if (refusal.kind === "forbidden") {
    expect(got.status).toBe(403);
    expect(got.body.error).toMatch(refusal.reason);
  } else if (refusal.kind === "narrowed") {
    expect(got.status).toBe(200);
    refusal.check(got.body);
  } else {
    const like = await run(refusal.like);
    expect(got.status).toBe(refusal.status ?? 404);
    expect({ status: got.status, body: mask(got.body, refusal.ids) }).toEqual({ status: like.status, body: mask(like.body, refusal.ids) });
  }
}

describe("the scoped-caller route table", () => {
  it("has a case for every row, so a new row forces a new case", () => {
    const missing = SCOPED_ROUTES.map(rowKey).filter((key) => !(key in CASES));
    expect(missing).toEqual([]);
    const stale = Object.keys(CASES).filter((key) => !SCOPED_ROUTES.some((row) => rowKey(row) === key));
    expect(stale).toEqual([]);
  });

  describe.each(SCOPED_ROUTES.map(rowKey))("%s", (key) => {
    let matrix: MatrixCase;
    beforeAll(async () => { matrix = await CASES[key]!(fx); });

    it("allows a request in its department", async () => {
      const got = await run(matrix.allow);
      if (matrix.allowStatus === "open") expect(got.body?.error ?? "").not.toMatch(/department-scoped|scoped to department/);
      else expect(got.status).toBe(matrix.allowStatus);
    });

    (key in KNOWN_BUGS ? it.fails : it)("refuses a request outside it", async () => {
      for (const refusal of [matrix.refuse].flat()) await assertRefusal(refusal);
    });
  });
});
