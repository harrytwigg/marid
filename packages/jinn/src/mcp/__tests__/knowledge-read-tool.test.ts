import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildKnowledgeTools } from "../knowledge-tools.js";
import { ensureSessionCapability } from "../identity.js";
import { KNOWLEDGE_FILE_CHAR_CAP } from "../../shared/knowledge-read.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/**
 * read_knowledge's honesty about how much of a file it returned, split
 * out of knowledge-tools.test.ts, which owns the group registry and search. Same
 * two tiers as its neighbour: a stubbed gateway for the tool's own contract, then
 * the real route + store for the paging round-trip.
 */

process.env.JINN_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-read-home-"));

type Api = typeof import("../../gateway/api.js");
let api: Api;
let callerId: string;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-read-data-"));

/** What the read route sends for a slice of `content` starting at `offset`. */
function readBody(content: string, offset = 0, totalChars = offset + content.length) {
  return { path: "knowledge/a.md", title: "A", content, truncated: offset + content.length < totalChars, totalChars, returnedChars: content.length, offset };
}

interface SeenCall {
  url: string;
}

function stub(responder: () => { status: number; body: unknown }) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL) => {
    calls.push({ url: typeof input === "string" ? input : input.toString() });
    const { status, body } = responder();
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn, callerSessionId: "session-test", sessionCapability: "cap-test" };
  return { calls, ctx };
}

function tool(name: string): JinnMcpTool {
  const t = buildKnowledgeTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("read_knowledge — the cap is discoverable from the tool itself", () => {
  it("names the cap and offset in its description, from the constant so it cannot drift", () => {
    const description = tool("read_knowledge").description;
    expect(description).toContain(String(KNOWLEDGE_FILE_CHAR_CAP));
    expect(description).toMatch(/offset/);
  });
});

describe("read_knowledge — unit (stub gateway)", () => {
  it("a 200 whose body drifts shape fails loudly instead of reporting a clean empty read", async () => {
    // Both fields used to default toward "complete" — a body missing
    // `content` came back as truncated:false with content:"", which reads as a
    // whole file that happens to be empty. A caller cannot tell that apart from
    // the real thing, so the drift has to surface as an error.
    for (const missing of ["content", "truncated", "totalChars", "returnedChars", "offset"] as const) {
      const { [missing]: _dropped, ...drifted } = readBody("some text");
      const { ctx } = stub(() => ({ status: 200, body: drifted }));
      await expect(tool("read_knowledge").handler({ path: "knowledge/a.md" }, ctx)).rejects.toThrow(
        new RegExp(`malformed response: ${missing} is missing`),
      );
    }
  });

  it("read_knowledge reports how much was withheld and where the next slice starts", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: readBody("x".repeat(20), 0, 50) }));
    const out = (await tool("read_knowledge").handler({ path: "knowledge/a.md" }, ctx)) as {
      truncated: boolean;
      totalChars: number;
      returnedChars: number;
      offset: number;
      hint: string;
    };
    expect(out).toMatchObject({ truncated: true, totalChars: 50, returnedChars: 20, offset: 0 });
    expect(out.hint).toContain("offset: 20");
    expect(out.hint).toContain("30 chars left");
    expect(new URL(calls[0].url).searchParams.has("offset")).toBe(false);
  });

  it("read_knowledge forwards a positive offset to the route", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: readBody("tail", 20, 24) }));
    const out = (await tool("read_knowledge").handler({ path: "knowledge/a.md", offset: 20 }, ctx)) as { offset: number; truncated: boolean };
    expect(new URL(calls[0].url).searchParams.get("offset")).toBe("20");
    expect(out).toMatchObject({ offset: 20, truncated: false });
  });

  it("refuses a negative, fractional, or non-numeric offset BEFORE any HTTP call", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: readBody("ok") }));
    for (const bad of [-1, 1.5, "abc", "0", true, {}]) {
      await expect(tool("read_knowledge").handler({ path: "knowledge/a.md", offset: bad }, ctx)).rejects.toThrow(
        /offset must be a non-negative integer/,
      );
    }
    expect(calls).toHaveLength(0);
  });
});

/* ── Integration tier: real handleApiRequest + temp home via fetchFn seam ──── */

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  jinnHome: home,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const req = Object.assign(Readable.from([]), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers: { host: url.host, ...Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])) },
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(home, "knowledge", "q3-pricing.md"), "# Q3 pricing\n\nThe zebrafish plan ships at 29 euro.\n");
  api = await import("../../gateway/api.js");
  const registry = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
  callerId = registry.createSession({ engine: "codex", source: "web", sourceRef: "read-caller", employee: "read-caller" }).id;
});

describe("read_knowledge — integration against the real route/store", () => {
  const ctx = (): JinnMcpContext => ({
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId: callerId,
    sessionCapability: ensureSessionCapability(callerId),
  });

  it("pages an over-cap file through the real route back into the original file", async () => {
    const body = Array.from({ length: KNOWLEDGE_FILE_CHAR_CAP + 250 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    fs.writeFileSync(path.join(home, "knowledge", "over-cap.md"), body);
    const first = (await tool("read_knowledge").handler({ path: "knowledge/over-cap.md" }, ctx())) as {
      content: string;
      truncated: boolean;
      totalChars: number;
      returnedChars: number;
    };
    expect(first.truncated).toBe(true);
    expect(first.totalChars).toBe(body.length);
    expect(first.returnedChars).toBe(KNOWLEDGE_FILE_CHAR_CAP);

    const rest = (await tool("read_knowledge").handler(
      { path: "knowledge/over-cap.md", offset: first.returnedChars },
      ctx(),
    )) as { content: string; truncated: boolean; offset: number };
    expect(rest.offset).toBe(KNOWLEDGE_FILE_CHAR_CAP);
    expect(rest.truncated).toBe(false);
    expect(first.content + rest.content).toBe(body);
  });

  it("the real route refuses a bad offset with a 400 rather than a wrong slice", async () => {
    for (const bad of ["-1", "abc", "1.5"]) {
      const res = await apiFetch()(`http://gateway.test/api/knowledge/read?path=knowledge/q3-pricing.md&offset=${bad}`);
      expect(res.status, `offset=${bad}`).toBe(400);
      expect(await res.text()).toMatch(/offset must be a non-negative integer/);
    }
  });
});
