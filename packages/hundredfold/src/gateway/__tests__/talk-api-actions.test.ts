import { beforeEach, describe, expect, it } from "vitest";
import { baseConfig, call, stubMintingFetch } from "./helpers/talk-route-harness.js";
import type { HundredfoldConfig } from "../../shared/types.js";

let config: HundredfoldConfig;

beforeEach(() => {
  config = baseConfig();
  stubMintingFetch();
});

async function open(): Promise<string> {
  const res = await call(config, "POST", "/api/talk/sessions");
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function postAction(id: string, body: unknown) {
  return call(config, "POST", `/api/talk/sessions/${id}/actions`, body);
}

async function loggedActions(id: string): Promise<Array<Record<string, unknown>>> {
  const res = await call(config, "GET", `/api/talk/sessions/${id}`);
  return res.body.actions as Array<Record<string, unknown>>;
}

describe("talk action log", () => {
  it("logs a refusal, which wrote nothing but is still the decision that was made", async () => {
    const id = await open();
    const res = await postAction(id, {
      tool: "comment_work_item",
      subject: "ABC-123",
      lane: "consent",
      consent: "refused",
    });

    expect(res.status).toBe(201);
    expect(res.body.consent).toBe("refused");
    const logged = await loggedActions(id);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ tool: "comment_work_item", subject: "ABC-123", lane: "consent" });
  });

  it("logs a fast-lane write and its reversal, with the reversal naming the entry it undoes", async () => {
    const id = await open();
    const first = await postAction(id, {
      tool: "assign_work_item",
      subject: "ABC-123",
      lane: "fast",
      consent: "not-required",
    });
    expect(first.status).toBe(201);

    const undo = await postAction(id, {
      tool: "assign_work_item",
      subject: "ABC-123",
      lane: "fast",
      consent: "not-required",
      undoOf: first.body.id,
    });
    expect(undo.status).toBe(201);

    const logged = await loggedActions(id);
    expect(logged).toHaveLength(2);
    expect(logged[0]!.undoOf).toBeUndefined();
    expect(logged[1]!.undoOf).toBe(first.body.id);
  });

  it("accepts a null subject for a tool that acts on nothing in particular", async () => {
    const id = await open();
    const res = await postAction(id, { tool: "start_workflow_run", subject: null, lane: "consent", consent: "granted" });
    expect(res.status).toBe(201);
    expect(res.body.subject).toBeNull();
  });

  it("rejects a bad lane, a bad consent, a missing tool, and an undo of nothing, storing none of them", async () => {
    const id = await open();
    const good = { tool: "label_work_item", subject: "ABC-123", lane: "fast", consent: "not-required" };

    expect((await postAction(id, { ...good, lane: "quiet" })).status).toBe(400);
    expect((await postAction(id, { ...good, consent: "maybe" })).status).toBe(400);
    expect((await postAction(id, { ...good, tool: "  " })).status).toBe(400);
    expect((await postAction(id, { ...good, subject: 7 })).status).toBe(400);
    const orphan = await postAction(id, { ...good, undoOf: "an-id-this-session-never-issued" });
    expect(orphan.status).toBe(400);
    expect(orphan.body.error as string).toMatch(/undoOf/);

    expect(await loggedActions(id)).toEqual([]);
  });

  it("stamps id and at itself, so a client cannot backdate or collide an entry", async () => {
    const id = await open();
    const before = Date.now();
    const res = await postAction(id, {
      id: "client-chosen-id",
      at: 1,
      tool: "update_work_item",
      subject: "ABC-123",
      lane: "consent",
      consent: "granted",
    });

    expect(res.body.id).not.toBe("client-chosen-id");
    expect(res.body.at as number).toBeGreaterThanOrEqual(before);
  });

  it("reads a browser write back off the session it was logged against", async () => {
    const id = await open();
    // The body the browser actually sends: `talk-action-log.ts` posts exactly
    // these five fields, under a tool name from the web tool registry.
    const posted = await postAction(id, {
      tool: "talk_comment_todo",
      subject: "ABC-59",
      lane: "fast",
      consent: "not-required",
    });
    expect(posted.status).toBe(201);

    const logged = await loggedActions(id);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      id: posted.body.id,
      tool: "talk_comment_todo",
      subject: "ABC-59",
      lane: "fast",
      consent: "not-required",
    });
  });

  it("refuses an action on an unknown talk session rather than logging into nothing", async () => {
    const res = await postAction("not-a-session", {
      tool: "update_work_item",
      subject: "ABC-123",
      lane: "fast",
      consent: "not-required",
    });
    expect(res.status).toBe(404);
  });
});
