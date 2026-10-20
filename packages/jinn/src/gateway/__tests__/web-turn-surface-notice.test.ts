import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

// Isolate the DB: JINN_HOME must be set before importing the registry.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-web-notice-"));
const reg = await import("../../sessions/registry.js");
const { createWebTurnSurface } = await import("../web-turn-surface.js");

describe("web turn surface notices", () => {
  it("are kept in the transcript and pushed to the live chat at once", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:notice" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: ((event: string, payload: unknown) => { emitted.push({ event, payload }); }) as never,
      connectors: new Map(),
      getConfig: () => ({}) as JinnConfig,
    });

    await surface.notice("🗜️ Context compacted.");

    expect(reg.getMessages(session.id).map((m) => [m.role, m.content])).toEqual([["notification", "🗜️ Context compacted."]]);
    expect(emitted).toEqual([{ event: "session:notification", payload: { sessionId: session.id, message: "🗜️ Context compacted." } }]);
  });

  it("carry a fallback hop's record in the stored message and the live event", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:notice-hop" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: ((event: string, payload: unknown) => { emitted.push({ event, payload }); }) as never,
      connectors: new Map(),
      getConfig: () => ({}) as JinnConfig,
    });
    const hop = { at: "2026-10-19T10:00:00.000Z", from: "a", to: "b", fromLabel: "claude · work", toLabel: "claude · spare", reason: "rate-limit" };

    await surface.notice("⚠️ claude · work hit its usage limit. Moving to claude · spare.", { fallbackHop: hop });

    expect(reg.getMessages(session.id).map((m) => [m.role, m.content, m.meta])).toEqual([["notification", "⚠️ claude · work hit its usage limit. Moving to claude · spare.", { fallbackHop: hop }]]);
    expect(emitted).toEqual([{ event: "session:notification", payload: { sessionId: session.id, message: "⚠️ claude · work hit its usage limit. Moving to claude · spare.", meta: { fallbackHop: hop } } }]);
  });
});
