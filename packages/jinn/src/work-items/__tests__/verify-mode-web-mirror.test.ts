import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFY_MODE_BY_SOURCE } from "../store.js";

/**
 * The web app keeps its own copy of the provenance defaults so a Todo sheet shows
 * the same effective tier the gateway applies. It cannot import the gateway's
 * store, so this reads the web copy out of its source and compares the two.
 */
const webTodos = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../web/src/lib/todos.ts");

function webDefaults(): Record<string, string> {
  const source = fs.readFileSync(webTodos, "utf8");
  const body = /export const DEFAULT_VERIFY_MODE_BY_SOURCE\b[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1];
  if (body === undefined) throw new Error(`DEFAULT_VERIFY_MODE_BY_SOURCE not found in ${webTodos}`);
  return Object.fromEntries([...body.matchAll(/(\w+):\s*"(\w+)"/g)].map(([, key, mode]) => [key, mode]));
}

describe("default verify mode by source", () => {
  it("is mirrored exactly by the web app", () => {
    expect(webDefaults()).toEqual({ ...DEFAULT_VERIFY_MODE_BY_SOURCE });
  });
});
