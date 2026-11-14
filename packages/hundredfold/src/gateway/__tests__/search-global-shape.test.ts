import { describe, it, expect } from "vitest";
import { RARE_WORD, features, get, search } from "./helpers/search-route-harness.js";
import { SEARCH_KINDS, type SearchKind } from "../../search/types.js";

/**
 * The response-shape guarantees waves 3, 4 and 5 are written against, and what
 * the route does with input it cannot use. A result that cannot say why it
 * matched, or where Enter would go, is not renderable — so both are asserted
 * for every kind, not only for Todos.
 */

/** Nav pages carry no prose, so they are reached by their own label. */
const QUERY_FOR: Record<SearchKind, string> = {
  todo: RARE_WORD,
  session: RARE_WORD,
  note: RARE_WORD,
  employee: RARE_WORD,
  cron: RARE_WORD,
  skill: RARE_WORD,
  page: "settings",
};

describe("GET /api/search/global — every result is renderable", () => {
  it.each(SEARCH_KINDS)("%s results carry a reason and a preview with a title and a url", async (kind) => {
    const { status, body } = await search(QUERY_FOR[kind], `&scope=${kind}`);
    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      expect(result.kind).toBe(kind);
      expect(result.reason.length).toBeGreaterThan(0);
      for (const reason of result.reason) {
        expect(reason.field).toBeTruthy();
        expect(reason.snippet.length).toBeGreaterThan(0);
      }
      expect(result.preview.title.length).toBeGreaterThan(0);
      expect(result.preview.url.length).toBeGreaterThan(0);
      expect(result.url.length).toBeGreaterThan(0);
    }
  });

  it("counts every kind and reports which ones were cut short", async () => {
    const { body } = await search(RARE_WORD, "&limit=1");
    expect(Object.keys(body.counts).sort()).toEqual([...SEARCH_KINDS].sort());
    for (const kind of body.truncated) {
      expect(body.counts[kind]).toBeGreaterThan(1);
    }
  });

  it("drops the note kind entirely while the Notes feature is off", async () => {
    features.notesEnabled = false;
    try {
      const { body } = await search(RARE_WORD);
      expect(body.results.some((result: any) => result.kind === "note")).toBe(false);
      expect(body.counts.note).toBe(0);
    } finally {
      features.notesEnabled = true;
    }
    const restored = await search(RARE_WORD);
    expect(restored.body.results.some((result: any) => result.kind === "note")).toBe(true);
  });

  it("omits the note kind entirely when a search finds none", async () => {
    const { body } = await search("settings", "&scope=note");
    expect(body.results).toEqual([]);
    expect(body.counts.note).toBe(0);
  });
});

describe("GET /api/search/global — unusable input", () => {
  it("rejects a missing q", async () => {
    const { status, body } = await get("/api/search/global");
    expect(status).toBe(400);
    expect(body.error).toBe("q is required");
  });

  it("rejects a q past the route char cap", async () => {
    const { status, body } = await search("a".repeat(1025));
    expect(status).toBe(400);
    expect(body.error).toMatch(/q is too long \(1025 chars, max 1024\)/);
  });

  it.each([
    ["is:nonsense", /is:nonsense/],
    ["#no-such-label", /#no-such-label/],
    ["@nobody", /@nobody/],
    ["in:nowhere", /in:nowhere/],
  ])("rejects the explicit token %s by name rather than ignoring it", async (token, named) => {
    const { status, body } = await search(`something ${token}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(named);
  });

  it("rejects a scope that names no kind", async () => {
    const { status, body } = await search("anything", "&scope=nonsense");
    expect(status).toBe(400);
    expect(body.error).toMatch(/scope must be one of/);
  });

  it("rejects a non-numeric limit", async () => {
    const { status } = await search("anything", "&limit=lots");
    expect(status).toBe(400);
  });

  // The last case carries an embedded NUL: control bytes are stripped from the
  // param rather than reaching FTS5, which used to throw on one.
  it.each(['"', "*", "NEAR(a b)", "-foo", "()", "^$\\", "a AND OR b", "column", "zephyr\u0000pipeline"])(
    "answers 200 for the adversarial query %j instead of throwing",
    async (hostile) => {
      const { status, body } = await search(hostile);
      expect(status).toBe(200);
      expect(Array.isArray(body.results)).toBe(true);
    },
  );
});
