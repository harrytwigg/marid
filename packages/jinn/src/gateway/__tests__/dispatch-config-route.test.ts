import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * Where a Todo's dispatch preferences are SET: what the route accepts,
 * what it refuses by name, and the one that matters most — that setting an
 * override on an `executing` Todo redirects the NEXT attempt without reaching
 * into the session already running.
 */

let registry: Registry;
let workItems: WorkItems;

beforeAll(async () => { ({ registry, workItems } = await startRouteHarness()); });
afterAll(stopRouteHarness);

describe("PUT /api/work-items/:id/dispatch-config", () => {
  it("rejects an unknown skill by name and writes nothing", async () => {
    const item = workItems.createWorkItem({ title: "unknown skill via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["nope-not-installed"] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("nope-not-installed");
    const read = await call("GET", `/api/work-items/${item.id}`);
    expect(read.body.dispatchConfig).toBeNull();
  });

  it("rejects an MCP tool id with a message that distinguishes skills from tools", async () => {
    const item = workItems.createWorkItem({ title: "tool id via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["mcp__jinn__get_work_item"] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/MCP tool/i);
    expect(response.body.error).toContain("SKILL.md");
  });

  it("rejects an engine override whose model that engine does not know", async () => {
    const item = workItems.createWorkItem({ title: "bad model via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "gpt-5.6-sol" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("gpt-5.6-sol");
  });

  it("persists a valid config and returns it on the Todo", async () => {
    const item = workItems.createWorkItem({ title: "valid config via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, {
      skills: ["dev-workflow"], engine: "claude", model: "sonnet",
    });

    expect(response.status).toBe(200);
    const read = await call("GET", `/api/work-items/${item.id}`);
    expect(read.body.dispatchConfig).toMatchObject({ skills: ["dev-workflow"], engine: "claude", model: "sonnet" });
  });

  it("is accepted while the Todo is executing, and leaves the session already running it alone", async () => {
    const item = workItems.createWorkItem({ title: "executing config", source: "human" });
    const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
    expect(dispatched.status).toBe(201);
    const sessionId: string = dispatched.body.sessionId;
    // The Dispatcher runs on the configured default, so claude/opus below is a
    // genuine move rather than a restatement of what the session already is.
    expect(registry.getSession(sessionId)).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
    expect(workItems.getWorkItem(item.id)?.status).toBe("executing");

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "opus" });

    expect(response.status).toBe(200);
    // The attempt in flight keeps the engine it was started on: the override is
    // read at the NEXT dispatch and never pushed into a live session.
    expect(registry.getSession(sessionId)).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
    expect(workItems.getWorkItem(item.id)?.status).toBe("executing");
    const read = await call("GET", `/api/work-items/${item.id}`);
    expect(read.body.dispatchConfig).toMatchObject({ engine: "claude", model: "opus" });
  });
});
