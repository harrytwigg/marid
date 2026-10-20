import { describe, expect, it } from "vitest";
import {
  effortMatches,
  modelMatches,
  parseFreebuffScreen,
  parsePickerLabel,
  parsePickerRows,
  parseStatusBar,
  parseTokenCount,
} from "../freebuff-screen.js";
import { screen } from "./helpers/freebuff-fixtures.js";

describe("parseFreebuffScreen", () => {
  it("reads the panel before the first message starts a session", () => {
    const info = parseFreebuffScreen(screen("idle-before-session.txt"));
    expect(info.state).toBe("idle");
    expect(info.sessionNotStarted).toBe(true);
    expect(info.sessionActive).toBe(false);
    expect(info.hoursRemaining).toBe(21);
    expect(info.hoursTotal).toBe(21);
    expect(info.statusBar).toEqual({ modelLabel: "DeepSeek V4.1 Flash 10/17", effort: "high" });
  });

  it("reads an idle screen with a running session", () => {
    const info = parseFreebuffScreen(screen("idle-session-active.txt"));
    expect(info.state).toBe("idle");
    expect(info.sessionActive).toBe(true);
    expect(info.sessionNotStarted).toBe(false);
    expect(info.hoursRemaining).toBe(17);
    expect(info.sessionLeftMinutes).toBe(53);
    expect(info.turnFooter).toBe(false);
    expect(info.contextTokens).toBeUndefined();
  });

  it("reads a busy screen and the seconds it has run", () => {
    const info = parseFreebuffScreen(screen("busy.txt"));
    expect(info.state).toBe("busy");
    expect(info.busySeconds).toBe(5);
    expect(info.turnFooter).toBe(false);
    // The `working...` line sits where the session clock is drawn.
    expect(info.sessionLeftMinutes).toBeUndefined();
  });

  it("reads a finished turn: idle, the footer, session time and context", () => {
    const info = parseFreebuffScreen(screen("turn-finished.txt"));
    expect(info.state).toBe("idle");
    expect(info.turnFooter).toBe(true);
    expect(info.sessionLeftMinutes).toBe(60);
    expect(info.contextTokens).toBe(13_500);
    expect(info.contextPct).toBe(1);
  });

  it("reads the model picker, which leaves the idle status bar on screen", () => {
    for (const name of ["picker.txt", "picker-tab.txt", "picker-scrolled-with-ad.txt", "picker-after-turn.txt"]) {
      expect(parseFreebuffScreen(screen(name)).state, name).toBe("picker");
    }
  });

  it("recognises both sign-in screens and never mistakes them for idle", () => {
    expect(parseFreebuffScreen(screen("signed-out.txt")).state).toBe("signed-out");
    expect(parseFreebuffScreen(screen("signed-out-enter.txt")).state).toBe("signed-out");
  });

  it("calls anything else unknown", () => {
    expect(parseFreebuffScreen(["", "some modal nobody has seen"]).state).toBe("unknown");
    expect(parseFreebuffScreen([]).state).toBe("unknown");
  });

  it("parses session time forms", () => {
    const left = (line: string) => parseFreebuffScreen([line]).sessionLeftMinutes;
    expect(left(" 1h 1m left      ✕ End session")).toBe(61);
    expect(left(" 1h left · 13.5K (1%)")).toBe(60);
    expect(left(" 58m left · 13.5K (1%)")).toBe(58);
    expect(left(" 45s left")).toBe(0);
    expect(left("the work is not left")).toBeUndefined();
  });
});

describe("refusals", () => {
  // The CLI's own wording for the states that cannot be reached on demand, taken from
  // the 0.2.30 binary's strings rather than recorded: shown in the chat above the idle input.
  const withNotice = (notice: string) => ["", `  ${notice}`, ...screen("idle-session-active.txt")];
  const refusalOf = (notice: string) => parseFreebuffScreen(withNotice(notice)).refusal;

  it.each([
    ["no-hours", "Not enough hours: 0.4 available. See https://freebuff.com/plans or use /model."],
    ["session-limit", "Session limit reached. See https://freebuff.com/plans or choose another model with /model."],
    ["network-cap", "Too many Freebuff sessions on this network. Try again after another session finishes."],
    ["concurrent-limit", "Your concurrent-session limit across CLI and Desktop is reached. Take over to stop another session and use its slot here."],
    ["concurrent-limit", "Limited access without a subscription allows one session across CLI and Desktop. Take over to stop the other session and use it here."],
    ["unavailable", "Freebuff is unavailable in Nowhere. Use /byok to use your own API key."],
    ["released", "This session was released. Choose a model to start a new session."],
  ])("reads %s", (kind, notice) => {
    expect(refusalOf(notice)).toEqual({ kind, text: notice.split("\n")[0].trim() });
  });

  it("sees none on an ordinary screen", () => {
    for (const name of ["idle-session-active.txt", "busy.txt", "turn-finished.txt", "picker.txt", "signed-out.txt"]) {
      expect(parseFreebuffScreen(screen(name)).refusal, name).toBeUndefined();
    }
  });
});

describe("parseStatusBar", () => {
  it("splits the model from its reasoning level and ignores the cwd", () => {
    expect(parseStatusBar([" DeepSeek V4.1 Flash 10/17 • high · /tmp/x · /model to change · Chat: New chat"]))
      .toEqual({ modelLabel: "DeepSeek V4.1 Flash 10/17", effort: "high" });
  });

  it("has no effort for a model without one", () => {
    expect(parseStatusBar([" MiMo v2.6 Flash Slow · /tmp/x · /model to change · Chat: New chat"]))
      .toEqual({ modelLabel: "MiMo v2.6 Flash Slow" });
  });

  it("is undefined when the bar is not drawn", () => {
    expect(parseStatusBar(["nothing here"])).toBeUndefined();
  });
});

describe("parseTokenCount", () => {
  it("scales K and M", () => {
    expect(parseTokenCount("13.5", "K")).toBe(13_500);
    expect(parseTokenCount("1.2", "M")).toBe(1_200_000);
    expect(parseTokenCount("800", undefined)).toBe(800);
  });
});

describe("parsePickerRows", () => {
  it("reads every visible row with its cursor, effort and multiplier", () => {
    const rows = parsePickerRows(screen("picker.txt"));
    expect(rows.map((r) => r.label)).toEqual([
      "DeepSeek V4.1 Flash 10/17",
      "MiMo v2.6 Flash Slow",
      "MiMo v2.6 Flash Fast",
      "Muse Spark 1.3",
      "GLM 5.3 Flash",
      "GPT-6 Luna",
    ]);
    expect(rows.map((r) => r.effort)).toEqual(["high", undefined, undefined, "high", "high", "high"]);
    expect(rows.map((r) => r.multiplier)).toEqual([3, 1, 2, 3, 4, 4]);
    expect(rows.findIndex((r) => r.selected)).toBe(0);
  });

  it("follows the cursor, and a row that opens to show a description", () => {
    const rows = parsePickerRows(screen("picker-tab.txt"));
    expect(rows.findIndex((r) => r.selected)).toBe(1);
    expect(rows[1]).toMatchObject({ label: "MiMo v2.6 Flash Slow", multiplier: 1 });
  });

  it("reads the scrolled view: a label with a dot in it, a wrapped row, an ad above", () => {
    const rows = parsePickerRows(screen("picker-scrolled-with-ad.txt"));
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("Claude Haiku 5.5 · 100k context");
    expect(labels).toContain("Gemini 4 Argon");
    expect(labels.at(-1)).toBe("DeepSeek V4.1 Flash Fast 10/17");
    expect(rows.at(-1)).toMatchObject({ selected: true, effort: "high", multiplier: 5 });
    expect(rows.filter((r) => r.selected)).toHaveLength(1);
  });

  it("is empty when the picker is not open", () => {
    expect(parsePickerRows(screen("idle-session-active.txt"))).toEqual([]);
  });
});

describe("parsePickerLabel", () => {
  it("takes the effort after the bullet and the label before it", () => {
    expect(parsePickerLabel("› GLM 5.3 Flash • high · Deep reasoning · Images")).toEqual({ label: "GLM 5.3 Flash", effort: "high" });
    expect(parsePickerLabel("  MiMo 2.6 Pro · Strong reasoning · Images")).toEqual({ label: "MiMo 2.6 Pro" });
  });
});

describe("matching", () => {
  it("matches a model by case-insensitive prefix", () => {
    expect(modelMatches("MiMo v2.6 Flash Slow", "mimo v2.6 flash slow")).toBe(true);
    expect(modelMatches("MiMo v2.6 Flash Slow", "MiMo v2.6")).toBe(true);
    expect(modelMatches("MiMo v2.6 Flash Slow", "GLM")).toBe(false);
  });

  it("matches an effort exactly", () => {
    expect(effortMatches("High", "high")).toBe(true);
    expect(effortMatches(undefined, "high")).toBe(false);
    expect(effortMatches("highest", "high")).toBe(false);
  });
});
