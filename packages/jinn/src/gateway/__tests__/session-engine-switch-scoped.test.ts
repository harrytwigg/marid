import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, makeReq, makeRes, operatorHeaders, reg } from "./helpers/work-items-route-harness.js";
import type { JinnConfig } from "../../shared/types.js";

// The mid-chat engine switch (PATCH /api/sessions/:id) holds a department-scoped
// employee's session to the claude engine, the same as starting one does: the
// turn gate refuses every other engine, so a switch accepted here would strand
// the session. `platform-worker` is in the open department `platform`.

const config = {
  gateway: {},
  engines: {
    default: "claude",
    claude: { bin: process.execPath, model: "sonnet" },
    codex: { bin: process.execPath, model: "gpt-5.6-sol" },
  },
  sessions: {},
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as JinnConfig;

const ctx = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

let scope: typeof import("../../work-items/department-scope.js");
let labScope: "scoped" | "open" = "scoped";

beforeAll(async () => {
  scope = await import("../../work-items/department-scope.js");
  scope.setEmployeeDepartmentResolver((employee) => (employee === "lab-dev" ? "lab" : "platform"));
  scope.setDepartmentScopeResolver((department) => (department === "lab" ? labScope : "open"));
});

beforeEach(() => {
  labScope = "scoped";
});

afterAll(() => {
  scope.setEmployeeDepartmentResolver(null);
  scope.setDepartmentScopeResolver(null);
});

async function patch(id: string, body: unknown) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq("PATCH", `/api/sessions/${id}`, body, operatorHeaders), cap.res, ctx);
  return cap;
}

describe("switching a session's engine mid-chat", () => {
  it("refuses a scoped employee's switch to another engine and keeps the session on claude", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "scoped-switch", title: "scoped", employee: "lab-dev" });

    const res = await patch(session.id, { engine: "codex" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('department "lab"');
    expect(res.body.error).toContain("run only on the claude engine");
    expect(res.body.error).not.toContain("Name \"claude\" or no engine");
    expect(reg.getSession(session.id)?.engine).toBe("claude");
  });

  it("still refuses a session bound to its department once its employee is no longer scoped", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "scoped-bound", title: "bound", employee: "lab-dev" });
    expect(session.scopeDepartment).toBe("lab");
    labScope = "open";

    const res = await patch(session.id, { engine: "codex" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('department "lab"');
    expect(reg.getSession(session.id)?.engine).toBe("claude");
  });

  it("lets a scoped session stranded on another engine switch back to claude", async () => {
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "scoped-stranded", title: "stranded", employee: "lab-dev" });

    const res = await patch(session.id, { engine: "claude" });

    expect(res.status).toBe(200);
    expect(reg.getSession(session.id)?.engine).toBe("claude");
  });

  it("still takes a model change on a scoped session", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "scoped-model", title: "model", employee: "lab-dev" });

    const res = await patch(session.id, { model: "sonnet" });

    expect(res.status).toBe(200);
  });

  it("leaves an open employee's switch alone", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "open-switch", title: "open", employee: "platform-worker" });

    const res = await patch(session.id, { engine: "codex" });

    expect(res.status).toBe(200);
    expect(reg.getSession(session.id)?.engine).toBe("codex");
  });

  it("leaves a session with no employee alone", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "plain-switch", title: "plain" });

    const res = await patch(session.id, { engine: "codex" });

    expect(res.status).toBe(200);
    expect(reg.getSession(session.id)?.engine).toBe("codex");
  });
});
