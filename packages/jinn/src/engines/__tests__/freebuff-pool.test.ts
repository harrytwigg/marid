import { describe, expect, it } from "vitest";
import { clampGeometry } from "../freebuff-pool.js";
import { FREEBUFF_COLS, FREEBUFF_ROWS } from "../freebuff-terminal.js";

describe("clampGeometry", () => {
  it("keeps the terminal and the CLI at least as large as the screen parser was written for, whatever the dashboard pane is", () => {
    expect(clampGeometry(80, 24)).toEqual({ cols: FREEBUFF_COLS, rows: FREEBUFF_ROWS });
    expect(clampGeometry(120, 60)).toEqual({ cols: FREEBUFF_COLS, rows: 60 });
  });

  it("does not shrink a larger one", () => {
    expect(clampGeometry(220, 70)).toEqual({ cols: 220, rows: 70 });
  });
});
