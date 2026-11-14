import { describe, it, expect } from "vitest";
import { mentions, otherOwner, otherStatus, redesign, search } from "./helpers/search-route-harness.js";

/**
 * The four canonical queries of the ⌘K search workspace, answered end to end
 * through handleApiRequest: two body words in the wrong order, a bare Todo id,
 * an inferred natural-language query, and the same query in explicit tokens.
 */

function todoIds(body: any): string[] {
  return body.results.filter((result: any) => result.kind === "todo").map((result: any) => result.id);
}

describe("GET /api/search/global — canonical queries", () => {
  it("finds a Todo by two words that land in the title and the body, in the wrong order", async () => {
    const { status, body } = await search("search opens");
    expect(status).toBe(200);
    const hit = body.results.find((result: any) => result.id === redesign.id);
    expect(hit).toBeDefined();
    expect(hit.reason.length).toBeGreaterThan(0);
    expect(hit.preview.title).toBe(redesign.title);
    expect(hit.preview.url).toBe(`/todos/${redesign.id}`);
    expect(hit.preview.excerpt.length).toBeGreaterThan(0);
  });

  it("puts an exact Todo id ahead of every text hit", async () => {
    const { status, body } = await search(redesign.id);
    expect(status).toBe(200);
    // `mentions` carries the id in its body, so the id query has a text rival.
    expect(todoIds(body)).toContain(mentions.id);
    expect(todoIds(body)[0]).toBe(redesign.id);
    expect(body.parsed.freeText).toBe(redesign.id);
  });

  it("infers status and assignee from plain words, and still returns rows", async () => {
    const { status, body } = await search("everything blocked on hundredfold-dev");
    expect(status).toBe(200);
    expect(body.parsed.facets).toEqual([
      { kind: "status", value: "blocked", origin: "inferred", span: { start: 11, end: 18, text: "blocked" } },
      { kind: "assignee", value: "hundredfold-dev", origin: "inferred", span: { start: 22, end: 37, text: "hundredfold-dev" } },
    ]);
    // The connectives are gone, so nothing narrows the query into emptiness.
    expect(body.parsed.freeText).toBe("");
    expect(todoIds(body)).toEqual([redesign.id]);
    expect(todoIds(body)).not.toContain(otherOwner.id);
    expect(todoIds(body)).not.toContain(otherStatus.id);
  });

  it("commits the same facets from explicit tokens", async () => {
    const { status, body } = await search("@hundredfold-dev is:executing");
    expect(status).toBe(200);
    expect(body.parsed.facets.map((facet: any) => [facet.kind, facet.value, facet.origin])).toEqual([
      ["assignee", "hundredfold-dev", "token"],
      ["status", "executing", "token"],
    ]);
    expect(todoIds(body)).toEqual([mentions.id]);
  });

  it("gives a facet-selected Todo a reason naming the facet that selected it", async () => {
    const { body } = await search("@hundredfold-dev is:executing");
    const hit = body.results.find((result: any) => result.id === mentions.id);
    expect(hit.reason).toEqual([
      { field: "assignee", snippet: "hundredfold-dev" },
      { field: "status", snippet: "executing" },
    ]);
  });

  it("searches the whole string literally when literal=true, inferring nothing", async () => {
    const { status, body } = await search("everything blocked on hundredfold-dev", "&literal=true");
    expect(status).toBe(200);
    expect(body.parsed).toMatchObject({ facets: [], freeText: "everything blocked on hundredfold-dev", literal: true });
    expect(todoIds(body)).toEqual([]);
  });
});

describe("GET /api/search/global — scope", () => {
  it("returns only Todos under scope=todos, and more kinds without it", async () => {
    const scoped = await search("zephyr", "&scope=todos");
    expect(scoped.status).toBe(200);
    expect(scoped.body.results.length).toBeGreaterThan(0);
    expect([...new Set(scoped.body.results.map((result: any) => result.kind))]).toEqual(["todo"]);

    const unscoped = await search("zephyr");
    expect(new Set(unscoped.body.results.map((result: any) => result.kind)).size).toBeGreaterThan(1);
  });

  it("accepts the singular kind name too", async () => {
    const { status, body } = await search("zephyr", "&scope=todo");
    expect(status).toBe(200);
    expect([...new Set(body.results.map((result: any) => result.kind))]).toEqual(["todo"]);
  });

  it("keeps results in the declared kind order", async () => {
    const order = ["todo", "session", "note", "employee", "cron", "skill", "page"];
    const { body } = await search("zephyr");
    const seen = body.results.map((result: any) => order.indexOf(result.kind));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});
