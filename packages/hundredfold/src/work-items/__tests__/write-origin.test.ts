import { describe, expect, it } from "vitest";
import { WRITE_ORIGIN_HEADER, readWriteOrigin } from "../origin.js";

describe("declared write origin", () => {
  it("reads an exact allowlisted declaration", () => {
    expect(WRITE_ORIGIN_HEADER).toBe("x-hundredfold-origin");
    expect(readWriteOrigin("talk")).toBe("talk");
  });

  it("drops everything else rather than guessing at it", () => {
    const rejected: (string | string[] | undefined)[] = [
      undefined,
      "",
      "   ",
      "Talk",
      "TALK",
      " talk",
      "talk ",
      "talk,talk",
      "talkative",
      "ui",
      "mystery",
      "__proto__",
      ["talk"],
      ["talk", "ui"],
      [],
    ];
    for (const header of rejected) {
      expect(readWriteOrigin(header)).toBeUndefined();
    }
  });
});
