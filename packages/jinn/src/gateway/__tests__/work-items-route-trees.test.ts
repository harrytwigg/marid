import { describe, it, expect } from "vitest";
import { TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";
import { api, ctx, makeReq, makeRes, operatorHeaders, store } from "./helpers/work-items-route-harness.js";

describe("GET /api/work-items — trees, batch reads, and filters", () => {
  it("GET /api/work-items/:id/tree reaches the tree handler (no :id route collision) and nests children", async () => {
    const root = store.createWorkItem({ title: "route tree root" });
    const child = store.createWorkItem({ title: "route tree child", parentId: root.id });
    store.createWorkItem({ title: "route tree grandchild", parentId: child.id });

    const treeRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${root.id}/tree`), treeRes.res, ctx);
    expect(treeRes.status).toBe(200);
    const tree = treeRes.body.tree;
    expect(tree.root.id).toBe(root.id);
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0].id).toBe(child.id);
    expect(tree.root.children[0].children).toHaveLength(1);
    expect(tree.totals.backlog).toBe(3);
    expect(tree.spendUsd).toBe(0);

    const missing = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items/ZZZ-424242/tree"), missing.res, ctx);
    expect(missing.status).toBe(404);
  });

  it("GET /api/work-items/trees returns root and leaf payloads equal to their single-tree responses and omits unknowns", async () => {
    const root = store.createWorkItem({ title: "batch route tree root" });
    const child = store.createWorkItem({ title: "batch route tree child", parentId: root.id });
    const leaf = store.createWorkItem({ title: "batch route tree leaf", parentId: child.id });
    const unknown = "ZZZ-424242";

    const rootRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${root.id}/tree`), rootRes.res, ctx);
    const leafRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${leaf.id}/tree`), leafRes.res, ctx);

    const batchRes = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items/trees?ids=${root.id},${leaf.id},${unknown}`),
      batchRes.res,
      ctx,
    );

    expect(batchRes.status).toBe(200);
    expect(batchRes.body).toEqual({
      trees: {
        [root.id]: rootRes.body.tree,
        [leaf.id]: leafRes.body.tree,
      },
    });
    expect(batchRes.body.trees).not.toHaveProperty(unknown);
  });

  it("GET /api/work-items?ids returns the open-detail subset from single-item payloads and omits unknowns", async () => {
    const first = store.createWorkItem({ title: "batch detail first" });
    const second = store.createWorkItem({ title: "batch detail second" });
    const unknown = "ZZZ-424242";

    const firstRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${first.id}`), firstRes.res, ctx);
    const secondRes = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${second.id}`), secondRes.res, ctx);

    const batchRes = makeRes();
    await api.handleApiRequest(
      makeReq("GET", `/api/work-items?ids=${first.id},${second.id},${unknown}`),
      batchRes.res,
      ctx,
    );

    expect(batchRes.status).toBe(200);
    expect(batchRes.body).toEqual({
      workItems: [
        {
          workItem: firstRes.body.workItem,
          events: firstRes.body.events,
          reviewAddressee: firstRes.body.reviewAddressee,
        },
        {
          workItem: secondRes.body.workItem,
          events: secondRes.body.events,
          reviewAddressee: secondRes.body.reviewAddressee,
        },
      ],
    });
  });

  it.each([
    ["GET /api/work-items/trees", (ids: string) => `/api/work-items/trees?ids=${ids}`],
    ["GET /api/work-items?ids", (ids: string) => `/api/work-items?ids=${ids}`],
  ] as const)("%s rejects more than 100 ids with a readable 400", async (_name, buildUrl) => {
    const ids = Array.from({ length: 101 }, (_, index) => `ZZZ-${index + 1}`);
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", buildUrl(ids.join(","))), cap.res, ctx);

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/ids.*at most 100/i);
  });

  it.each([
    ["tree", (id: string) => `/api/work-items/${id}/tree`, (id: string) => `/api/work-items/trees?ids=${id}`],
    ["detail", (id: string) => `/api/work-items/${id}`, (id: string) => `/api/work-items?ids=${id}`],
  ] as const)("the batch %s route has the same identified-caller auth guard as the single one", async (name, singleUrl, batchUrl) => {
    const item = store.createWorkItem({ title: `batch ${name} auth parity` });
    const unauthenticatedHeaders = { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE };

    const single = makeRes();
    await api.handleApiRequest(makeReq("GET", singleUrl(item.id), undefined, unauthenticatedHeaders), single.res, ctx);
    const batch = makeRes();
    await api.handleApiRequest(makeReq("GET", batchUrl(item.id), undefined, unauthenticatedHeaders), batch.res, ctx);

    expect(single.status).toBe(403);
    expect(batch.status).toBe(single.status);
    expect(batch.body).toEqual(single.body);
  });

  it("filters by createdBy/parent/root/rootsOnly and compact rows carry the five v2 fields", async () => {
    const root = store.createWorkItem({ title: "filter fixture root v2", createdBy: "operator" });
    const child = store.createWorkItem({ title: "filter fixture child v2", parentId: root.id, createdBy: "a-lead" });

    const roots = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?rootsOnly=true&createdBy=operator&q=filter+fixture"),
      roots.res,
      ctx,
    );
    expect(roots.status).toBe(200);
    expect(roots.body.workItems.map((w: { id: string }) => w.id)).toContain(root.id);
    for (const row of roots.body.workItems) {
      expect(row.parentId).toBeNull();
      expect(row).toHaveProperty("createdBy");
      expect(row).toHaveProperty("rootId");
      expect(row).toHaveProperty("depth");
      expect(row).toHaveProperty("dueAt");
    }

    const children = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?parent=${root.id}`), children.res, ctx);
    expect(children.status).toBe(200);
    expect(children.body.workItems.map((w: { id: string }) => w.id)).toEqual([child.id]);

    const family = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?root=${root.id}`), family.res, ctx);
    expect(family.status).toBe(200);
    expect(family.body.workItems.map((w: { id: string }) => w.id).sort()).toEqual([root.id, child.id].sort());

    const badParent = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?parent=garbage"), badParent.res, ctx);
    expect(badParent.status).toBe(400);
    expect(badParent.body.error).toMatch(/parent must be a Todo ID/);
  });

  it("operator archive with cascade cancels open descendants; without it the gate refuses", async () => {
    const parent = store.createWorkItem({ title: "cascade route parent" });
    const mid = store.createWorkItem({ title: "cascade route mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "cascade route leaf", parentId: mid.id });

    const refused = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${parent.id}/archive`, {}, operatorHeaders),
      refused.res,
      ctx,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(store.getWorkItem(parent.id)!.status).not.toBe("cancelled");

    const cascaded = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${parent.id}/archive`, { cascade: true }, operatorHeaders),
      cascaded.res,
      ctx,
    );
    expect(cascaded.status).toBe(200);
    expect(cascaded.body.workItem.status).toBe("cancelled");
    expect(store.getWorkItem(mid.id)!.status).toBe("cancelled");
    expect(store.getWorkItem(leaf.id)!.status).toBe("cancelled");
  });
});
