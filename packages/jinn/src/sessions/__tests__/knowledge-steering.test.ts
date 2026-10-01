import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Instance steering of knowledge search: `knowledge.guidance` reaches the prompt
 * section, `context.alwaysInclude` injects named instance files into every
 * prompt (capped, contained to the instance home), and leaving all of it unset
 * changes nothing.
 */

// Isolated home BEFORE imports (paths.ts resolves JINN_HOME at module load).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-steering-home-"));
process.env.JINN_HOME = home;

type ContextMod = typeof import("../context.js");
let buildContext: ContextMod["buildContext"];
let ALWAYS_INCLUDE_FILE_CHAR_CAP: ContextMod["ALWAYS_INCLUDE_FILE_CHAR_CAP"];

const LEGACY_MANIFEST =
  "## Knowledge base\nSearch company knowledge in `knowledge/` + `docs/` with `search_knowledge`; `read_knowledge { path }` can read any relative file inside the Jinn instance.";

beforeAll(async () => {
  fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(home, "knowledge", "note.md"), "# Note\n\nbody\n");
  fs.writeFileSync(path.join(home, "knowledge", "state.md"), "# State\n- fact: the current truth\n");
  fs.writeFileSync(path.join(home, "knowledge", "empty.md"), "   \n");
  ({ buildContext, ALWAYS_INCLUDE_FILE_CHAR_CAP } = await import("../context.js"));
});

/** The real prompt for a config carrying the given `context` / `knowledge` blocks. */
function build(
  { context, knowledge }: { context?: Record<string, unknown>; knowledge?: Record<string, unknown> } = {},
  jinnMcpAttached = true,
): string {
  return buildContext({
    source: "web",
    channel: "web:test",
    user: "operator",
    sessionId: "knowledge-steering-session",
    config: {
      gateway: { port: 7777 },
      engines: { default: "codex" },
      context: { maxChars: 1_000_000, ...context },
      ...(knowledge ? { knowledge } : {}),
    } as any,
    jinnMcpAttached,
  });
}

describe("knowledge.guidance", () => {
  it("is appended to the knowledge section of an MCP-attached prompt", () => {
    const out = build({ knowledge: { guidance: "For facts and history use the state files, not search." } });
    expect(out).toContain(`${LEGACY_MANIFEST}\nFor facts and history use the state files, not search.`);
  });

  it("is appended to the file index of a non-attached prompt", () => {
    const out = build({ knowledge: { guidance: "Use the state files." } }, false);
    expect(out).toContain("## Knowledge base\nKnowledge files are in");
    expect(out).toContain("\nUse the state files.");
  });

  it("unset, empty, or blank leaves the prompt byte-identical", () => {
    const base = build();
    expect(base).toContain(LEGACY_MANIFEST);
    expect(build({ knowledge: {} })).toBe(base);
    expect(build({ knowledge: { guidance: "  " } })).toBe(base);
    const bareIndex = build({}, false);
    expect(build({ knowledge: { guidance: "" } }, false)).toBe(bareIndex);
  });
});

describe("context.alwaysInclude", () => {
  it("injects the file's contents into the prompt", () => {
    const out = build({ context: { alwaysInclude: ["knowledge/state.md"] } });
    expect(out).toContain("## Always in context: knowledge/state.md\n# State\n- fact: the current truth");
  });

  it("injects it for non-attached sessions too", () => {
    expect(build({ context: { alwaysInclude: ["knowledge/state.md"] } }, false)).toContain("the current truth");
  });

  it("caps an oversized file and says where it was cut", () => {
    fs.writeFileSync(path.join(home, "knowledge", "big.md"), `# Big\n${"Ω".repeat(ALWAYS_INCLUDE_FILE_CHAR_CAP * 2)}`);
    const out = build({ context: { alwaysInclude: ["knowledge/big.md"] } });
    expect(out).toContain("## Always in context: knowledge/big.md");
    expect(out).toContain(`[Truncated at ${ALWAYS_INCLUDE_FILE_CHAR_CAP} chars — read knowledge/big.md for the rest]`);
    expect(out.split("Ω").length - 1).toBeLessThanOrEqual(ALWAYS_INCLUDE_FILE_CHAR_CAP);
  });

  it("refuses paths that escape the instance home, absolute paths, and symlink escapes", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-steering-outside-"));
    fs.writeFileSync(path.join(outside, "secret.md"), "OUTSIDE-SECRET");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(home, "knowledge", "link.md"));
    const out = build({
      context: { alwaysInclude: ["../" + path.basename(outside) + "/secret.md", path.join(outside, "secret.md"), "knowledge/link.md"] },
    });
    expect(out).not.toContain("OUTSIDE-SECRET");
    expect(out).not.toContain("## Always in context");
  });

  it("skips missing and empty files without failing the prompt", () => {
    const out = build({ context: { alwaysInclude: ["knowledge/nope.md", "knowledge/empty.md", "knowledge/state.md"] } });
    expect(out).not.toContain("knowledge/nope.md");
    expect(out).not.toContain("knowledge/empty.md");
    expect(out).toContain("the current truth");
  });

  it("injects each listed file once", () => {
    const out = build({ context: { alwaysInclude: ["knowledge/state.md", "knowledge/state.md"] } });
    expect(out.split("## Always in context: knowledge/state.md").length - 1).toBe(1);
  });

  it("survives a tight prompt budget as a pointer, ahead of optional sections", () => {
    const out = build({ context: { alwaysInclude: ["knowledge/state.md"], maxChars: 6_000 } });
    expect(out.length).toBeLessThanOrEqual(6_000);
    expect(out).toContain("## Always in context: knowledge/state.md");
  });

  it("unset or empty leaves the prompt byte-identical", () => {
    const base = build();
    expect(build({ context: { alwaysInclude: [] } })).toBe(base);
    expect(base).not.toContain("## Always in context");
  });
});
