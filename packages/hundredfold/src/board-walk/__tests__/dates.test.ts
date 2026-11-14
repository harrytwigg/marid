import { describe, expect, it } from "vitest";
import { datesIn, namesDate } from "../dates.js";

describe("dates as written in a Todo", () => {
  it.each([
    ["not before 2026-11-01", true],
    ["Not before 1 November.", true],
    ["after the 1st of November 2026", true],
    ["from 1 Nov", true],
    ["November 1", true],
    ["Nov 1st, 2026", true],
    ["Nov. 1", true],
    ["not before the 1st", true],
    ["not before the 2nd", false],
    ["the 1st of December", false],
    ["1 November 2025", false],
    ["2 November", false],
    ["01/11", false],
    ["Harry to choose between vendor A and vendor B.", false],
  ])("%s names 2026-11-01: %s", (text, expected) => {
    expect(namesDate(text, "2026-11-01")).toBe(expected);
  });

  it("reads every form it knows, and ignores impossible days", () => {
    expect(datesIn("2026-09-30, 3rd of March and Dec 25, 2027; 31 Febtember; after the 10th")).toEqual([
      { year: 2026, month: 9, day: 30 },
      { day: 3, month: 3 },
      { month: 12, day: 25, year: 2027 },
      { day: 10 },
    ]);
    expect(namesDate("anything", "not a date")).toBe(false);
  });
});
