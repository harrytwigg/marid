import { describe, expect, it } from "vitest";
import {
  InvalidTodoIdError,
  deriveTodoIdPrefix,
  formatTodoId,
  parseTodoId,
  resolveTodoIdPrefix,
  todoIdOrdinal,
  todoIdPrefix,
} from "../id.js";

describe("company-derived Todo identity", () => {
  it("uses intuitive word initials and single-word letter prefixes", () => {
    expect(deriveTodoIdPrefix("AC-MEDIA")).toBe("ACM");
    expect(deriveTodoIdPrefix("Build Sprint Labs")).toBe("BSL");
    expect(deriveTodoIdPrefix("Acme Corp")).toBe("ACM");
    expect(deriveTodoIdPrefix("A Company")).toBe("ACO");
    expect(deriveTodoIdPrefix("Jinn")).toBe("JIN");
    expect(deriveTodoIdPrefix("Yorio")).toBe("YOR");
    expect(deriveTodoIdPrefix("Éclair Works")).toBe("ECL");
    expect(deriveTodoIdPrefix("  one.two  ")).toBe("ONE");
  });

  it("treats punctuation as word separators and lets a canonical override win", () => {
    expect(deriveTodoIdPrefix("Build/Sprint&Labs")).toBe("BSL");
    expect(resolveTodoIdPrefix("Build Sprint Labs", "JNN")).toBe("JNN");
    expect(resolveTodoIdPrefix("Build Sprint Labs", undefined)).toBe("BSL");
    for (const override of ["JN", "JINN", "jin", "J1N", " JNN ", 42]) {
      expect(() => resolveTodoIdPrefix("Jinn", override)).toThrow(/prefix/i);
    }
  });

  it("rejects company names that cannot produce three ASCII letters", () => {
    for (const value of ["AI", "123", "東京", "", null, 42]) {
      expect(() => deriveTodoIdPrefix(value)).toThrow(/company name/i);
    }
  });

  it("parses and formats any canonical three-letter company prefix", () => {
    expect(parseTodoId("ISS-1")).toBe("ISS-1");
    expect(parseTodoId("ACM-9007199254740991")).toBe("ACM-9007199254740991");
    expect(todoIdPrefix("ISS-42")).toBe("ISS");
    expect(todoIdOrdinal("ISS-42")).toBe(42);
    expect(formatTodoId("ISS", 42)).toBe("ISS-42");
  });

  it("rejects malformed prefixes and ordinals", () => {
    for (const value of [
      "IC-1",
      "ICID-1",
      "iss-1",
      "I1I-1",
      "ISS-0",
      "ISS-01",
      "ISS-9007199254740992",
      " ISS-1",
    ]) {
      expect(() => parseTodoId(value)).toThrow(InvalidTodoIdError);
    }
    expect(() => formatTodoId("IC", 1)).toThrow(InvalidTodoIdError);
  });
});
