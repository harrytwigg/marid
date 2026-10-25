import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { get, registry } from "./helpers/search-route-harness.js";

describe("/api/search/sessions: the waiting status", () => {
  it("finds only the sessions paused on a limit when asked for status=waiting", async () => {
    const paused = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:paused", employee: "jinn-dev", title: "Paused on a limit" });
    registry.updateSession(paused.id, { status: "waiting" });
    const running = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:running", employee: "jinn-dev", title: "Still running" });
    registry.updateSession(running.id, { status: "running" });

    const response = await get("/api/search/sessions?employee=jinn-dev&status=waiting");

    expect(response.status).toBe(200);
    expect(response.body.sessions.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([[paused.id, "waiting"]]);
  });

  it("refuses a status that is not one of the five", async () => {
    expect((await get("/api/search/sessions?employee=jinn-dev&status=zombie")).status).toBe(400);
  });
});
