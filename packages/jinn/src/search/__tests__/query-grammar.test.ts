import { describe, it, expect } from "vitest";
import { parseSearchQuery, type SearchVocabulary } from "../query-grammar.js";

/** A vocabulary small enough to reason about, real enough to be representative. */
const VOCABULARY: SearchVocabulary = {
  statuses: ["backlog", "executing", "in_review", "done", "blocked", "cancelled"],
  assignees: ["jinn-dev", "seo-specialist"],
  departments: ["platform", "marketing"],
  labels: ["build", "urgent"],
};

function parse(input: string, literal = false) {
  const result = parseSearchQuery(input, VOCABULARY, { literal });
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.value;
}

describe("parseSearchQuery", () => {
  it("infers status and assignee from plain words and drops the connectives around them", () => {
    const parsed = parse("everything blocked on jinn-dev");
    expect(parsed.facets).toEqual([
      { kind: "status", value: "blocked", origin: "inferred", span: { start: 11, end: 18, text: "blocked" } },
      { kind: "assignee", value: "jinn-dev", origin: "inferred", span: { start: 22, end: 30, text: "jinn-dev" } },
    ]);
    // `everything` and `on` are connectives; ANDing them into the index is what
    // makes this query return nothing.
    expect(parsed.freeText).toBe("");
  });

  it("reports the span of every facet against the original characters", () => {
    const input = "everything blocked on jinn-dev";
    for (const facet of parse(input).facets) {
      expect(input.slice(facet.span.start, facet.span.end)).toBe(facet.span.text);
    }
  });

  it("commits explicit tokens as facets and consumes them from the free text", () => {
    const parsed = parse("@jinn-dev is:executing");
    expect(parsed.facets).toEqual([
      { kind: "assignee", value: "jinn-dev", origin: "token", span: { start: 0, end: 9, text: "@jinn-dev" } },
      { kind: "status", value: "executing", origin: "token", span: { start: 10, end: 22, text: "is:executing" } },
    ]);
    expect(parsed.freeText).toBe("");
  });

  it("reads #label and in:department tokens too", () => {
    const parsed = parse("#build in:platform");
    expect(parsed.facets.map((facet) => [facet.kind, facet.value, facet.origin])).toEqual([
      ["label", "build", "token"],
      ["department", "platform", "token"],
    ]);
  });

  it("misses cleanly: a query matching no vocabulary is all free text", () => {
    const parsed = parse("search opens");
    expect(parsed.facets).toEqual([]);
    expect(parsed.freeText).toBe("search opens");
  });

  it("keeps connectives when nothing was inferred, so a plain query is never narrowed", () => {
    expect(parse("all hands on deck").freeText).toBe("all hands on deck");
  });

  it("infers partially: an unknown name stays free text instead of inventing an assignee", () => {
    const parsed = parse("blocked on someone-who-does-not-exist");
    expect(parsed.facets.map((facet) => facet.kind)).toEqual(["status"]);
    expect(parsed.facets.some((facet) => facet.kind === "assignee")).toBe(false);
    expect(parsed.freeText).toBe("someone-who-does-not-exist");
  });

  it("lets an explicit token beat a conflicting inference of the same kind", () => {
    const parsed = parse("blocked is:executing");
    expect(parsed.facets).toEqual([
      { kind: "status", value: "executing", origin: "token", span: { start: 8, end: 20, text: "is:executing" } },
    ]);
    // The superseded word was a status attempt, not a search term.
    expect(parsed.freeText).toBe("");
  });

  it("matches the vocabulary case-insensitively and reports the canonical value", () => {
    const parsed = parse("is:BLOCKED @JINN-DEV");
    expect(parsed.facets.map((facet) => facet.value)).toEqual(["blocked", "jinn-dev"]);
  });

  it("rejects an explicit token whose value is not in the vocabulary, naming the token", () => {
    for (const bad of ["is:nonsense", "#no-such-label", "@nobody", "in:nowhere"]) {
      const result = parseSearchQuery(`something ${bad}`, VOCABULARY, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(bad);
    }
  });

  it("treats a bare prefix as ordinary text rather than an empty token", () => {
    const parsed = parse("@ is: #");
    expect(parsed.facets).toEqual([]);
    expect(parsed.freeText).toBe("@ is: #");
  });

  it("lifts an exact Todo id out while leaving it in the free text for the index to score", () => {
    const parsed = parse("ICI-1368");
    expect(parsed.todoId).toBe("ICI-1368");
    expect(parsed.freeText).toBe("ICI-1368");
  });

  it("reports no Todo id when the query is more than the id", () => {
    expect(parse("ICI-1368 search").todoId).toBeNull();
  });

  it("literal=true produces zero facets and the whole raw string as free text", () => {
    const parsed = parse("everything blocked on jinn-dev @jinn-dev is:executing", true);
    expect(parsed.facets).toEqual([]);
    expect(parsed.freeText).toBe("everything blocked on jinn-dev @jinn-dev is:executing");
    expect(parsed.literal).toBe(true);
  });

  it("survives adversarial punctuation without throwing", () => {
    for (const hostile of ['"', "*", "NEAR(a b)", "-foo", "()", "a b"]) {
      expect(parseSearchQuery(hostile, VOCABULARY, {}).ok).toBe(true);
    }
  });
});
