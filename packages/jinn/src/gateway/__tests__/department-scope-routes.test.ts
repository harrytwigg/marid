import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFUSED_ROUTES, routePattern, SCOPED_ROUTES } from "../department-scope/rules.js";

/**
 * SC-001's enumeration: every route the gateway serves is classified for
 * department-scoped sessions, either in the scoped table or in the refused list. The
 * gate refuses an unlisted route anyway (default deny); this test makes adding a route
 * without deciding how scoped sessions see it a failing build rather than a silent 403.
 *
 * Routes are read from the gateway's own source, as string literals beginning `/api/`.
 */

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function routeLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(gatewayDir)) {
    for (const match of fs.readFileSync(file, "utf-8").matchAll(/["'`](\/api\/[A-Za-z0-9_/:.*-]*)/g)) {
      found.set(match[1], path.relative(gatewayDir, file));
    }
  }
  return found;
}

/** A literal as a concrete path: parameters filled in, a prefix's tail dropped. */
function sample(literal: string): string {
  return literal.replace(/:[A-Za-z]+/g, "x").replace(/\*$/, "").replace(/\/$/, "");
}

const classified = (pathname: string) =>
  SCOPED_ROUTES.some((row) => routePattern(row.route).test(pathname))
  || Object.keys(REFUSED_ROUTES).some((route) => routePattern(route).test(pathname));

describe("the scoped-caller route table", () => {
  it("classifies every route literal in the gateway's source", () => {
    const literals = routeLiterals();
    expect(literals.size).toBeGreaterThan(100);
    const unclassified = [...literals].filter(([literal]) => sample(literal) !== "/api" && !classified(sample(literal)));
    expect(unclassified.map(([literal, file]) => `${literal} (${file})`)).toEqual([]);
  });

  it("names no route the gateway does not serve", () => {
    const literals = new Set([...routeLiterals().keys()].map(sample));
    // Matched by splitting the path rather than by a literal.
    const splitByHand = new Set(["/api/heartbeats/:id"]);
    const dead = SCOPED_ROUTES.map((row) => row.route).filter((route) => !splitByHand.has(route) && !literals.has(sample(route)));
    expect(dead).toEqual([]);
  });

  it("never lists a route as both allowed and refused", () => {
    const both = SCOPED_ROUTES.filter((row) => Object.keys(REFUSED_ROUTES).includes(row.route)).map((row) => row.route);
    expect(both).toEqual([]);
  });
});
