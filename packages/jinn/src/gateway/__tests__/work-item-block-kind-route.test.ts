import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

/* ICI-730: the kind decides where a block lands, so the route is where an
 * unrecognized one has to stop — a silent fallback would route work somewhere
 * its caller did not choose. */
describe("POST /api/work-items/:id/status — blockKind", () => {
  const session = () => reg.createSession({ engine: "codex", source: "web", sourceRef: `block-kind-${Math.random()}` });

  async function block(itemId: string, blockKind?: string) {
    const cap = makeRes();
    const body = { status: "blocked", note: "waiting on the other thing", ...(blockKind ? { blockKind } : {}) };
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${itemId}/status`, body, toolHeaders(session().id)),
      cap.res,
      ctx,
    );
    return cap;
  }

  const item = (title: string, assignee: string | null = "platform-worker") =>
    store.createWorkItem({ title, status: "executing", ...(assignee ? { assignee } : {}) });

  it.each(["needs_input", "capability", "transient"] as const)("accepts %s and parks the Todo", async (kind) => {
    const cap = await block(item(`block ${kind}`).id, kind);
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
  });

  it("accepts dependency and puts the Todo back in its queue instead, owned or not", async () => {
    const owned = await block(item("dependency owned").id, "dependency");
    expect([owned.status, owned.body.workItem?.status, owned.body.workItem?.assignee]).toEqual([200, "backlog", "platform-worker"]);

    const unowned = await block(item("dependency unowned", null).id, "dependency");
    expect([unowned.status, unowned.body.workItem?.status]).toEqual([200, "backlog"]);
  });

  it("rejects an unrecognized kind with a 400 and leaves the Todo where it was", async () => {
    const wi = item("bad kind");
    const cap = await block(wi.id, "waiting");

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/blockKind must be one of dependency, needs_input, capability, transient/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it("reads a kind-less block as needs_input — a human, never the queue", async () => {
    const cap = await block(item("no kind").id);
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
  });
});
