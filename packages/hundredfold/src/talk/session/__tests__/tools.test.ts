import { describe, expect, it } from "vitest";
import {
  allTools,
  estimateToolTokens,
  toolsByName,
} from "../tools.js";

describe("the tool catalog", () => {
  it("declares no tool name twice", () => {
    const names = allTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("estimateToolTokens", () => {
  it("reports the non-zero cost of the canonical catalog", () => {
    expect(estimateToolTokens(allTools())).toBeGreaterThan(0);
  });

  it("costs nothing for no tools", () => {
    expect(estimateToolTokens([])).toBeGreaterThanOrEqual(0);
  });
});

describe("toolsByName", () => {
  it("resolves exposed names back to declarations for a re-minted token", () => {
    expect(toolsByName(["read_todo", "talk_comment_todo"]).map((tool) => tool.name))
      .toEqual(["read_todo", "talk_comment_todo"]);
  });

  it("drops a name the catalog no longer carries rather than emitting a hole", () => {
    expect(toolsByName(["read_todo", "retired_tool"]).map((tool) => tool.name))
      .toEqual(["read_todo"]);
  });
});
