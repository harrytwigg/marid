import { describe, it, expect, vi } from "vitest";

/**
 * Contract for the `/api/search*` router seam. The three per-entity searches
 * moved out of api.ts unchanged when the global route was added; that they
 * still answer byte-identically is proven by their own suites, which were not
 * touched. What is new is the seam, and its two properties go red when broken:
 * an adjacent unmatched path falls through instead of being swallowed, and a
 * throw inside the module still lands in api.ts's 500 envelope.
 */

/** Set by the test that needs the delegated handler to blow up mid-request. */
let globalSearchThrows = false;

vi.mock("../../search/global-search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../search/global-search.js")>();
  return {
    ...actual,
    runGlobalSearch: (...args: Parameters<typeof actual.runGlobalSearch>) => {
      if (globalSearchThrows) throw new Error("forced global search failure");
      return actual.runGlobalSearch(...args);
    },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { get, search } from "./helpers/search-route-harness.js";

describe("/api/search* router seam", () => {
  it("falls through on an adjacent unmatched path instead of swallowing it", async () => {
    for (const path of ["/api/searchx", "/api/search", "/api/search/globalx", "/api/search/messagesx"]) {
      const response = await get(path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(response.body).toEqual({ error: "Not found" });
    }
  });

  it("falls through on a method the module does not serve", async () => {
    const { status } = await get("/api/search/global?q=anything");
    expect(status).toBe(200);
  });

  it("lets a throw inside the delegated module reach api.ts's 500 envelope", async () => {
    globalSearchThrows = true;
    try {
      const response = await search("anything");
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "forced global search failure" });
    } finally {
      globalSearchThrows = false;
    }
  });

  it("still serves the moved routes through the delegation", async () => {
    expect((await get("/api/search/messages?q=zephyr")).status).toBe(200);
    expect((await get("/api/search/sessions?employee=hundredfold-dev")).status).toBe(200);
    expect((await get("/api/search/work-items?status=blocked")).status).toBe(200);
    // Their 400 lanes moved with them.
    expect((await get("/api/search/messages")).status).toBe(400);
    expect((await get("/api/search/sessions")).status).toBe(400);
    expect((await get("/api/search/work-items")).status).toBe(400);
  });
});
