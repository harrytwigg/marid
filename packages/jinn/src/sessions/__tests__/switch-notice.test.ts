import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/** The transcript's record of a switch: the text for every `lastSwitch` shape, and the notice it travels in. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-switch-notice-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { switchNoticeText, recordSwitchNotice } = await import("../switch-notice.js");

const config = {
  gateway: {},
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, opencode: { bin: "opencode", model: "provider/x" } },
  models: { claude: { default: "opus", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] }, opencode: { default: "provider/x", models: [{ id: "provider/x", label: "X" }] } },
  connectors: {},
} as unknown as JinnConfig;

const own = { engine: "claude", profile: null, claudeConfigDir: null, model: "opus", effortLevel: null };
const work = { engine: "claude", profile: "work", claudeConfigDir: "/p/work", model: "sonnet", effortLevel: null };
const oc = { engine: "opencode", profile: null, claudeConfigDir: null, model: "provider/x", effortLevel: null };
const base = { at: "2026-11-12T10:00:00.000Z", by: "session" as const, from: own, to: work, applied: true };

describe("switchNoticeText", () => {
  it("says the operator changed it", () => {
    expect(switchNoticeText(config, { ...base, by: "operator", carryOver: "transcript-pointer" }))
      .toMatch(/^🔀 Switched from Claude · own login · Opus.* to Claude · work · Sonnet.* \(changed by the operator\)$/);
  });

  it("names the compaction summary as the carry-over", () => {
    expect(switchNoticeText(config, { ...base, carryOver: "summary" }))
      .toMatch(/\(requested by this session; carried over by compaction summary\)$/);
  });

  it("names a compaction in place", () => {
    expect(switchNoticeText(config, { ...base, carryOver: "same-conversation" }))
      .toMatch(/\(requested by this session; context compacted in place\)$/);
  });

  it.each([
    ["usage-limit", "usage limit"],
    ["error", "an error"],
    ["unconfirmed", "it could not be confirmed"],
    ["no-summary", "no summary was produced"],
    ["summary-too-long", "the summary was too long"],
    ["no-outcome", "it did not finish"],
  ])("says why a failed compaction (%s) fell back to the manual handover", (reason, phrase) => {
    expect(switchNoticeText(config, { ...base, carryOver: "manual-handover", reason }))
      .toMatch(new RegExp(`\\(requested by this session; the compaction failed \\(${phrase}\\), so the new conversation was told where to read the history\\)$`));
  });

  it("says an engine with no compaction has none, rather than that one failed", () => {
    const text = switchNoticeText(config, { ...base, to: oc, from: oc, carryOver: "manual-handover", reason: "not-supported" });
    expect(text).toMatch(/opencode has no compaction, so the new conversation was told where to read the history/);
    expect(text).not.toMatch(/failed/);
  });

  it("says a switch that did not happen, why, and where the session still is", () => {
    expect(switchNoticeText(config, { ...base, to: oc, applied: false, carryOver: "manual-handover", reason: "the engine is no longer installed" }))
      .toMatch(/^🔀 Switch to opencode · X did not happen: the engine is no longer installed\. Still on Claude · own login · Opus.*\.$/);
  });
});

describe("recordSwitchNotice", () => {
  it("inserts a notification carrying the record, and announces it", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:notice" });
    const emit = vi.fn();
    const last = { ...base, by: "operator" as const, carryOver: "transcript-pointer" as const };

    recordSwitchNotice(s.id, emit as never, config, last);

    const [message] = reg.getMessages(s.id);
    expect(message.role).toBe("notification");
    expect(message.content).toBe(switchNoticeText(config, last));
    expect(message.meta?.sessionSwitch).toEqual(last);
    expect(emit).toHaveBeenCalledWith("session:notification", { sessionId: s.id, message: message.content, meta: { sessionSwitch: last }, messageId: message.id });
  });

  it("keeps the notice in the transcript when the live announcement throws", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:notice-throws" });

    expect(() => recordSwitchNotice(s.id, (() => { throw new Error("socket closed"); }) as never, config, { ...base, carryOver: "summary" })).not.toThrow();

    expect(reg.getMessages(s.id)).toHaveLength(1);
  });
});
