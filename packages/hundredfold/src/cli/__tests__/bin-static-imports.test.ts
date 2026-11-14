import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRY = path.join(PKG, "bin", "hundredfold.ts");
const PATHS = path.join(PKG, "src", "shared", "paths.ts");

/** The files `entry` loads before its first line runs: static imports and re-exports, followed through the package. */
function staticClosure(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = [[entry, null]];
  while (queue.length > 0) {
    const [file, parent] = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, parent);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/^(?:import|export)\s(?!type\s)[^'"]*?from\s+['"](\.[^'"]+)['"]|^import\s+['"](\.[^'"]+)['"]/gm)) {
      const target = path.resolve(path.dirname(file), (match[1] ?? match[2]).replace(/\.js$/, ".ts"));
      if (target.endsWith(".ts") && fs.existsSync(target)) queue.push([target, file]);
    }
  }
  return seen;
}

describe("the command line's static imports", () => {
  it("never load the module that evaluates the home's paths", () => {
    // The home of an older install is moved by the first command that runs, after this file's imports have
    // loaded. A module that read the path while loading would keep the old one for the rest of the process,
    // and the gateway that command starts would be handed it.
    const closure = staticClosure(ENTRY);
    expect(closure.size).toBeGreaterThan(20);
    const chain: string[] = [];
    for (let file: string | null | undefined = PATHS; closure.has(PATHS) && file; file = closure.get(file)) chain.push(path.relative(PKG, file));
    expect(chain.reverse().join(" -> ")).toBe("");
  });
});
