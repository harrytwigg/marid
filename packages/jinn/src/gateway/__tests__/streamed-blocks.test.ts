import { describe, expect, it } from "vitest";
import {
  completedStreamedBlockIds,
  shouldPreserveStreamedBlocks,
} from "../streamed-blocks.js";

describe("streamed block persistence", () => {
  it("preserves completed tool-bearing turns as fold evidence", () => {
    expect(
      shouldPreserveStreamedBlocks({
        quietPreempted: false,
        streamedBlocks: [
          { content: "PROGRESS-FIRST" },
          { content: "Used Bash", toolCall: "Bash" },
          { content: "PROGRESS-FINAL" },
        ],
      }),
    ).toBe(true);
  });

  it("preserves completed text-only turns as fold evidence", () => {
    expect(
      shouldPreserveStreamedBlocks({
        quietPreempted: false,
        streamedBlocks: [{ content: "just streaming text" }],
      }),
    ).toBe(true);
  });

  it("drops streamed blocks from interrupted or superseded turns", () => {
    expect(
      shouldPreserveStreamedBlocks({
        quietPreempted: true,
        streamedBlocks: [
          { content: "old progress" },
          { content: "Using Bash", toolCall: "Bash" },
        ],
      }),
    ).toBe(false);
  });

  it("drops only the exact streamed result row while preserving other evidence", () => {
    expect([...completedStreamedBlockIds({
      quietPreempted: false,
      rateLimited: false,
      result: "PROGRESS-FINAL",
      error: null,
      streamedBlocks: [
        { id: "interim", content: "PROGRESS-FIRST" },
        { id: "tool", content: "Used Bash", toolCall: "Bash" },
        { id: "duplicate", content: "PROGRESS-FINAL" },
      ],
    })]).toEqual(["interim", "tool"]);
  });

  it("does not whitespace-normalize final dedup", () => {
    expect([...completedStreamedBlockIds({
      quietPreempted: false,
      rateLimited: false,
      result: "same spacing",
      error: null,
      streamedBlocks: [{ id: "distinct", content: "same   spacing" }],
    })]).toEqual(["distinct"]);
  });

  it("does not dedupe multiple fragments that merely concatenate to the final result", () => {
    expect([...completedStreamedBlockIds({
      quietPreempted: false,
      rateLimited: false,
      result: "first final",
      error: null,
      streamedBlocks: [
        { id: "first", content: "first" },
        { id: "tool", content: "Used Bash", toolCall: "Bash" },
        { id: "final", content: "final" },
      ],
    })]).toEqual(["first", "tool", "final"]);
  });

  describe("a turn that does not complete still keeps the tool calls that ran", () => {
    const streamed = [
      { id: "prose", content: "Looking into it." },
      { id: "ran", content: "Used Read", toolCall: "Read" },
      { id: "running", content: "Using Bash", toolCall: "Bash" },
      { id: "media", content: "", media: [{ type: "image" }] },
      { id: "ran-too", content: "Used Grep", toolCall: "Grep" },
    ];

    it("when preempted by a stop or a newer message", () => {
      expect([...completedStreamedBlockIds({
        quietPreempted: true,
        rateLimited: false,
        result: "",
        error: "Interrupted: new message received",
        streamedBlocks: streamed,
      })]).toEqual(["ran", "ran-too"]);
    });

    it("when refused by a usage limit", () => {
      expect([...completedStreamedBlockIds({
        quietPreempted: false,
        rateLimited: true,
        result: "",
        error: "usage limit reached",
        streamedBlocks: streamed,
      })]).toEqual(["ran", "ran-too"]);
    });

    it("when it ends with no answer", () => {
      expect([...completedStreamedBlockIds({
        quietPreempted: false,
        rateLimited: false,
        result: "",
        error: null,
        streamedBlocks: streamed,
      })]).toEqual(["ran", "ran-too"]);
    });
  });
});
