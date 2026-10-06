import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { armHeartbeat } from "../../heartbeats/store.js";
import { insertMessage } from "../../sessions/registry.js";
import { sessionOf } from "./department-scope-harness.js";
import type { CaseBuilder, Fx, Req } from "./department-scope-matrix-cases.js";

/** The session, org, department, Notes and pass-through rows of the scoped-caller table. */

/** A per-session row: a session outside D is refused as one that does not exist. */
const onSession = (method: string, suffix: string, allowStatus: number | "open", body?: unknown, other?: (fx: Fx) => Promise<string>): CaseBuilder => async (fx) => {
  const own = other ? await other(fx) : fx.peer.id;
  const unknown = randomUUID();
  const at = (id: string): Req => [method, `/api/sessions/${id}${suffix}`, body];
  return { allow: at(own), allowStatus, refuse: { kind: "unknown", req: at(fx.coo.id), like: at(unknown), ids: [fx.coo.id, unknown] } };
};

const context: CaseBuilder = async (fx) => {
  const message = insertMessage(fx.peer.id, "user", "anchor");
  const unknown = randomUUID();
  const at = (id: string): Req => ["GET", `/api/sessions/${id}/context?message=${message}`];
  return { allow: at(fx.peer.id), allowStatus: 200, refuse: { kind: "unknown", req: at(fx.coo.id), like: at(unknown), ids: [fx.coo.id, unknown] } };
};

const stop: CaseBuilder = async (fx) => {
  const child = await sessionOf("side-qa", { parentSessionId: fx.self.id });
  const unknown = randomUUID();
  const at = (id: string): Req => ["POST", `/api/sessions/${id}/stop`, {}];
  return { allow: at(child.id), allowStatus: 200, refuse: { kind: "unknown", req: at(fx.coo.id), like: at(unknown), ids: [fx.coo.id, unknown] } };
};

const searchMessages: CaseBuilder = (fx) => {
  const own = `zebrafish-${randomUUID().slice(0, 8)}`;
  const theirs = `zebrafish-${randomUUID().slice(0, 8)}`;
  insertMessage(fx.peer.id, "user", `in D ${own}`);
  insertMessage(fx.eng.id, "user", `outside ${theirs}`);
  const none = (body: any) => expect(body.results).toEqual([]);
  return { allow: ["GET", `/api/search/messages?q=${own}`], allowStatus: 200, refuse: { kind: "narrowed", req: ["GET", `/api/search/messages?q=${theirs}`], check: none } };
};

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

const heartbeatList: CaseBuilder = (fx) => {
  armHeartbeat({ ownerSessionId: fx.coo.id, message: "tick", everySeconds: 600 });
  return { allow: ["GET", "/api/heartbeats"], allowStatus: 200, refuse: { kind: "narrowed", req: ["GET", "/api/heartbeats"], check: (body) => expect(body.heartbeats).toEqual([]) } };
};

const heartbeatStop: CaseBuilder = (fx) => {
  const own = armHeartbeat({ ownerSessionId: fx.self.id, message: "mine", everySeconds: 600 });
  const theirs = armHeartbeat({ ownerSessionId: fx.coo.id, message: "theirs", everySeconds: 600 });
  const unknown = "hb_nosuchbeat";
  const at = (id: string): Req => ["DELETE", `/api/heartbeats/${id}`];
  return { allow: at(own.id), allowStatus: 200, refuse: { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown] } };
};

const refusedSibling = (path: string, reason: RegExp, method = "GET") => ({ kind: "forbidden" as const, req: [method, path] as Req, reason });

export const SESSION_CASES: Record<string, CaseBuilder> = {
  "POST /api/delegations": (fx) => {
    const theirs = fx.theirs();
    const at = (id: string): Req => ["POST", "/api/delegations", { employee: "side-qa", task: "do it", title: "do it", workItemId: id }];
    const unknown = theirs.id.replace(/\d+$/, "99999");
    return {
      allow: ["POST", "/api/delegations", { employee: "side-qa", task: "do it", title: "do it" }],
      allowStatus: 201,
      refuse: [
        { kind: "forbidden", req: ["POST", "/api/delegations", { employee: "eng-dev", task: "x", title: "x" }], reason: /eng-dev is not a member of department "side-project"/ },
        { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown] },
      ],
    };
  },
  "POST /api/sessions": () => ({
    allow: ["POST", "/api/sessions", { employee: "side-qa", prompt: "go" }],
    allowStatus: 201,
    refuse: { kind: "forbidden", req: ["POST", "/api/sessions", { employee: "eng-dev", prompt: "go" }], reason: /eng-dev is not a member of department "side-project"/ },
  }),
  "GET /api/sessions": (fx) => ({
    allow: ["GET", "/api/sessions?limit=0"],
    allowStatus: 200,
    refuse: { kind: "narrowed", req: ["GET", "/api/sessions?limit=0"], check: (body) => expect(ids(body)).not.toContain(fx.coo.id) },
  }),
  "GET /api/search/sessions": (fx) => ({
    allow: ["GET", "/api/search/sessions?employee=side-qa"],
    allowStatus: 200,
    refuse: { kind: "narrowed", req: ["GET", "/api/search/sessions?employee=eng-dev"], check: (body) => expect(ids(body.sessions)).not.toContain(fx.eng.id) },
  }),
  "GET /api/search/messages": searchMessages,
  "GET /api/sessions/:id": onSession("GET", "", 200),
  "GET /api/sessions/:id/messages": onSession("GET", "/messages", 200),
  "GET /api/sessions/:id/transcript": onSession("GET", "/transcript", 200),
  "GET /api/sessions/:id/context": context,
  "POST /api/sessions/:id/stop": stop,
  "GET /api/sessions/:id/children": onSession("GET", "/children", 200, undefined, async (fx) => fx.self.id),
  "POST /api/sessions/:id/message": onSession("POST", "/message", 200, { message: "hello" }),
  "POST /api/sessions/:id/attachments": (fx) => ({
    allow: ["POST", `/api/sessions/${fx.self.id}/attachments`, {}],
    allowStatus: "open",
    refuse: { kind: "forbidden", req: ["POST", `/api/sessions/${fx.peer.id}/attachments`, {}], reason: /only to its own session/ },
  }),
  "GET /api/org": () => ({
    allow: ["GET", "/api/org"],
    allowStatus: 200,
    refuse: { kind: "narrowed", req: ["GET", "/api/org"], check: (body) => expect(body.employees.map((e: { name: string }) => e.name).sort()).toEqual(["side-dev", "side-qa"]) },
  }),
  "GET /api/org/employees/:name": () => ({
    allow: ["GET", "/api/org/employees/side-qa"],
    allowStatus: 200,
    refuse: { kind: "unknown", req: ["GET", "/api/org/employees/eng-dev"], like: ["GET", "/api/org/employees/nobody-here"], ids: ["eng-dev", "nobody-here"] },
  }),
  "GET /api/departments": () => ({
    allow: ["GET", "/api/departments"],
    allowStatus: 200,
    refuse: { kind: "narrowed", req: ["GET", "/api/departments"], check: (body) => expect(body.departments.map((d: { slug: string }) => d.slug)).toEqual(["side-project"]) },
  }),
  "GET /api/labels": () => ({ allow: ["GET", "/api/labels"], allowStatus: 200, refuse: refusedSibling("/api/labels", /label administration is outside department "side-project"/, "POST") }),
  "POST /api/compactions": (fx) => ({ allow: ["POST", "/api/compactions", {}], allowStatus: 400, refuse: refusedSibling(`/api/sessions/${fx.self.id}/reset`, /session administration is outside/, "POST") }),
  "* /api/heartbeats": heartbeatList,
  "* /api/heartbeats/:id": heartbeatStop,
  "GET /api/status": () => ({ allow: ["GET", "/api/status"], allowStatus: 200, refuse: refusedSibling("/api/config", /company configuration is outside/) }),
  "GET /api/features": () => ({ allow: ["GET", "/api/features"], allowStatus: 200, refuse: refusedSibling("/api/skills", /the skills API is outside/) }),
  "POST /api/internal/hook": () => ({ allow: ["POST", "/api/internal/hook", {}], allowStatus: "open", refuse: refusedSibling("/api/logs", /logs is outside/) }),
};
