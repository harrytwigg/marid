import { describe, it, expect } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";
import {
  api,
  ctx,
  expectNoHostileInput,
  hostileInputs,
  makeRawReq,
  makeReq,
  makeRes,
  operatorHeaders,
  reg,
  store,
  toolHeaders,
} from "./helpers/work-items-route-harness.js";

describe("PATCH /api/work-items/:id — operator metadata editing", () => {
  it("lets the operator PATCH the verify policy (set and clear) — the rail's verify picker lane", async () => {
    const item = store.createWorkItem({ title: "Verify policy edit", status: "backlog" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        verifyPolicy: { mode: "thorough", maxRounds: 3 },
      }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem.verifyPolicy).toEqual({ mode: "thorough", maxRounds: 3 });

    const clear = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: cap.body.workItem.version,
        verifyPolicy: null,
      }, operatorHeaders),
      clear.res,
      ctx,
    );
    expect(clear.status).toBe(200);
    expect(clear.body.workItem.verifyPolicy).toBeNull();
  });

  it("refuses an invalid verify policy mode readably", async () => {
    const item = store.createWorkItem({ title: "Verify policy invalid", status: "backlog" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        verifyPolicy: { mode: "paranoid" },
      }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/verifyPolicy\.mode/);
  });

  it("keeps verifyPolicy operator-only: the creator session's PATCH is refused for that field", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "vp-caller", employee: "platform-worker" });
    const item = store.createWorkItem({ title: "Agent vp edit", status: "backlog", createdBy: "platform-worker" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        verifyPolicy: { mode: "trust" },
      }, toolHeaders(caller.id)),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(403);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toBeNull();
  });

  it("lets the authenticated operator edit metadata and manual rank without changing status", async () => {
    const item = store.createWorkItem({ title: "Before edit", body: "old body", status: "backlog" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, {
        expectedVersion: item.version,
        title: "After edit",
        body: "new body",
        assignee: "platform-worker",
        department: "platform",
        priority: 3,
        rank: 12.5,
      }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({
      id: item.id,
      title: "After edit",
      body: "new body",
      assignee: "platform-worker",
      department: "platform",
      priority: 3,
      rank: 12.5,
      status: "backlog",
      version: 2,
    });
    expect(cap.body.replayed).toBe(false);
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "After edit", body: "new body", status: "backlog" });
  });

  it("rejects unauthenticated callers, bad capabilities, and ownership edits by a session", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "patch-caller", employee: "platform-worker" });
    const item = store.createWorkItem({ title: "Protected edit", assignee: "platform-worker", department: "platform" });

    const unauthenticated = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Spoofed" }), unauthenticated.res, ctx);
    expect(unauthenticated.status).toBe(403);

    // A session edits content freely, and is refused ownership by name.
    const session = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Session edit", expectedVersion: item.version }, toolHeaders(caller.id)),
      session.res,
      ctx,
    );
    expect(session.status).toBe(200);

    const ownership = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { department: "marketing", expectedVersion: session.body.workItem.version }, toolHeaders(caller.id)),
      ownership.res,
      ctx,
    );
    expect(ownership.status).toBe(403);
    expect(ownership.body.error).toContain('"department"');
    expect(ownership.body.error).toMatch(/operator/i);

    const badCapability = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "Bad cap" }, {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: caller.id,
        [CALLER_SESSION_CAPABILITY_HEADER]: "bad-capability",
      }),
      badCapability.res,
      ctx,
    );
    expect(badCapability.status).toBe(403);
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "Session edit", department: "platform" });
  });

  it("rejects status in PATCH and keeps lifecycle changes on the guarded transition route", async () => {
    const item = store.createWorkItem({ title: "Lifecycle separation", status: "backlog" });
    const patch = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { status: "done", expectedVersion: item.version }, operatorHeaders),
      patch.res,
      ctx,
    );
    expect(patch.status).toBe(400);
    expect(patch.body.error).toMatch(/status.*transition|transition.*status/i);
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");

    const transition = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/status`, { status: "done" }, operatorHeaders),
      transition.res,
      ctx,
    );
    expect(transition.status).toBe(200);
    expect(transition.body.workItem.status).toBe("done");
  });

  it.each([
    [{}, /at least one|empty/i],
    [{ source: "cron" }, /source|unsupported|field/i],
    [{ title: "   " }, /title/i],
    [{ body: 7 }, /body/i],
    [{ assignee: "" }, /assignee/i],
    [{ assignee: "missing-worker" }, /unknown employee/i],
    [{ department: "" }, /department/i],
    [{ priority: 4 }, /priority/i],
    [{ rank: "not-a-rank" }, /rank/i],
  ])("rejects invalid metadata patch %o", async (body, message) => {
    const item = store.createWorkItem({ title: "Validation target" });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, ...body }, operatorHeaders), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(message);
  });

  it.each([
    ["empty", "", "application/json", "Todo edit request must be valid JSON."],
    ["whitespace", " \n\t ", "application/json", "Todo edit request must be valid JSON."],
    ["truncated object", '{"title":"cut off"', "application/json", "Todo edit request must be valid JSON."],
    ["invalid token", `{"title":"${hostileInputs[0]}",oops}`, "application/json", "Todo edit request must be valid JSON."],
    ["array", '[{"title":"no"}]', "application/json", "Todo edit request must be a JSON object."],
    ["string primitive", `"${hostileInputs[1]}"`, "application/json", "Todo edit request must be a JSON object."],
    ["number primitive", "42", "application/json", "Todo edit request must be a JSON object."],
    ["null primitive", "null", "application/json", "Todo edit request must be a JSON object."],
    ["duplicate key", '{"expectedVersion":1,"title":"first","title":"second"}', "application/json", "Todo edit request must be valid JSON."],
    ["missing content type", '{"expectedVersion":1,"title":"safe"}', "", "Todo edit request must be valid JSON."],
    ["wrong content type", '{"expectedVersion":1,"title":"safe"}', "text/plain", "Todo edit request must be valid JSON."],
    ["ambiguous content type", '{"expectedVersion":1,"title":"safe"}', "application/json, text/plain", "Todo edit request must be valid JSON."],
    ["dangling media parameter separator", '{"expectedVersion":1,"title":"safe"}', "application/json;", "Todo edit request must be valid JSON."],
    ["parameter without equals", '{"expectedVersion":1,"title":"safe"}', "application/json; charset", "Todo edit request must be valid JSON."],
    ["empty token parameter", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=", "Todo edit request must be valid JSON."],
    ["empty quoted parameter", '{"expectedVersion":1,"title":"safe"}', 'application/json; charset=""', "Todo edit request must be valid JSON."],
    ["missing parameter name", '{"expectedVersion":1,"title":"safe"}', "application/json; =utf-8", "Todo edit request must be valid JSON."],
    ["unterminated quoted parameter", '{"expectedVersion":1,"title":"safe"}', 'application/json; charset="utf-8', "Todo edit request must be valid JSON."],
    ["dangling quoted escape", '{"expectedVersion":1,"title":"safe"}', 'application/json; profile="safe\\', "Todo edit request must be valid JSON."],
    ["duplicate charset", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=utf-8; charset=utf-8", "Todo edit request must be valid JSON."],
    ["conflicting charset", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=utf-8; charset=utf-16", "Todo edit request must be valid JSON."],
    ["duplicate generic parameter", '{"expectedVersion":1,"title":"safe"}', "application/json; profile=one; PROFILE=two", "Todo edit request must be valid JSON."],
    ["header tab control", '{"expectedVersion":1,"title":"safe"}', "application/json;\tcharset=utf-8", "Todo edit request must be valid JSON."],
    ["header NUL control", '{"expectedVersion":1,"title":"safe"}', "application/json; charset=utf-8\u0000", "Todo edit request must be valid JSON."],
    ["empty structured suffix prefix", '{"expectedVersion":1,"title":"safe"}', "application/+json", "Todo edit request must be valid JSON."],
  ])("returns a fixed typed response for %s Todo edit bodies", async (_name, raw, contentType, error) => {
    const item = store.createWorkItem({ title: "Raw validation target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const cap = makeRes();
    const headers = { ...operatorHeaders, "content-type": contentType };
    await api.handleApiRequest(makeRawReq("PATCH", `/api/work-items/${item.id}`, raw, headers), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({
      error,
      code: "todo_invalid_patch",
    });
    expectNoHostileInput(cap.body);
    expect(store.getWorkItem(item.id)).toMatchObject({ title: "Raw validation target", version: 1 });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
  });

  it.each([
    "application/json",
    "Application/JSON",
    " application/json ",
    "application/json;charset=utf-8",
    "application/json ; charset = UTF-8 ; profile = safe",
    'application/json; charset="utf-8"; profile="safe value"',
    'application/json; profile="safe,comma"',
    "application/merge-patch+json",
    "application/vnd.example.todo+json; version=1",
  ])("accepts the valid JSON media type %s", async (contentType) => {
    const item = store.createWorkItem({ title: "Valid media target" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, '{"expectedVersion":1,"title":"valid media"}', {
        ...operatorHeaders,
        "content-type": contentType,
      }),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject({ title: "valid media", version: 2 });
  });
});
