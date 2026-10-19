import { describe, expect, it } from "vitest";
import { effectivePosition, nextFallbackLink } from "../fallback-chain-next.js";
import type { ResolvedFallbackLink } from "../fallback-chain-wire.js";

/** Which link a limit moves a session to next: untried, usable, healthy; then, failing that, healthy or not. */

const HOUR = 3600_000;
const now = new Date("2026-10-19T10:00:00.000Z");
const spent = { state: "exhausted" as const, until: new Date(now.getTime() + HOUR).toISOString() };

function link(engine: string, extra: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink {
  return { engine, key: `${engine}||`, account: engine, label: engine, origin: "config", ...extra };
}

const own = link("claude");
const chain = [own, link("codex"), link("grok"), link("pi")];

describe("nextFallbackLink", () => {
  it("is the first link after the own target when no run has started", () => {
    expect(nextFallbackLink(chain, { position: 0, tried: [own.key] }, {}, now)).toMatchObject({ index: 1, skipped: [] });
  });

  it("goes on from where the run stands and never to a link already tried", () => {
    const next = nextFallbackLink(chain, { position: 1, tried: [own.key, "codex||"] }, {}, now);
    expect(next?.link.engine).toBe("grok");
    // A tried link ahead of the cursor is passed over, and named.
    const past = nextFallbackLink(chain, { position: 1, tried: [own.key, "codex||", "grok||"] }, {}, now);
    expect(past).toMatchObject({ index: 3, skipped: [{ key: "grok||", reason: "tried" }] });
  });

  it("passes over a link ruled out for the session, with the reason", () => {
    const links = [own, link("codex", { skip: "scoped" }), link("grok", { skip: "not-installed" }), link("pi")];
    expect(nextFallbackLink(links, { position: 0, tried: [own.key] }, {}, now)).toMatchObject({
      index: 3, skipped: [{ key: "codex||", reason: "scoped" }, { key: "grok||", reason: "not-installed" }],
    });
  });

  it("takes a healthy link before one at its limit, and says it passed the spent one", () => {
    expect(nextFallbackLink(chain, { position: 0, tried: [own.key] }, { codex: spent }, now)).toMatchObject({
      index: 2, skipped: [{ key: "codex||", reason: "exhausted" }],
    });
  });

  it("reads a Claude link's health under its account, an opencode model's under its provider, and the engine-wide key too", () => {
    const links = [own, link("claude", { key: "claude|B|", account: "claude:abc", profile: "B" }), link("opencode", { key: "opencode||x/m", account: "opencode", model: "x/m" }), link("opencode", { key: "opencode||y/m", account: "opencode", model: "y/m" })];
    expect(nextFallbackLink(links, { position: 0, tried: [own.key] }, { "claude:abc": spent, "opencode/x": spent }, now)?.link.key).toBe("opencode||y/m");
    expect(nextFallbackLink(links, { position: 0, tried: [own.key] }, { claude: spent }, now)?.link.key).toBe("claude|B|");
    expect(nextFallbackLink(links, { position: 0, tried: [own.key] }, { opencode: spent, "claude:abc": spent }, now)).toMatchObject({ link: { key: "claude|B|" } });
  });

  it("falls back to a second pass that ignores health only when nothing healthy is left", () => {
    const everyoneSpent = { codex: spent, grok: spent, pi: spent };
    expect(nextFallbackLink(chain, { position: 0, tried: [own.key] }, everyoneSpent, now)?.link.engine).toBe("codex");
    // Health never overrides the rest: a tried link and a ruled-out link stay out.
    const links = [own, link("codex", { skip: "remote" }), link("grok"), link("pi")];
    expect(nextFallbackLink(links, { position: 2, tried: [own.key, "grok||"] }, everyoneSpent, now)?.link.engine).toBe("pi");
  });

  it("comes back for a link it passed over for its health before the run counts as run out", () => {
    // B was at its limit, so the walk went from A to x and then y; with y limited too, B is still untried.
    const links = [own, link("codex"), link("grok"), link("pi")];
    const health = { codex: spent };
    const first = nextFallbackLink(links, { position: 0, tried: [own.key] }, health, now);
    expect(first).toMatchObject({ index: 2, skipped: [{ key: "codex||", reason: "exhausted" }] });
    const second = nextFallbackLink(links, { position: 2, tried: [own.key, "grok||"] }, health, now);
    expect(second?.link.engine).toBe("pi");
    const third = nextFallbackLink(links, { position: 3, tried: [own.key, "grok||", "pi||"] }, health, now);
    expect(third).toMatchObject({ index: 1, link: { engine: "codex" } });
    // And once it has been tried there is nothing left.
    expect(nextFallbackLink(links, { position: 1, tried: [own.key, "grok||", "pi||", "codex||"] }, health, now)).toBeUndefined();
  });

  it("never comes back for a link ruled out for the session, behind the cursor or not", () => {
    const links = [own, link("codex", { skip: "scoped" }), link("grok")];
    expect(nextFallbackLink(links, { position: 2, tried: [own.key, "grok||"] }, {}, now)).toBeUndefined();
  });

  it("is undefined when every link is tried or ruled out", () => {
    expect(nextFallbackLink(chain, { position: 0, tried: [own.key, "codex||", "grok||", "pi||"] }, {}, now)).toBeUndefined();
    expect(nextFallbackLink([own], { position: 0, tried: [own.key] }, {}, now)).toBeUndefined();
  });

  it("treats a record past its re-probe time as healthy, as engine health does", () => {
    const reprobe = { codex: { ...spent, recheckAt: new Date(now.getTime() - 1000).toISOString() } };
    expect(nextFallbackLink(chain, { position: 0, tried: [own.key] }, reprobe, now)?.link.engine).toBe("codex");
  });
});

describe("effectivePosition", () => {
  it("is the own target without a run", () => {
    expect(effectivePosition(chain, undefined)).toBe(0);
  });

  it("is the recorded position, kept inside the chain", () => {
    expect(effectivePosition(chain, { position: 2, tried: [own.key] })).toBe(2);
    expect(effectivePosition(chain, { position: 40, tried: [] })).toBe(3);
    expect(effectivePosition(chain, { position: -3, tried: [] })).toBe(0);
  });

  it("never lies behind a target the run has tried, so an edited chain cannot send a run back", () => {
    expect(effectivePosition(chain, { position: 0, tried: [own.key, "grok||"] })).toBe(2);
  });

  it("keeps a recorded position on a tried link behind others: the walk went back to a link it had passed over", () => {
    expect(effectivePosition(chain, { position: 1, tried: [own.key, "grok||", "pi||", "codex||"] })).toBe(1);
  });
});
