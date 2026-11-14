import { describe, expect, it } from "vitest";
import {
  MAX_FALLBACK_HOPS, advanceRun, metaOf, readFallbackHops, readFallbackRun, servedBy, sessionAtOwnTarget, withHop, withRun, withServedBy, withoutRun,
} from "../fallback-run.js";
import type { FallbackHop } from "../../shared/fallback-chain-wire.js";
import { makeSession } from "./helpers/session-fixture.js";

const hop = (n: number): FallbackHop => ({ at: new Date(n * 1000).toISOString(), from: `f${n}`, to: `t${n}`, fromLabel: "f", toLabel: "t", reason: "rate-limit" });

describe("the persisted run state", () => {
  it("reads a well-formed run and nothing else", () => {
    const run = { source: "engine", position: 2, tried: ["a", "b"], startedAt: "2026-10-19T10:00:00.000Z" };
    expect(readFallbackRun({ fallbackRun: run })).toEqual(run);
    expect(readFallbackRun({ fallbackRun: { position: "2", tried: [] } })).toBeUndefined();
    expect(readFallbackRun({ fallbackRun: { position: 1 } })).toBeUndefined();
    expect(readFallbackRun({ fallbackRun: "nope" })).toBeUndefined();
    expect(readFallbackRun(null)).toBeUndefined();
    expect(readFallbackRun({ fallbackRun: { position: 1, tried: ["a", 4, null] } })?.tried).toEqual(["a"]);
  });

  it("starts a run with the own target tried, and adds each failed target with the position it lands on", () => {
    const now = new Date("2026-10-19T10:00:00.000Z");
    const first = advanceRun(undefined, { source: "employee", own: "own", failed: "own", position: 1, now });
    expect(first).toEqual({ source: "employee", position: 1, tried: ["own"], startedAt: now.toISOString() });
    const second = advanceRun(first, { source: "employee", own: "own", failed: "b", position: 2, now: new Date(now.getTime() + 5000) });
    expect(second).toEqual({ source: "employee", position: 2, tried: ["own", "b"], startedAt: now.toISOString() });
  });

  it("ends the run and keeps the hops", () => {
    const meta = withHop(withRun({}, { source: "engine", position: 1, tried: ["a"], startedAt: "x" }), hop(1));
    expect(withoutRun(meta)).toEqual({ fallbackHops: [hop(1)] });
  });
});

describe("hops", () => {
  it("are kept newest first and capped at 20", () => {
    let meta: Record<string, unknown> = {};
    for (let n = 1; n <= 25; n++) meta = withHop(meta, hop(n));
    const hops = readFallbackHops(meta);
    expect(hops).toHaveLength(MAX_FALLBACK_HOPS);
    expect(hops[0]).toEqual(hop(25));
    expect(hops.at(-1)).toEqual(hop(6));
  });

  it("read as absent when malformed", () => {
    expect(readFallbackHops({ fallbackHops: [hop(1), { at: 3 }, "x", null] })).toEqual([hop(1)]);
    expect(readFallbackHops({ fallbackHops: "no" })).toEqual([]);
  });
});

describe("served by", () => {
  it("names the target and when", () => {
    const at = new Date("2026-10-19T10:00:00.000Z");
    expect(withServedBy({}, servedBy({ key: "k", label: "claude" }, at))).toEqual({ fallbackServedBy: { key: "k", label: "claude", at: at.toISOString() } });
  });
});

describe("sessionAtOwnTarget", () => {
  it("is the session as it is when nothing stands in for it", () => {
    const session = makeSession();
    expect(sessionAtOwnTarget(session)).toBe(session);
  });

  it("restores the engine and pin a stand-in parked, without the override", () => {
    const standing = makeSession({ engine: "opencode", model: "y/m", transportMeta: { kept: 1, engineOverride: { originalEngine: "claude", originalModel: "opus", until: "2999-01-01T00:00:00Z" } } as never });
    const own = sessionAtOwnTarget(standing);
    expect(own).toMatchObject({ engine: "claude", model: "opus", transportMeta: { kept: 1 } });
    expect((own.transportMeta as Record<string, unknown>).engineOverride).toBeUndefined();
    // The row itself is left as it was.
    expect(standing.engine).toBe("opencode");
  });

  it("restores an unpinned session as unpinned", () => {
    const standing = makeSession({ engine: "codex", model: "gpt", transportMeta: { engineOverride: { originalEngine: "claude", originalModel: null, until: "2999-01-01T00:00:00Z" } } as never });
    expect(sessionAtOwnTarget(standing).model).toBeNull();
  });
});

describe("metaOf", () => {
  it("is a copy, and empty for a session with no meta", () => {
    expect(metaOf(makeSession({ transportMeta: null }))).toEqual({});
    const session = makeSession({ transportMeta: { a: 1 } as never });
    const copy = metaOf(session);
    copy.a = 2;
    expect((session.transportMeta as Record<string, unknown>).a).toBe(1);
  });
});
