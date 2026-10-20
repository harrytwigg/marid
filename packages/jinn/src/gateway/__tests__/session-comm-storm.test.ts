import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  createSessionCommGuards,
  sessionCommGuards,
  LATERAL_MAX_HOPS,
  LATERAL_HOP_TTL_MS,
  PRUNE_EVERY_OPS,
} from "../session-comm-guards.js";
import { buildSessionTools } from "../../mcp/session-tools.js";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../../mcp/toolkit.js";

/**
 * GRS-017c — the STORM/ABUSE matrix: every substrate guard provably fires on
 * its exact trigger, as committed regressions. Two tiers:
 *
 *   UNIT (fake clock) — lazy pruning + stats, hop TTL expiry.
 *
 *   INTEGRATION (real routes + registry, temp JINN_HOME) — the adversarial
 *   scenarios a QA engine throws: a large fan-out (one sender → many peers)
 *   that is never refused, a 5-session relay chain dying on the hop budget,
 *   a spoofed-caller flood leaving ZERO guard state, and the descendant walk
 *   under a deep chain + a separate branch. (Two-peer ping-pong death and the
 *   operator hop-reset live in mcp/__tests__/session-tools.test.ts since 017a.)
 *
 * Restart-survival is deliberately NOT tested: guard state is argued
 * in-memory-only (module docstring — a restart kills the storm's actors; the
 * worst case is one fresh budget; durable guard state is an unearned primitive).
 */

// Isolated registry DB for the integration tier. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-storm-home-"));

/* ── UNIT: hop edge arithmetic ───────────────────────────────────────── */

describe("hop edges (fake clock)", () => {
  it("hop TTL expiry mid-chain resets the budget (stale relay tags don't strand a sender)", () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    g.recordDelivery("a", LATERAL_MAX_HOPS - 1);
    let v = g.checkSendAllowed("a");
    expect(v.ok && v.hops === LATERAL_MAX_HOPS).toBe(true);
    now += LATERAL_HOP_TTL_MS + 1;
    v = g.checkSendAllowed("a");
    expect(v.ok && v.hops === 1).toBe(true);
  });
});

describe("lazy pruning + stats (memory bound)", () => {
  it(`sweeps expired hop tags after ${PRUNE_EVERY_OPS} guard ops`, () => {
    let now = 0;
    const g = createSessionCommGuards(() => now);
    // 300 hop tags at t=0.
    for (let i = 0; i < 300; i++) {
      g.checkSendAllowed(`s-${i}`);
      g.recordDelivery(`t-${i}`, 1);
    }
    expect(g.stats().hopEntries).toBe(300);
    // Everything expires; the next PRUNE_EVERY_OPS ops trigger a sweep.
    now = LATERAL_HOP_TTL_MS + 1;
    for (let i = 0; i < PRUNE_EVERY_OPS; i++) g.checkSendAllowed("active");
    expect(g.stats().hopEntries).toBe(0);
  });
});

/* ── INTEGRATION: real routes + registry ────────────────────────────────────── */

type Api = typeof import("../api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;

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

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => engineStub, getQueue: () => queueStub },
} as unknown as import("../api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const headers: Record<string, string> = { host: url.host, authorization: "Bearer test-token" };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxFor(callerSessionId?: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: callerSessionId ? ensureSessionCapability(callerSessionId) : undefined,
  };
}

function tool(name: string): JinnMcpTool {
  const t = buildSessionTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function createOperatorSession(prompt: string): Promise<string> {
  const resp = await apiFetch()("http://gateway.test/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, engine: "codex" }),
  });
  expect(resp.status).toBe(201);
  return (JSON.parse(await resp.text()) as { id: string }).id;
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
});

beforeEach(() => {
  sessionCommGuards.reset();
  sessionCommGuards.setMaxHops(LATERAL_MAX_HOPS); // restore the default cap between tests
});

describe("storm matrix — integration against the real routes", () => {
  it("FAN-OUT: one sender messaging 40 distinct peers, then all of them again, is never refused", async () => {
    const sender = await createOperatorSession("fanout sender");
    const peers: string[] = [];
    for (let i = 0; i < 40; i++) peers.push(await createOperatorSession(`peer ${i}`));
    const ctx = ctxFor(sender);
    for (const round of ["notice", "follow-up"]) {
      for (let i = 0; i < peers.length; i++) {
        const res = (await tool("send_to_session").handler({ sessionId: peers[i], message: `${round} ${i}` }, ctx)) as {
          status: string;
        };
        expect(res.status).toBe("queued");
      }
    }
    expect(registry.getMessages(peers[39]).at(-1)!.content).toContain("follow-up 39");
  });

  it(`RELAY CHAIN A→B→C→D→E with the cap pinned to 4: delivery to E carries hop 4/4; E's forward attempt is refused`, async () => {
    // The default cap is now 12; pin it to 4 here so a compact 5-session chain
    // still exercises the refusal-at-cap + hop-tag path.
    sessionCommGuards.setMaxHops(4);
    const ids: string[] = [];
    for (const label of ["A", "B", "C", "D", "E"]) ids.push(await createOperatorSession(`relay ${label}`));
    const [a, b, c, d, e] = ids;
    await tool("send_to_session").handler({ sessionId: b, message: "relay this" }, ctxFor(a)); // hop 1
    await tool("send_to_session").handler({ sessionId: c, message: "relay this" }, ctxFor(b)); // hop 2
    await tool("send_to_session").handler({ sessionId: d, message: "relay this" }, ctxFor(c)); // hop 3
    await tool("send_to_session").handler({ sessionId: e, message: "relay this" }, ctxFor(d)); // hop 4
    const banner = registry.getMessages(e).at(-1)!;
    expect(banner.content).toContain(`hop 4/4`);
    await expect(tool("send_to_session").handler({ sessionId: a, message: "keep relaying" }, ctxFor(e))).rejects.toThrow(
      /400.*hop budget.*escalate/is,
    );
  });

  it(`RELAY CHAIN of 10 passes at the default cap of ${LATERAL_MAX_HOPS}, and the 13th hop is refused`, async () => {
    // 13 sessions so we can drive 12 deliveries (hops 1..12) then attempt a 13th.
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) ids.push(await createOperatorSession(`deepchain ${i}`));
    // Drive 12 hops: ids[0]→ids[1] (hop 1) … ids[11]→ids[12] (hop 12). Hop 10 passes.
    for (let i = 0; i < LATERAL_MAX_HOPS; i++) {
      const res = (await tool("send_to_session").handler(
        { sessionId: ids[i + 1], message: `relay ${i + 1}` },
        ctxFor(ids[i]),
      )) as { status: string };
      expect(res.status).toBe("queued");
    }
    // ids[12] received hop 12 (the cap); its own forward would be hop 13 → refused.
    const banner = registry.getMessages(ids[12]).at(-1)!;
    expect(banner.content).toContain(`hop ${LATERAL_MAX_HOPS}/${LATERAL_MAX_HOPS}`);
    await expect(
      tool("send_to_session").handler({ sessionId: ids[0], message: "hop 13" }, ctxFor(ids[12])),
    ).rejects.toThrow(/400.*hop budget.*escalate/is);
  });

  it("CONCURRENCY: 30 sends racing from one sender to one target are all admitted", async () => {
    const sender = await createOperatorSession("racer");
    const target = await createOperatorSession("race target");
    const ctx = ctxFor(sender);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => tool("send_to_session").handler({ sessionId: target, message: `race ${i}` }, ctx)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(30);
  });

  it("SPOOF FLOOD: unknown caller ids are refused 403 and leave ZERO guard state (memory-bound proof)", async () => {
    const target = await createOperatorSession("spoof target");
    const before = sessionCommGuards.stats();
    for (let i = 0; i < 25; i++) {
      await expect(
        tool("send_to_session").handler({ sessionId: target, message: "spoofed" }, ctxFor(`ghost-${i}`)),
      ).rejects.toThrow(/caller identity unavailable/i);
    }
    expect(sessionCommGuards.stats()).toEqual(before);
    expect(registry.getMessages(target).some((m) => m.content.includes("spoofed"))).toBe(false);
  });

  it("DESCENDANT WALK, deep + branched: root stops a depth-5 leaf; a cousin branch is refused; the walk is header-scoped only", async () => {
    const root = await createOperatorSession("deep root");
    // Build a spawn chain root → c1 → c2 → c3 → c4 → leaf via the real tool.
    let parent = root;
    let leaf = root;
    for (let depth = 1; depth <= 5; depth++) {
      const spawned = (await tool("spawn_session").handler({ prompt: `depth ${depth}`, engine: "codex" }, ctxFor(parent))) as {
        sessionId: string;
      };
      parent = spawned.sessionId;
      leaf = spawned.sessionId;
    }
    // A separate branch: another root with one child (the "cousin").
    const otherRoot = await createOperatorSession("other root");
    const cousin = (await tool("spawn_session").handler({ prompt: "cousin", engine: "codex" }, ctxFor(otherRoot))) as {
      sessionId: string;
    };

    const stopped = (await tool("stop_session").handler({ sessionId: leaf }, ctxFor(root))) as { action: string };
    expect(stopped.action).toBe("stopped");
    await expect(tool("stop_session").handler({ sessionId: cousin.sessionId }, ctxFor(root))).rejects.toThrow(/403.*descendant/is);
    // No header (operator/UI) → unrestricted, unchanged.
    const op = await apiFetch()(`http://gateway.test/api/sessions/${cousin.sessionId}/stop`, { method: "POST" });
    expect(op.status).toBe(200);
  });
});
