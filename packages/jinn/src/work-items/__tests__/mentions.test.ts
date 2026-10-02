import { describe, expect, it } from "vitest";
import { parseMentions } from "../mentions.js";

describe("parseMentions", () => {
  it.each([
    ["@lead-engineer, please look", ["lead-engineer"]],
    ["(@alpha) and @Bravo.", ["alpha", "bravo"]],
    ["@alpha- then @alpha again", ["alpha"]],
    ["line one\n@gamma_ at the start of a line", ["gamma"]],
  ])("finds the mentions in %j", (body, expected) => {
    expect(parseMentions(body)).toEqual(expected);
  });

  it.each([
    "write to ops@example.com",
    "see docs/@alpha or a.@alpha",
    "quoted `@alpha` inline",
    "```\n@alpha in a fence\n```",
    "~~~\n@alpha in a tilde fence\n~~~",
    "an @ on its own, or @-",
  ])("finds none in %j", (body) => {
    expect(parseMentions(body)).toEqual([]);
  });
});
