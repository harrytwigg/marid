import { describe, it, expect } from "vitest";
import {
  api,
  ctx,
  expectNoHostileInput,
  hostileInputs,
  makeReq,
  makeRes,
  operatorHeaders,
  store,
} from "./helpers/work-items-route-harness.js";

describe("PATCH /api/work-items/:id — typed responses never reflect the input", () => {
  it.each([
    [
      "an unsupported field name and value",
      (hostile: string) => ({ title: "safe title", [hostile]: hostile }),
      { error: "Todo edit request contains unsupported fields.", code: "todo_invalid_patch" },
    ],
    [
      "an unknown assignee",
      (hostile: string) => ({ assignee: hostile }),
      { error: "Unknown employee for Todo assignee. Check the organization directory.", code: "todo_invalid_assignee" },
    ],
  ] as const)("never reflects %s in its typed validation response", async (_name, buildPatch, expected) => {
    for (const hostile of hostileInputs) {
      const item = store.createWorkItem({ title: "Reflection privacy target" });
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, ...buildPatch(hostile) }, operatorHeaders),
        cap.res,
        ctx,
      );
      expect(cap.status).toBe(400);
      expect(cap.body).toEqual(expected);
      expectNoHostileInput(cap.body);
    }
  });

  it.each([
    ["status", { status: hostileInputs[0] }, "Todo status must use the guarded status transition surface.", "todo_invalid_patch"],
    ["title shape", { title: { marker: hostileInputs[0] } }, "title must be a string", "todo_invalid_patch"],
    ["title length", { title: hostileInputs[0] + "x".repeat(201) }, "title must be at most 200 characters", "todo_invalid_patch"],
    ["body", { body: { marker: hostileInputs[1] } }, "body must be a string or null", "todo_invalid_patch"],
    ["assignee shape", { assignee: { marker: hostileInputs[2] } }, "assignee must be a non-empty string or null", "todo_invalid_patch"],
    ["department", { department: { marker: hostileInputs[3] } }, "department must be a non-empty string or null", "todo_invalid_patch"],
    ["priority", { priority: hostileInputs[4] }, "priority must be an integer from 0 through 3", "todo_invalid_patch"],
    ["rank", { rank: hostileInputs[5] }, "rank must be a finite number or null", "todo_invalid_patch"],
    ["idempotency key shape", { title: "safe", idempotencyKey: { marker: hostileInputs[0] } }, "Todo edit idempotency key must be a non-empty string.", "todo_invalid_patch"],
    ["idempotency key length", { title: "safe", idempotencyKey: hostileInputs[4] + "x".repeat(257) }, "Todo edit idempotency key is too long.", "todo_invalid_patch"],
    ["idempotency key control", { title: "safe", idempotencyKey: `safe-${hostileInputs[5]}` }, "Todo edit idempotency key contains invalid characters.", "todo_invalid_patch"],
    ["expected version", { title: "safe", expectedVersion: hostileInputs[3] }, "Todo version must be a positive safe integer.", "todo_invalid_version"],
  ])("returns a fixed typed response for rejected %s values", async (_field, patch, error, code) => {
    const item = store.createWorkItem({ title: "Rejected value privacy target" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, ...patch }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error, code });
    expectNoHostileInput(cap.body);
  });

  it("keeps hostile edit content out of precondition and conflict responses", async () => {
    const item = store.createWorkItem({ title: "Conflict privacy target" });
    const hostileTitle = hostileInputs.join("|");

    const missing = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: hostileTitle }, operatorHeaders),
      missing.res,
      ctx,
    );
    expect(missing.body).toEqual({ error: "A current Todo version is required.", code: "todo_precondition_required" });
    expectNoHostileInput(missing.body);

    store.updateWorkItem(item.id, { title: "remote winner" }, "other-tab");
    const stale = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: hostileTitle, expectedVersion: item.version }, operatorHeaders),
      stale.res,
      ctx,
    );
    expect(stale.body).toEqual({
      error: "Todo changed since it was loaded.",
      code: "todo_version_conflict",
      currentVersion: 2,
    });
    expectNoHostileInput(stale.body);

    const keyed = store.createWorkItem({ title: "Idempotency privacy target" });
    const key = "todo:privacy:key-reuse";
    const first = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${keyed.id}`, { title: "first", expectedVersion: keyed.version, idempotencyKey: key }, operatorHeaders),
      first.res,
      ctx,
    );
    const misuse = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${keyed.id}`, { title: hostileTitle, expectedVersion: keyed.version, idempotencyKey: key }, operatorHeaders),
      misuse.res,
      ctx,
    );
    expect(misuse.body).toEqual({
      error: "This Todo edit key was already used for a different request.",
      code: "todo_idempotency_conflict",
      currentVersion: 2,
    });
    expectNoHostileInput(misuse.body);
  });
});
