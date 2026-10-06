import { expect } from "vitest";
import type { WorkItem } from "../../work-items/store.js";
import { as } from "./department-scope-harness.js";
import { seedAttachment, seedComment, todoRoute, unknownOf, type CaseBuilder, type Req } from "./department-scope-matrix-cases.js";

/** The Todo rows of the scoped-caller table, keyed `${method} ${route}` as `SCOPED_ROUTES` has them. */

const empty = (field: string) => (body: any) => expect(field === "trees" ? body.trees : body[field]).toEqual(field === "trees" ? {} : []);

/** A list route: asked for a Todo in D it answers 200; asked for one outside, it answers an empty page. */
const list = (path: string, key: (item: WorkItem) => string, field: string): CaseBuilder => (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  return { allow: ["GET", `${path}${key(mine)}`], allowStatus: 200, refuse: { kind: "narrowed", req: ["GET", `${path}${key(theirs)}`], check: empty(field) } };
};

const withRelated: CaseBuilder = async (fx) => {
  const [mine, other, theirs] = [fx.mine(), fx.mine(), fx.theirs()];
  const at = (id: string): [string, string, unknown] => ["POST", `/api/work-items/${id}/relations`, { dstId: other.id, kind: "relates" }];
  return { allow: at(mine.id), allowStatus: 201, refuse: { kind: "unknown", req: at(theirs.id), like: at(unknownOf(theirs.id)), ids: [theirs.id, unknownOf(theirs.id)] } };
};

const unrelate: CaseBuilder = async (fx) => {
  const [mine, other, theirs] = [fx.mine(), fx.mine(), fx.theirs()];
  await as(fx.self.id)("POST", `/api/work-items/${mine.id}/relations`, { dstId: other.id, kind: "relates" });
  const at = (id: string): [string, string, unknown] => ["DELETE", `/api/work-items/${id}/relations`, { dstId: other.id, kind: "relates" }];
  return { allow: at(mine.id), allowStatus: 200, refuse: { kind: "unknown", req: at(theirs.id), like: at(unknownOf(theirs.id)), ids: [theirs.id, unknownOf(theirs.id)] } };
};

const comment: CaseBuilder = async (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const cid = await seedComment(fx, mine);
  const at = (id: string): [string, string, unknown] => ["PATCH", `/api/work-items/${id}/comments/${cid}`, { body: "edited" }];
  return { allow: at(mine.id), allowStatus: 200, refuse: { kind: "unknown", req: at(theirs.id), like: at(unknownOf(theirs.id)), ids: [theirs.id, unknownOf(theirs.id)] } };
};

const attachment: CaseBuilder = (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const own = seedAttachment(mine);
  const at = (id: string, aid: string): Req => ["DELETE", `/api/work-items/${id}/attachments/${aid}`];
  const aid = seedAttachment(theirs, "eng-dev");
  const unknown = unknownOf(theirs.id);
  return { allow: at(mine.id, own), allowStatus: 200, refuse: { kind: "unknown", req: at(theirs.id, aid), like: at(unknown, aid), ids: [theirs.id, unknown] } };
};

const upload: CaseBuilder = (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const at = (id: string): [string, string, unknown] => ["POST", `/api/work-items/${id}/attachments`, { path: fx.workdirFile }];
  const unknown = unknownOf(theirs.id);
  return { allow: at(mine.id), allowStatus: 201, refuse: { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown] } };
};

const assign: CaseBuilder = (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const at = (id: string): [string, string, unknown] => ["POST", `/api/work-items/${id}/assign`, { assignee: "side-qa" }];
  const unknown = unknownOf(theirs.id);
  return {
    allow: at(mine.id),
    allowStatus: 200,
    refuse: [
      { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown] },
      { kind: "forbidden", req: ["POST", `/api/work-items/${fx.mine().id}/assign`, { assignee: "eng-dev" }], reason: /eng-dev is not a member of department "side-project"/ },
    ],
  };
};

const dispatch: CaseBuilder = (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const at = (id: string): [string, string, unknown] => ["POST", `/api/work-items/${id}/dispatch`, {}];
  const unknown = unknownOf(theirs.id);
  return {
    allow: at(mine.id),
    allowStatus: 201,
    refuse: [
      { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown] },
      { kind: "forbidden", req: at(fx.mine("eng-dev").id), reason: /eng-dev is not a member of department "side-project"/ },
    ],
  };
};

const config = (method: "GET" | "PUT"): CaseBuilder => (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const body = (skills: string[]) => (method === "PUT" ? { skills } : undefined);
  const at = (id: string, skills: string[] = ["dev-workflow"]): [string, string, unknown] => [method, `/api/work-items/${id}/dispatch-config`, body(skills)];
  const unknown = unknownOf(theirs.id);
  return {
    // No GET handler exists for this path, so both answers are the route's own 404.
    allow: at(mine.id),
    allowStatus: method === "PUT" ? 200 : 404,
    refuse: [
      { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown] },
      ...(method === "PUT" ? [{ kind: "forbidden" as const, req: at(fx.mine().id, ["browser-use"]), reason: /skill\(s\) browser-use are not on department "side-project"'s skill allow-list/ }] : []),
    ],
  };
};

const created: CaseBuilder = (fx) => {
  const theirs = fx.theirs();
  const at = (parent: string): [string, string, unknown] => ["POST", "/api/work-items", { title: "child", parentId: parent }];
  const unknown = unknownOf(theirs.id);
  return {
    allow: ["POST", "/api/work-items", { title: "new in D", department: "engineering" }],
    allowStatus: 201,
    refuse: { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown], status: 400 },
  };
};

const patch: CaseBuilder = (fx) => {
  const [mine, theirs] = [fx.mine(), fx.theirs()];
  const at = (id: string): [string, string, unknown] => ["PATCH", `/api/work-items/${id}`, { title: "renamed", expectedVersion: 1 }];
  return { allow: ["PATCH", `/api/work-items/${mine.id}`, { title: "renamed", expectedVersion: mine.version }], allowStatus: 200, refuse: { kind: "unknown", req: at(theirs.id), like: at(unknownOf(theirs.id)), ids: [theirs.id, unknownOf(theirs.id)] } };
};

export const TODO_CASES: Record<string, CaseBuilder> = {
  "GET /api/work-items": list("/api/work-items?ids=", (item) => item.id, "workItems"),
  "GET /api/search/work-items": list("/api/search/work-items?q=", (item) => item.title, "workItems"),
  "GET /api/work-items/trees": list("/api/work-items/trees?ids=", (item) => item.id, "trees"),
  "POST /api/work-items": created,
  "GET /api/work-items/:id": todoRoute("GET", "", 200),
  "PATCH /api/work-items/:id": patch,
  "POST /api/work-items/:id/status": todoRoute("POST", "/status", 200, { status: "executing" }),
  "PUT /api/work-items/:id/status": todoRoute("PUT", "/status", 403, { status: "executing" }),
  "GET /api/work-items/:id/tree": todoRoute("GET", "/tree", 200),
  "* /api/work-items/:id/kept": todoRoute("PUT", "/kept", 403, { kept: true }),
  "* /api/work-items/:id/comments": todoRoute("GET", "/comments", 200),
  "* /api/work-items/:id/comments/:cid": comment,
  "* /api/work-items/:id/attachments/:aid": attachment,
  "PUT /api/work-items/:id/labels": todoRoute("PUT", "/labels", 200, { labels: [] }),
  "GET /api/work-items/:id/attachments": todoRoute("GET", "/attachments", 200),
  "POST /api/work-items/:id/attachments": upload,
  "POST /api/work-items/:id/relations": withRelated,
  "DELETE /api/work-items/:id/relations": unrelate,
  "GET /api/work-items/:id/sessions": todoRoute("GET", "/sessions", 200),
  "POST /api/work-items/:id/assign": assign,
  "POST /api/work-items/:id/dispatch": dispatch,
  "POST /api/work-items/:id/capture-landing": todoRoute("POST", "/capture-landing", 200, {}),
  "GET /api/work-items/:id/dispatch-config": config("GET"),
  "PUT /api/work-items/:id/dispatch-config": config("PUT"),
};
