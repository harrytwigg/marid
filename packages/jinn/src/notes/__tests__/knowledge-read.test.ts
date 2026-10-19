import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWLEDGE_FILE_CHAR_CAP, readKnowledgeFile } from "../store.js";

/**
 * The read cap and its offset paging, split out of store.test.ts, which
 * owns the Notes surface and readKnowledgeFile's containment battery. Its own
 * instance fixture: these cases seed large files and an escaping symlink and share
 * nothing with the suites next door.
 */

let instanceHome: string;

function seedInstance(rel: string, content: string): void {
  const abs = path.join(instanceHome, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  instanceHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-read-"));
  seedInstance("knowledge/pricing-strategy.md", "# Pricing strategy 2026\n\nThe axolotl tier was approved at 19 euro.\n");
  seedInstance("secrets/api-keys.json", JSON.stringify({ secret: "TOPSECRET-zq9" }));
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-read-outside-")), "outside.md");
  fs.writeFileSync(outsideFile, "TOPSECRET-outside");
  fs.symlinkSync(outsideFile, path.join(instanceHome, "knowledge", "escape.md"));
});

/**
 * The cut point is measured here rather than assumed, because everything
 * downstream — the route, the MCP tool, and the agent deciding whether it has the
 * whole file — trusts `truncated` and the char counts to describe this slice exactly.
 */
describe("readKnowledgeFile — the cap boundary and offset paging", () => {
  /** A file of exactly `chars` chars whose every position is identifiable. */
  const seedSized = (rel: string, chars: number): string => {
    const body = Array.from({ length: chars }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    seedInstance(rel, body);
    return body;
  };

  const read = (rel: string, offset?: number) => {
    const r = readKnowledgeFile(rel, instanceHome, offset);
    expect(r.ok, `expected ${rel} to read`).toBe(true);
    if (!r.ok) throw new Error(r.detail);
    return r;
  };

  it("returns the whole file, byte-identical, at one char below the cap and at exactly the cap", () => {
    for (const size of [KNOWLEDGE_FILE_CHAR_CAP - 1, KNOWLEDGE_FILE_CHAR_CAP]) {
      const body = seedSized(`knowledge/boundary-${size}.md`, size);
      const r = read(`knowledge/boundary-${size}.md`);
      expect(r.content).toBe(body);
      expect(r.truncated).toBe(false);
      expect(r.totalChars).toBe(size);
      expect(r.returnedChars).toBe(size);
      expect(r.offset).toBe(0);
    }
  });

  it("truncates at exactly one char above the cap, returning CAP chars and saying so", () => {
    const size = KNOWLEDGE_FILE_CHAR_CAP + 1;
    const body = seedSized("knowledge/boundary-over.md", size);
    const r = read("knowledge/boundary-over.md");
    expect(r.truncated).toBe(true);
    expect(r.returnedChars).toBe(KNOWLEDGE_FILE_CHAR_CAP);
    expect(r.totalChars).toBe(size);
    expect(r.offset).toBe(0);
    expect(r.content).toBe(body.slice(0, KNOWLEDGE_FILE_CHAR_CAP));
  });

  it("pages the rest by offset, and the slices concatenate back to the file exactly", () => {
    const body = seedSized("knowledge/paged.md", KNOWLEDGE_FILE_CHAR_CAP * 2 + 137);
    let offset = 0;
    let rebuilt = "";
    for (let guard = 0; guard < 10; guard++) {
      const slice = read("knowledge/paged.md", offset);
      expect(slice.offset).toBe(offset);
      expect(slice.returnedChars).toBe(slice.content.length);
      expect(slice.totalChars).toBe(body.length);
      rebuilt += slice.content;
      offset += slice.returnedChars;
      if (!slice.truncated) break;
    }
    expect(rebuilt).toBe(body);
    expect(offset).toBe(body.length);
  });

  it("reads past the end honestly: empty content, not truncated, offset unchanged", () => {
    const body = seedSized("knowledge/short.md", 40);
    const r = read("knowledge/short.md", body.length + 500);
    expect(r.content).toBe("");
    expect(r.returnedChars).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.totalChars).toBe(body.length);
    expect(r.offset).toBe(body.length + 500);
  });

  it("refuses a negative or non-integer offset instead of slicing something wrong", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = readKnowledgeFile("knowledge/pricing-strategy.md", instanceHome, bad);
      expect(r.ok, `expected offset ${bad} to be refused`).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid-offset");
    }
  });

  it("applies offset only after containment — an escape stays refused at every offset", () => {
    for (const offset of [0, 5, 10_000]) {
      const escape = readKnowledgeFile("knowledge/escape.md", instanceHome, offset);
      expect(escape.ok).toBe(false);
      if (!escape.ok) expect(escape.reason).toBe("forbidden");
      expect(JSON.stringify(escape)).not.toContain("TOPSECRET-outside");

      const traversal = readKnowledgeFile("knowledge/../secrets/api-keys.json", instanceHome, offset);
      expect(traversal.ok).toBe(false);
      if (!traversal.ok) expect(traversal.reason).toBe("invalid-path");
      expect(JSON.stringify(traversal)).not.toContain("TOPSECRET-zq9");
    }
  });
});
