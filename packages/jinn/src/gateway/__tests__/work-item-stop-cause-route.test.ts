import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { readStopCause } from "../../work-items/stop-cause.js";
import { initDb } from "../../shared/db.js";

/* PLA-157: a stop nobody can act on is the failure this route exists to
 * stop. "Blocked again for the same reason" tells the operator a Todo stopped
 * and nothing about whose move it is, so a block may say what has to happen and
 * who has to do it. The hint is optional, but a malformed one is refused rather
 * than stored half-said. */
describe("POST /api/work-items/:id/status — stop cause", () => {
  const session = () => reg.createSession({ engine: "codex", source: "web", sourceRef: `stop-cause-${Math.random()}` });

  async function post(itemId: string, body: Record<string, unknown>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${itemId}/status`, body, toolHeaders(session().id)), cap.res, ctx);
    return cap;
  }

  async function put(itemId: string, body: Record<string, unknown>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("PUT", `/api/work-items/${itemId}/status`, body, operatorHeaders), cap.res, ctx);
    return cap;
  }

  const item = (title: string) => store.createWorkItem({ title, status: "executing", assignee: "platform-worker" });
  const hint = { what: "approve the vendor invoice", who: "the operator" };
  const cause = (id: string) => readStopCause(initDb(), id);

  it.each([
    ["an empty what", { what: "", who: "the operator" }],
    ["a whitespace what", { what: "   ", who: "the operator" }],
    ["an empty who", { what: "decide", who: "" }],
    ["a whitespace who", { what: "decide", who: "\t\n" }],
    ["an unknown key", { what: "decide", who: "the operator", when: "soon" }],
    ["a missing half", { what: "decide" }],
    ["a string instead of an object", "the operator decides"],
    ["an array", [{ what: "decide", who: "the operator" }]],
  ])("refuses %s without transitioning", async (_label, unblockHint) => {
    const wi = item("bad hint");
    const cap = await post(wi.id, { status: "blocked", note: "stuck", unblockHint });

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/unblockHint must be an object with non-empty what and who strings, and no other keys/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(cause(wi.id)).toBeUndefined();
  });

  it("accepts a valid hint, blocks, and stores it", async () => {
    const wi = item("good hint");
    const cap = await post(wi.id, { status: "blocked", note: "stuck", unblockHint: hint });

    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
    expect(cause(wi.id)).toEqual({ unblockHint: hint });
  });

  it("trims the hint it stores, so a padded value cannot read as a different one", async () => {
    const wi = item("padded hint");
    await post(wi.id, { status: "blocked", note: "stuck", unblockHint: { what: "  decide  ", who: " the operator " } });
    expect(cause(wi.id)?.unblockHint).toEqual({ what: "decide", who: "the operator" });
  });

  it("stores a park on a block and projects it onto the compact wire", async () => {
    const wi = item("parked");
    const parkedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const cap = await post(wi.id, { status: "blocked", note: "provider quota", parkedUntil });

    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
    expect(cause(wi.id)).toEqual({ parkedUntil });

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?status=blocked`, undefined, operatorHeaders), list.res, ctx);
    const row = (list.body.workItems as Array<Record<string, unknown>>).find((r) => r.id === wi.id);
    expect(row?.parkedUntil).toBe(parkedUntil);
  });

  it("refuses a parkedUntil that is not a timestamp", async () => {
    const wi = item("bad park");
    const cap = await post(wi.id, { status: "blocked", note: "quota", parkedUntil: "when the quota resets" });

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/parkedUntil must be an ISO-8601 timestamp/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it("needs no hint to block, on the agent lane or the operator PUT lane", async () => {
    const byAgent = await post(item("agent block").id, { status: "blocked", note: "stuck" });
    expect([byAgent.status, byAgent.body.workItem?.status]).toEqual([200, "blocked"]);
    expect(cause(byAgent.body.workItem.id)).toBeUndefined();

    const byOperator = await put(item("operator block").id, { status: "blocked" });
    expect([byOperator.status, byOperator.body.workItem?.status]).toEqual([200, "blocked"]);
  });

  it("deletes the cause when the operator routes a blocked Todo back to the queue", async () => {
    const wi = item("unblocked");
    await post(wi.id, { status: "blocked", note: "stuck", unblockHint: hint });
    expect(cause(wi.id)).toEqual({ unblockHint: hint });

    const cap = await put(wi.id, { status: "backlog" });
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "backlog"]);
    expect(cause(wi.id)).toBeUndefined();
  });

  it("deletes the park when the agent puts a blocked Todo back to work", async () => {
    const wi = item("unparked");
    await post(wi.id, { status: "blocked", note: "quota", parkedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect(cause(wi.id)?.parkedUntil).toBeTypeOf("string");

    const cap = await post(wi.id, { status: "executing" });
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "executing"]);
    expect(cause(wi.id)).toBeUndefined();
  });

  /*replaying three attempts to park a date-gated Todo, of which
   * the first two answered success and parked nothing. Now they say why. */
  describe("a park only lands on a move that stops the Todo", () => {
    const until = () => new Date(Date.now() + 9 * 86_400_000).toISOString();
    const backlogItem = (title: string) => store.createWorkItem({ title, status: "backlog" });

    it("refuses parkedUntil on a backlog move instead of dropping it (attempt 1)", async () => {
      const wi = backlogItem("park via backlog");
      const cap = await post(wi.id, { status: "backlog", note: "date-gated", parkedUntil: until() });

      expect(cap.status).toBe(400);
      expect(cap.body.error).toMatch(/parkedUntil parks a Todo in blocked/);
      expect(store.getWorkItem(wi.id)?.status).toBe("backlog");
      expect(cause(wi.id)).toBeUndefined();
    });

    it.each(["backlog", "executing", "in_review"])("refuses parkedUntil on a move to %s", async (status) => {
      const wi = item(`park via ${status}`);
      const cap = await post(wi.id, { status, note: "date-gated", parkedUntil: until() });
      expect(cap.status).toBe(400);
      expect(cap.body.error).toMatch(/parkedUntil parks a Todo in blocked/);
    });

    it("refuses parkedUntil with blockKind dependency, which re-queues rather than parks (attempt 2)", async () => {
      const wi = backlogItem("park via dependency");
      const cap = await post(wi.id, { status: "blocked", blockKind: "dependency", note: "date-gated", parkedUntil: until() });

      expect(cap.status).toBe(400);
      expect(cap.body.error).toMatch(/without blockKind dependency/);
      expect(store.getWorkItem(wi.id)?.status).toBe("backlog");
    });

    it("parks on a plain block, the one that works (attempt 3)", async () => {
      const wi = backlogItem("park via block");
      const parkedUntil = until();
      const cap = await post(wi.id, { status: "blocked", note: "date-gated", parkedUntil });

      expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
      expect(cause(wi.id)).toEqual({ parkedUntil });
    });

    it("refuses the same from the operator surface — the operator's park is deleted by the same write", async () => {
      const wi = backlogItem("operator park via backlog");
      const cap = await put(wi.id, { status: "backlog", parkedUntil: until() });
      expect(cap.status).toBe(400);
    });

    it("moves the date when an agent re-parks a Todo that is already parked", async () => {
      const wi = backlogItem("re-park agent");
      await post(wi.id, { status: "blocked", note: "date-gated", parkedUntil: until() });
      const later = new Date(Date.now() + 20 * 86_400_000).toISOString();

      const cap = await post(wi.id, { status: "blocked", note: "pushed out", parkedUntil: later });
      expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
      expect(cause(wi.id)).toEqual({ parkedUntil: later });
    });

    it("moves the date when the operator re-parks with a note, rather than only recording the note", async () => {
      const wi = backlogItem("re-park operator");
      await post(wi.id, { status: "blocked", note: "date-gated", parkedUntil: until() });
      const later = new Date(Date.now() + 20 * 86_400_000).toISOString();

      const cap = await put(wi.id, { status: "blocked", note: "not before the 20th", parkedUntil: later });
      expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
      expect(cause(wi.id)).toEqual({ parkedUntil: later });
      const note = store.listWorkItemEvents(wi.id).at(-1);
      expect(note).toMatchObject({ kind: "note", toStatus: "blocked", actor: "operator" });
      expect(note?.detail).toMatchObject({ note: "not before the 20th", parkedUntil: later });
    });

    it("still records the operator's note when the park they re-send is the one already stored", async () => {
      const wi = backlogItem("re-park operator same date");
      const parkedUntil = until();
      await post(wi.id, { status: "blocked", note: "date-gated", parkedUntil });

      const cap = await put(wi.id, { status: "blocked", note: "checked, still the 1st", parkedUntil });
      expect(cap.status).toBe(200);
      expect(cause(wi.id)).toEqual({ parkedUntil });
      const note = store.listWorkItemEvents(wi.id).at(-1);
      expect(note).toMatchObject({ kind: "note", toStatus: "blocked", actor: "operator" });
      expect(note?.detail).toMatchObject({ note: "checked, still the 1st" });
    });
  });
});
