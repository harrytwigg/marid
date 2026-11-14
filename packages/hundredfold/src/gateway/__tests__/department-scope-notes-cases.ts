import { expect } from "vitest";
import type { CaseBuilder, Req } from "./department-scope-matrix-cases.js";

/** The knowledge and Notes rows: rooted at the department's folder, writes only under it. */

const paths = (rows: Array<{ path: string }>) => rows.map((row) => row.path);

export const NOTES_CASES: Record<string, CaseBuilder> = {
  "GET /api/knowledge/search": (fx) => ({
    allow: ["GET", "/api/knowledge/search?q=zebrafish"],
    allowStatus: 200,
    refuse: { kind: "narrowed", req: ["GET", "/api/knowledge/search?q=zebrafish"], check: (body) => expect(paths(body.results)).not.toContain(fx.companyNote.path) },
  }),
  "GET /api/knowledge/read": (fx) => {
    const at = (path: string): Req => ["GET", `/api/knowledge/read?path=${path}`];
    return {
      allow: at(fx.note.path.startsWith("knowledge/") ? fx.note.path : `knowledge/${fx.note.path}`),
      allowStatus: 200,
      refuse: { kind: "unknown", req: at("knowledge/state.md"), like: at("knowledge/no-such-file.md"), ids: ["knowledge/state.md", "knowledge/no-such-file.md"] },
    };
  },
  "GET /api/notes": (fx) => ({
    allow: ["GET", "/api/notes"],
    allowStatus: 200,
    refuse: { kind: "narrowed", req: ["GET", "/api/notes"], check: (body) => expect(paths(body.notes)).not.toContain(fx.companyNote.path) },
  }),
  "GET /api/notes/read": (fx) => {
    const at = (path: string): Req => ["GET", `/api/notes/read?path=${path}`];
    return {
      allow: at(fx.note.path),
      allowStatus: 200,
      refuse: { kind: "unknown", req: at(fx.companyNote.path), like: at("company/no-such-note.md"), ids: [fx.companyNote.path, "company/no-such-note.md"] },
    };
  },
  "POST /api/notes": () => ({
    allow: ["POST", "/api/notes", { title: "Created in D", body: "text" }],
    allowStatus: 201,
    refuse: { kind: "forbidden", req: ["POST", "/api/notes", { title: "Elsewhere", folder: "company" }], reason: /Notes are written only under knowledge\/departments\/side-project\// },
  }),
  "PUT /api/notes": (fx) => ({
    allow: ["PUT", "/api/notes", { path: fx.note.path, expectedRevision: fx.note.revision, append: "more" }],
    allowStatus: 200,
    refuse: { kind: "forbidden", req: ["PUT", "/api/notes", { path: fx.companyNote.path, expectedRevision: "0".repeat(64), append: "x" }], reason: /Notes are written only under knowledge\/departments\/side-project\// },
  }),
};
