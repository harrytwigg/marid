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
  // Optional index content for the trim-order test; seeded before the index is first cached.
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(home, "knowledge", `filler-${i}.md`), `# F${i}\n`);
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

  it("refuses credential stores: secrets/, config.yaml and anything that is not Markdown", () => {
    fs.mkdirSync(path.join(home, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(home, "secrets", "api-keys.json"), '{"k":"CRED-JSON"}');
    fs.writeFileSync(path.join(home, "secrets", "notes.md"), "CRED-MD");
    fs.writeFileSync(path.join(home, "config.yaml"), "token: CRED-YAML\n");
    const out = build({
      context: { alwaysInclude: ["secrets/api-keys.json", "secrets/notes.md", "SECRETS/notes.md", "ſecrets/notes.md", "config.yaml"] },
    });
    expect(out).not.toMatch(/CRED-(JSON|MD|YAML)/);
    expect(out).not.toContain("## Always in context");
  });

  it("checks the RESOLVED file: symlinks into secrets/ and dot-directories are refused", () => {
    // knowledge/ is writable by agents, so a listed name can be turned into a symlink after the fact.
    fs.mkdirSync(path.join(home, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(home, "secrets", "api-keys.json"), '{"k":"CRED-JSON"}');
    fs.writeFileSync(path.join(home, "secrets", "notes.md"), "CRED-MD");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "x.md"), "CRED-DOT");
    fs.mkdirSync(path.join(home, "knowledge", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(home, "knowledge", ".hidden", "h.md"), "CRED-HIDDEN");
    fs.symlinkSync(path.join(home, "secrets", "api-keys.json"), path.join(home, "knowledge", "keys.md"));
    fs.symlinkSync(path.join(home, "secrets"), path.join(home, "knowledge", "s"));
    fs.symlinkSync(path.join(home, ".claude", "x.md"), path.join(home, "knowledge", "dot.md"));
    const out = build({
      context: {
        alwaysInclude: ["knowledge/keys.md", "knowledge/s/notes.md", "knowledge/dot.md", ".claude/x.md", "knowledge/.hidden/h.md"],
      },
    });
    expect(out).not.toMatch(/CRED-(JSON|MD|DOT|HIDDEN)/);
    expect(out).not.toContain("## Always in context");
  });

  it("accepts Markdown under docs/ as well as knowledge/, and a symlink that stays inside its root", () => {
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "x.md"), "DOCS-OK");
    fs.symlinkSync(path.join(home, "knowledge", "state.md"), path.join(home, "knowledge", "state-alias.md"));
    const out = build({ context: { alwaysInclude: ["docs/x.md", "knowledge/state-alias.md"] } });
    expect(out).toContain("## Always in context: docs/x.md\nDOCS-OK");
    expect(out).toContain("## Always in context: knowledge/state-alias.md\n# State");
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

  it("falls back to a pointer when the prompt budget cannot hold the file", () => {
    fs.writeFileSync(path.join(home, "knowledge", "wide.md"), `# Wide\n${"Ψ".repeat(9_000)}`);
    const out = build({ context: { alwaysInclude: ["knowledge/wide.md"], maxChars: 6_000 } });
    expect(out.length).toBeLessThanOrEqual(6_000);
    expect(out).toContain("## Always in context: knowledge/wide.md\nRead `knowledge/wide.md` before acting");
    expect(out).not.toContain("Ψ");
  });

  it("keeps the file whole when a small overage is cured by trimming optional content", () => {
    const opts = { context: { alwaysInclude: ["knowledge/state.md"] } };
    const full = build(opts, false);
    expect(full).toContain("filler-59.md");
    const tight = build({ context: { ...opts.context, maxChars: full.length - 10 } }, false);
    expect(tight.length).toBeLessThanOrEqual(full.length - 10);
    expect(tight).toContain("- fact: the current truth");
    expect(tight).not.toContain("Read `knowledge/state.md` before acting");
  });

  it("unset or empty leaves the prompt byte-identical", () => {
    const base = build();
    expect(build({ context: { alwaysInclude: [] } })).toBe(base);
    expect(base).not.toContain("## Always in context");
  });
});
