import { describe, expect, it } from "vitest";
import { scrapeAnswer } from "../freebuff-scrape.js";
import { screen } from "./helpers/freebuff-fixtures.js";

describe("scrapeAnswer", () => {
  it("takes the text between the user's message and the footer, minus reasoning and tool output", () => {
    const answer = scrapeAnswer(screen("turn-finished.txt"));
    expect(answer).toContain("Verified:");
    expect(answer).toContain("DONE");
    expect(answer).not.toContain("Thinking");
    expect(answer).not.toContain("od -c");
    expect(answer).not.toContain("█");
  });

  it("returns undefined when the turn has no footer yet", () => {
    expect(scrapeAnswer(screen("busy.txt"))).toBeUndefined();
  });

  it("returns undefined for a screen with no conversation", () => {
    expect(scrapeAnswer(screen("idle-session-active.txt"))).toBeUndefined();
  });
});
