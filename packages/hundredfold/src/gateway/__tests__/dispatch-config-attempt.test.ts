import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call, firstUserMessage, home, skillsDir, startRouteHarness, stopRouteHarness,
  type Registry, type WorkItems,
} from "./todo-route-harness.js";

/**
 * Where a Todo's dispatch preferences are READ: the two places a Todo
 * becomes a working session. The requested skills have to reach the prompt, and
 * the engine/model override has to beat both the request body and the
 * employee's own default.
 */

let registry: Registry;
let workItems: WorkItems;

beforeAll(async () => { ({ registry, workItems } = await startRouteHarness()); });
afterAll(stopRouteHarness);

describe("POST /api/work-items/:id/dispatch reads the Todo's dispatch config", () => {
  it("puts the requested skills in the prompt and runs on the overridden engine", async () => {
    const item = workItems.createWorkItem({ title: "dispatch with skills", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, {
      skills: ["dev-workflow", "browser-use"], engine: "claude", model: "sonnet",
    });

    const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

    expect(dispatched.status).toBe(201);
    const prompt = firstUserMessage(registry, dispatched.body.sessionId);
    expect(prompt).toContain("skills/dev-workflow/SKILL.md");
    expect(prompt).toContain("skills/browser-use/SKILL.md");
    // The Todo's own brief still follows the preamble.
    expect(prompt).toContain(`Dispatch Todo ${item.id}.`);
    expect(registry.getSession(dispatched.body.sessionId)).toMatchObject({ engine: "claude", model: "sonnet" });
  });

  it("refuses the dispatch when every requested skill has been uninstalled, and starts nothing", async () => {
    const item = workItems.createWorkItem({ title: "dispatch with vanished skills", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["browser-use"] });
    const sessionsBefore = registry.countSessions();

    fs.renameSync(path.join(skillsDir, "browser-use"), path.join(home, "vanished-browser-use"));
    try {
      const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

      expect(dispatched.status).toBe(409);
      expect(dispatched.body.error).toContain("browser-use");
      expect(registry.countSessions()).toBe(sessionsBefore);
    } finally {
      fs.renameSync(path.join(home, "vanished-browser-use"), path.join(skillsDir, "browser-use"));
    }
  });

  it("dispatches on the surviving skills when only some are gone", async () => {
    const item = workItems.createWorkItem({ title: "dispatch with one skill gone", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["dev-workflow", "browser-use"] });

    fs.renameSync(path.join(skillsDir, "browser-use"), path.join(home, "partly-gone-browser-use"));
    try {
      const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

      expect(dispatched.status).toBe(201);
      const prompt = firstUserMessage(registry, dispatched.body.sessionId);
      expect(prompt).toContain("skills/dev-workflow/SKILL.md");
      expect(prompt).not.toContain("browser-use");
    } finally {
      fs.renameSync(path.join(home, "partly-gone-browser-use"), path.join(skillsDir, "browser-use"));
    }
  });
});

describe("POST /api/delegations reads the Todo's dispatch config", () => {
  it("runs the delegate on the Todo's engine, beating the employee's configured default", async () => {
    const item = workItems.createWorkItem({ title: "delegate over employee default", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "opus" });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    // route-worker's YAML says codex/gpt-5.6-sol; the Todo's override wins.
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("beats an engine named in the request body too — that is the recovery lever", async () => {
    const item = workItems.createWorkItem({ title: "delegate over request body", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "opus" });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", engine: "codex", model: "gpt-5.5", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("prefixes the delegate's brief with the Todo's skills, leaving the brief itself intact", async () => {
    const item = workItems.createWorkItem({ title: "delegate with skills", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["dev-workflow"] });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    const prompt = firstUserMessage(registry, delegated.body.sessionId);
    expect(prompt).toContain("skills/dev-workflow/SKILL.md");
    expect(prompt).toContain("Do the bounded work.");
  });

  it("leaves a delegation with no Todo override on the employee's own engine", async () => {
    const item = workItems.createWorkItem({ title: "delegate untouched", source: "human" });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
  });
});
