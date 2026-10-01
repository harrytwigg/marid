import { describe, it, expect } from "vitest";
import { parseVersionOutput, productBanner } from "../brand.js";

describe("parseVersionOutput", () => {
  it("reads the version out of the current banner", () => {
    expect(parseVersionOutput("Marid 0.33.3 (built on Jinn)")).toBe("0.33.3");
  });

  it("round-trips whatever productBanner prints", () => {
    for (const v of ["0.33.3", "1.0.0", "0.34.0-beta.1", "2.1.0+build.5"]) {
      expect(parseVersionOutput(productBanner(v))).toBe(v);
    }
  });

  it("still reads the bare version printed by builds from before the rebrand", () => {
    expect(parseVersionOutput("0.33.3")).toBe("0.33.3");
    expect(parseVersionOutput("0.34.0-rc.2")).toBe("0.34.0-rc.2");
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseVersionOutput("  Marid 0.33.3 (built on Jinn)\r")).toBe("0.33.3");
    expect(parseVersionOutput("0.33.3\n")).toBe("0.33.3");
  });

  it("returns undefined for anything that is not a version line", () => {
    for (const line of [
      "",
      "   ",
      "Marid",
      "Marid (built on Jinn)",
      "Marid 0.33 (built on Jinn)",
      "Marid 0.33.3",
      "Marid 0.33.3 (built on Jinn) extra",
      "Other 0.33.3 (built on Jinn)",
      "jinn: command not found",
      "v0.33.3",
      "0.33",
    ]) {
      expect(parseVersionOutput(line)).toBeUndefined();
    }
  });
});
