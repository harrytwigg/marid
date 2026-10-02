import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { buildWorkItemTools } from "../../mcp/work-item-tools.js";
import { CALLER_SESSION_CAPABILITY_HEADER } from "../../mcp/identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../../mcp/toolkit.js";

/**
 * Who may set which key of `verifyPolicy`, which is a different question from
 * whether a given policy is well formed — that one belongs to its sibling suite.
 *
 * `deliverable` says where the product lands and the Todo's own assignee or
 * creator may set it; `mode`, `verifier` and `maxRounds` say who reviews the
 * work and stay the operator's. Without the split the field was operator-only in
 * full, and since every bound MCP call arrives as a session, no lane could ever
 * declare its own route.
 */

function mcpTool(name: string): JinnMcpTool {
  const found = buildWorkItemTools().find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/**
 * The bound path an agent actually takes: MCP tool → gateway route, carrying the
 * tool's own identity headers. Only the socket is replaced, because the thing
 * under test is precisely what the route makes of that identity — a context that
 * answered for the route would prove nothing about who may declare a route.
 */
function boundMcpContext(sessionId: string): JinnMcpContext {
  const capability = toolHeaders(sessionId)[CALLER_SESSION_CAPABILITY_HEADER];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = makeRes();
    await api.handleApiRequest(
      makeReq(
        init?.method ?? "GET",
        `${url.pathname}${url.search}`,
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        init?.headers as Record<string, string>,
      ),
      res.res,
      ctx,
    );
    return { status: res.status, text: async () => JSON.stringify(res.body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    // Never dialed — fetchFn answers every request — and deliberately not a real
    // port, so nothing here can reach a live gateway.
    gatewayUrl: "http://gateway.invalid",
    fetchFn,
    callerSessionId: sessionId,
    sessionCapability: capability,
  } satisfies JinnMcpContext;
}

/** A Todo assigned to and created by `platform-worker`, so one session is both. */
async function workerTodo(sessionId: string, verifyPolicy?: Record<string, unknown>) {
  const created = makeRes();
  const body = { title: "Deliver a Note", ...(verifyPolicy ? { verifyPolicy } : {}) };
  await api.handleApiRequest(makeReq("POST", "/api/work-items", body, toolHeaders(sessionId)), created.res, ctx);
  expect(created.status).toBe(201);
  // Assignment is its own action now, so the route refuses `assignee` at create.
  // This suite is about the assignee/creator lane rather than about assignment,
  // so seed it at the store: that bumps `version` and leaves `status` alone.
  const seeded = store.updateWorkItem(created.body.workItem.id as string, { assignee: "platform-worker" });
  expect(seeded).toBeDefined();
  return { id: seeded!.id, version: seeded!.version };
}

async function patchPolicy(sessionId: string, item: { id: string; version: number }, verifyPolicy: unknown, headers = toolHeaders(sessionId)) {
  const res = makeRes();
  await api.handleApiRequest(
    makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, verifyPolicy }, headers),
    res.res,
    ctx,
  );
  return res;
}

describe("who may declare where a Todo's product lands", () => {
  it("lets the Todo's own assignee declare the workspace route, and reads it back", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "declaring-assignee", employee: "platform-worker" });
    const item = await workerTodo(caller.id, { mode: "verify" });

    const declared = await patchPolicy(caller.id, item, { mode: "verify", deliverable: "workspace" });
    expect(declared.status).toBe(200);

    const read = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`, undefined, toolHeaders(caller.id)), read.res, ctx);
    expect(read.status).toBe(200);
    expect(read.body.workItem.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });
  });

  it("holds a first declaration to the review mode the Todo already had", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "first-declaration", employee: "platform-worker" });
    const item = await workerTodo(caller.id);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toBeNull();

    // `session` provenance already means `verify`; declaring it changes nothing.
    const declared = await patchPolicy(caller.id, item, { mode: "verify", deliverable: "workspace" });
    expect(declared.status).toBe(200);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });
  });

  it("refuses a first declaration that would also choose the review mode", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "smuggled-mode", employee: "platform-worker" });
    const item = await workerTodo(caller.id);

    const refused = await patchPolicy(caller.id, item, { mode: "trust", deliverable: "workspace" });
    expect(refused.status).toBe(403);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toBeNull();
  });

  it("holds a session's create to the provenance default review mode, and lets the operator set anything", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "create-declaration", employee: "platform-worker" });
    const create = async (verifyPolicy: Record<string, unknown>, headers: Record<string, string>) => {
      const res = makeRes();
      await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Declared at create", verifyPolicy }, headers), res.res, ctx);
      return res;
    };

    for (const verifyPolicy of [
      { mode: "trust" },
      { mode: "verify", maxRounds: 9 },
      { mode: "verify", verifier: { employee: "solo-worker" } },
    ]) {
      expect((await create(verifyPolicy, toolHeaders(caller.id))).status).toBe(403);
    }
    // A deliverable-only declaration changes where the product lands, not who reviews it.
    expect((await create({ mode: "verify", deliverable: "workspace" }, toolHeaders(caller.id))).status).toBe(201);

    const operatorCreated = await create({ mode: "thorough", maxRounds: 4 }, operatorHeaders);
    expect(operatorCreated.status).toBe(201);
    expect(operatorCreated.body.workItem.verifyPolicy).toEqual({ mode: "thorough", maxRounds: 4 });
  });

  it("refuses that caller every key that decides who reviews the work", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "review-keys", employee: "platform-worker" });
    const item = await workerTodo(caller.id, { mode: "verify" });

    for (const verifyPolicy of [
      { mode: "thorough", deliverable: "workspace" },
      { mode: "verify", maxRounds: 9, deliverable: "workspace" },
      { mode: "verify", verifier: { employee: "solo-worker" }, deliverable: "workspace" },
    ]) {
      const refused = await patchPolicy(caller.id, item, verifyPolicy);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe(
        `field "verifyPolicy" is not editable by employee "platform-worker": only Todo ${item.id}'s assignee or creator may set verifyPolicy, and only its deliverable key — mode, verifier, and maxRounds are the operator's`,
      );
    }
    expect(store.getWorkItem(item.id)?.verifyPolicy).toEqual({ mode: "verify" });
  });

  it("refuses that caller a null policy, which would drop the review mode entirely", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "cleared-policy", employee: "platform-worker" });
    // A session cannot create a Todo under a non-default mode, so the operator
    // sets the `thorough` policy after the fact.
    const created = await workerTodo(caller.id, { mode: "verify" });
    const set = await patchPolicy(caller.id, created, { mode: "thorough" }, operatorHeaders);
    expect(set.status).toBe(200);
    const item = { id: created.id, version: set.body.workItem.version as number };

    const refused = await patchPolicy(caller.id, item, null);
    expect(refused.status).toBe(403);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toEqual({ mode: "thorough" });
  });

  it("refuses a session that is neither the Todo's assignee nor its creator", async () => {
    const owner = reg.createSession({ engine: "codex", source: "web", sourceRef: "route-owner", employee: "platform-worker" });
    const item = await workerTodo(owner.id, { mode: "verify" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "route-stranger", employee: "solo-worker" });

    const refused = await patchPolicy(stranger.id, item, { mode: "verify", deliverable: "workspace" });
    expect(refused.status).toBe(403);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toEqual({ mode: "verify" });
  });

  it("round-trips the declaration and the move through the bound MCP tool", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "bound-mcp-caller", employee: "platform-worker" });
    const item = await workerTodo(caller.id, { mode: "verify" });

    await mcpTool("update_work_item").handler(
      { id: item.id, status: "executing", verifyPolicy: { mode: "verify", deliverable: "workspace" } },
      boundMcpContext(caller.id),
    );

    const moved = store.getWorkItem(item.id);
    expect(moved?.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });
    expect(moved?.status).toBe("executing");
  });

  it("lets a session with no employee declare the route on the Todo it created", async () => {
    // Such a session is recorded as `session:<id>` and has no other name to be
    // known by, so keying the creator lane on the employee name alone shut it
    // out of a Todo it had created itself.
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "employee-less-creator" });
    const item = await workerTodo(caller.id, { mode: "verify" });
    expect(store.getWorkItem(item.id)?.createdBy).toBe(`session:${caller.id}`);

    const declared = await patchPolicy(caller.id, item, { mode: "verify", deliverable: "workspace" });
    expect(declared.status).toBe(200);

    const read = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`, undefined, toolHeaders(caller.id)), read.res, ctx);
    expect(read.status).toBe(200);
    expect(read.body.workItem.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });
  });

  it("reports the declaration it already wrote when the status move is refused", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "refused-status-move", employee: "platform-worker" });
    const item = await workerTodo(caller.id, { mode: "verify" });

    // Two writes: the declaration lands, the move does not. An error naming only
    // the refusal would leave the caller reading "nothing happened" over a Todo
    // whose policy had changed.
    await expect(mcpTool("update_work_item").handler(
      { id: item.id, status: "executing", asOperator: true, verifyPolicy: { mode: "verify", deliverable: "workspace" } },
      boundMcpContext(caller.id),
    )).rejects.toThrow(/the deliverable declaration was written and stands/);

    const after = store.getWorkItem(item.id);
    expect(after?.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });
    expect(after?.status).not.toBe("executing");
  });

  it("still lets the operator set every key", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "operator-sets-all", employee: "platform-worker" });
    const item = await workerTodo(caller.id, { mode: "verify" });

    const updated = await patchPolicy(caller.id, item, {
      mode: "thorough",
      maxRounds: 4,
      verifier: { employee: "solo-worker" },
      deliverable: "workspace",
    }, operatorHeaders);
    expect(updated.status).toBe(200);
    expect(store.getWorkItem(item.id)?.verifyPolicy).toEqual({
      mode: "thorough",
      maxRounds: 4,
      verifier: { employee: "solo-worker" },
      deliverable: "workspace",
    });
  });
});
