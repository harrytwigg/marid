import { describe, expect, it } from "vitest";
import { screen } from "./helpers/freebuff-fixtures.js";
import { choiceSatisfied, chooseInPicker, FreebuffPickerError, type PickerIO, type PickerKey } from "../freebuff-picker.js";

interface SimRow { label: string; efforts?: string[]; effort?: number; multiplier: number }

/**
 * A stand-in for the `/model` picker: a list of boxed rows in a window that
 * scrolls with the cursor, drawn in the CLI's own box format.
 */
class SimPicker implements PickerIO {
  cursor = 0;
  top = 0;
  keys: PickerKey[] = [];
  constructor(readonly rows: SimRow[], readonly windowSize = 3) {}

  private render(): string[] {
    const lines = [" 53m left     ✕ End session", " ↑↓ choose model · Tab reasoning · Enter select · Esc cancel", " OPTIMIZED · Strongest price-to-performance models"];
    for (let i = this.top; i < Math.min(this.rows.length, this.top + this.windowSize); i++) {
      const r = this.rows[i];
      const effort = r.efforts ? ` • ${r.efforts[r.effort ?? 0]}` : "";
      lines.push(" ┌──────────────────────────────────────┐");
      lines.push(` │ ${i === this.cursor ? "›" : " "} ${r.label}${effort} · blurb`.padEnd(40) + "│");
      lines.push(` │ ${`${r.multiplier}x`}`.padEnd(40) + "│");
      lines.push(" └──────────────────────────────────────┘");
    }
    lines.push(" DeepSeek V4.1 Flash 10/17 • high · /tmp/x · /model to change · Chat: New chat");
    return lines;
  }

  async screen() { return this.render(); }
  async press(key: PickerKey) {
    this.keys.push(key);
    if (key === "down") this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
    if (key === "up") this.cursor = Math.max(0, this.cursor - 1);
    if (key === "tab") {
      const r = this.rows[this.cursor];
      if (r.efforts) r.effort = ((r.effort ?? 0) + 1) % r.efforts.length;
    }
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + this.windowSize) this.top = this.cursor - this.windowSize + 1;
  }
  async nextScreen() { return this.render(); }
}

const rows = (): SimRow[] => [
  { label: "DeepSeek V4.1 Flash 10/17", efforts: ["high", "medium", "low"], multiplier: 3 },
  { label: "MiMo v2.6 Flash Slow", multiplier: 1 },
  { label: "MiMo v2.6 Flash Fast", multiplier: 2 },
  { label: "Muse Spark 1.3", efforts: ["high", "low"], multiplier: 3 },
  { label: "GLM 5.3 Flash", efforts: ["high", "max"], multiplier: 4 },
  { label: "Claude Haiku 5.5 · 100k context", efforts: ["medium", "high"], multiplier: 6 },
];

describe("chooseInPicker", () => {
  it("moves down a row at a time to a model past the window, then selects it", async () => {
    const picker = new SimPicker(rows());
    await chooseInPicker(picker, { model: "GLM 5.3" });
    expect(picker.cursor).toBe(4);
    expect(picker.keys).toEqual(["down", "down", "down", "down", "enter"]);
  });

  it("walks back up to a model above the cursor", async () => {
    const picker = new SimPicker(rows());
    picker.cursor = 5;
    picker.top = 3;
    await chooseInPicker(picker, { model: "mimo v2.6 flash slow" });
    expect(picker.cursor).toBe(1);
    expect(picker.keys.at(-1)).toBe("enter");
    expect(picker.keys.filter((k) => k === "up")).toHaveLength(4);
  });

  it("cycles the reasoning level with Tab until it matches", async () => {
    const picker = new SimPicker(rows());
    await chooseInPicker(picker, { model: "Muse Spark", effortLevel: "low" });
    expect(picker.keys).toEqual(["down", "down", "down", "tab", "enter"]);
    expect(picker.rows[3].effort).toBe(1);
  });

  it("sets the level on the row under the cursor when no model is given", async () => {
    const picker = new SimPicker(rows());
    await chooseInPicker(picker, { effortLevel: "low" });
    expect(picker.keys).toEqual(["tab", "tab", "enter"]);
  });

  it("selects without a Tab when the row already has the level", async () => {
    const picker = new SimPicker(rows());
    await chooseInPicker(picker, { model: "DeepSeek", effortLevel: "high" });
    expect(picker.keys).toEqual(["enter"]);
  });

  it("fails with every label it scrolled past, after leaving the picker", async () => {
    const picker = new SimPicker(rows());
    const err = await chooseInPicker(picker, { model: "Nonesuch" }).catch((e) => e);
    expect(err).toBeInstanceOf(FreebuffPickerError);
    expect(err.message).toContain('"Nonesuch"');
    for (const row of rows()) expect(err.message).toContain(row.label);
    expect(err.labels).toContain("GLM 5.3 Flash");
    expect(picker.keys.at(-1)).toBe("escape");
    expect(picker.keys).not.toContain("enter");
  });

  it("fails when Tab never reaches the level, naming the levels it offered", async () => {
    const picker = new SimPicker(rows());
    const err = await chooseInPicker(picker, { model: "GLM", effortLevel: "xhigh" }).catch((e) => e);
    expect(err).toBeInstanceOf(FreebuffPickerError);
    expect(err.message).toContain('"high"');
    expect(err.message).toContain('"max"');
    expect(picker.keys.at(-1)).toBe("escape");
  });

  it("does not fail a model that has no reasoning level, but says so", async () => {
    const picker = new SimPicker(rows());
    const done = await chooseInPicker(picker, { model: "MiMo v2.6 Flash Slow", effortLevel: "high" });
    expect(done.warnings[0]).toContain("no reasoning level");
    expect(picker.keys.at(-1)).toBe("enter");
  });

  it("treats the level `default` as unset", async () => {
    const picker = new SimPicker(rows());
    await chooseInPicker(picker, { model: "Muse", effortLevel: "default" });
    expect(picker.keys).not.toContain("tab");
  });
});

describe("choiceSatisfied", () => {
  const bar = { modelLabel: "MiMo v2.6 Flash Slow" };
  it("is satisfied by a matching prefix and a level the model lacks", () => {
    expect(choiceSatisfied({ model: "MiMo v2.6" }, bar)).toBe(true);
    expect(choiceSatisfied({ model: "MiMo v2.6", effortLevel: "high" }, bar)).toBe(true);
    expect(choiceSatisfied({}, bar)).toBe(true);
  });
  it("is not satisfied by another model or level", () => {
    expect(choiceSatisfied({ model: "GLM" }, bar)).toBe(false);
    expect(choiceSatisfied({ effortLevel: "low" }, { modelLabel: "GLM 5.3 Flash", effort: "high" })).toBe(false);
    expect(choiceSatisfied({ model: "GLM" }, undefined)).toBe(false);
  });
});

describe("a picker that draws its hint before its rows", () => {
  it("waits for the rows instead of failing on the empty first frame", async () => {
    const hintOnly = [" 53m left     ✕ End session", " ↑↓ choose model · Tab reasoning · Enter select · Esc cancel", "", " OPTIMIZED · Strongest price-to-performance models"];
    const picker = new SimPicker(rows());
    let frames = 0;
    const io: PickerIO = {
      screen: async () => hintOnly,
      press: (key) => picker.press(key),
      nextScreen: async (previous) => (frames++ < 2 ? previous : picker.screen()),
    };
    await chooseInPicker(io, { model: "GLM 5.3" });
    expect(picker.cursor).toBe(4);
    expect(picker.keys.at(-1)).toBe("enter");
  });

  it("still fails when the rows never come", async () => {
    const hintOnly = [" ↑↓ choose model · Tab reasoning · Enter select · Esc cancel"];
    const io: PickerIO = { screen: async () => hintOnly, press: async () => undefined, nextScreen: async (previous) => previous };
    await expect(chooseInPicker(io, { model: "GLM" })).rejects.toThrow("not showing a selected row");
  });
});

describe("chooseInPicker against recorded screens", () => {
  it("moves from the first row to MiMo v2.6 Flash Slow on the recorded picker", async () => {
    // picker.txt is the picker as first opened (cursor on row 0); picker-tab.txt
    // is the same list with the cursor on the second row.
    const script = [screen("picker-tab.txt")];
    const keys: PickerKey[] = [];
    const io: PickerIO = {
      screen: async () => screen("picker.txt"),
      press: async (key) => { keys.push(key); },
      nextScreen: async (previous) => script.shift() ?? previous,
    };
    await chooseInPicker(io, { model: "MiMo v2.6 Flash Slow" });
    expect(keys).toEqual(["down", "enter"]);
  });

  it("names the labels of a recorded picker that has no such model", async () => {
    const io: PickerIO = {
      screen: async () => screen("picker.txt"),
      press: async () => undefined,
      nextScreen: async (previous) => previous,
    };
    const err = await chooseInPicker(io, { model: "Nonesuch" }).catch((e) => e);
    expect(err.message).toContain("GPT-6 Luna");
    expect(err.message).toContain("MiMo v2.6 Flash Fast");
  });
});
