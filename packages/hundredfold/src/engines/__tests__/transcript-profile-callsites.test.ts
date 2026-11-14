import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// A session on another Claude profile keeps its transcript under that profile.
// Every reader that looks a transcript up by session id must say which profile,
// which `findSessionTranscript` makes it do and a bare `findTranscriptForSession`
// does not. `findTranscriptOfSession` is the same lookup taken from a session, which also
// names the cwd it ran in (a scoped session's stage directory).
describe("transcript lookups name their profile", () => {
  for (const rel of ["../claude-interactive.ts", "../../gateway/external-turns.ts"]) {
    it(`${path.basename(rel)} has no bare findTranscriptForSession call`, () => {
      const source = fs.readFileSync(path.join(here, rel), "utf-8");
      const bare = source.split("\n").filter((l) => /findTranscriptForSession\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      expect(bare).toEqual([]);
      expect(source).toMatch(/findSessionTranscript\(|findTranscriptOfSession\(/);
    });
  }
});
