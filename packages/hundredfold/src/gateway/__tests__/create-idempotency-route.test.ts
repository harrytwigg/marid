import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startRouteHarness, stopRouteHarness } from "./todo-route-harness.js";

/**
 * Create idempotency over the route, which is where the whole create
 * payload is visible — including the labels, which are applied after the row
 * and would otherwise fall outside what "the same create" means.
 */

beforeAll(async () => { await startRouteHarness(); });
afterAll(stopRouteHarness);

describe("POST /api/work-items with an idempotencyKey", () => {
  it("returns the same Todo for a repeated key, and a new one for a different key", async () => {
    const first = await call("POST", "/api/work-items", { title: "keyed create", idempotencyKey: "fire-1" });
    const replay = await call("POST", "/api/work-items", { title: "keyed create", idempotencyKey: "fire-1" });
    const other = await call("POST", "/api/work-items", { title: "keyed create", idempotencyKey: "fire-2" });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true });
    expect(replay.body.workItem.id).toBe(first.body.workItem.id);
    expect(other.body.workItem.id).not.toBe(first.body.workItem.id);
  });

  it("conflicts when the same key carries a different create", async () => {
    await call("POST", "/api/work-items", { title: "keyed original", idempotencyKey: "fire-3" });

    const conflict = await call("POST", "/api/work-items", { title: "keyed something else", idempotencyKey: "fire-3" });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("todo_create_idempotency_conflict");
  });

  it("conflicts on different labels under the same key, rather than replaying the first set", async () => {
    expect((await call("POST", "/api/labels", { name: "alpha" })).status).toBe(201);
    expect((await call("POST", "/api/labels", { name: "beta" })).status).toBe(201);
    const first = await call("POST", "/api/work-items", { title: "keyed labels", idempotencyKey: "fire-4", labels: ["alpha"] });
    expect(first.status).toBe(201);

    const conflict = await call("POST", "/api/work-items", { title: "keyed labels", idempotencyKey: "fire-4", labels: ["beta"] });

    // A replay keeps the first call's labels, so answering this with a 200 would
    // hand back a Todo tagged with something the caller never asked for.
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("todo_create_idempotency_conflict");
    const read = await call("GET", `/api/work-items/${first.body.workItem.id}`);
    expect(read.body.labels.map((label: { name: string }) => label.name)).toEqual(["alpha"]);
  });
});
