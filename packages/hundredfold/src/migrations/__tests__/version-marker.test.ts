import { describe, it, expect } from "vitest";
import jsYaml from "js-yaml";
import { stampVersionInYaml } from "../version-marker.js";

/**
 * The version marker lives in the user-owned config.yaml, which the live gateway
 * hot-reloads. Stamping is a FORMAT-PRESERVING document edit (the `yaml` package):
 * comments and quoting on untouched nodes must survive, EVERY valid shape of
 * `hundredfold.version` must end up correct, and the function must NEVER return text
 * that reads back as a different (or unset) marker — the exact
 * succeeds-while-corrupting failure this replaced.
 */
describe("stampVersionInYaml: format-preserving version stamp", () => {
  /** Unwrap a successful stamp, failing the test if it refused. */
  function okText(res: ReturnType<typeof stampVersionInYaml>): string {
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`expected ok stamp, refused: ${res.reason}`); // narrows the union
    return res.text;
  }

  /** Read hundredfold.version back out of stamped text with an independent parser. */
  function markerOf(text: string): unknown {
    return (jsYaml.load(text) as { hundredfold?: { version?: unknown } } | null)?.hundredfold?.version;
  }

  it("updates the version and preserves comments and odd quoting on other nodes", () => {
    const before = [
      "# top-of-file comment",
      "engines:",
      "  default: claude   # inline comment stays",
      "  claude:",
      "    model: 'opus'",
      "hundredfold:",
      "  # marker for the last applied migration",
      "  version: 0.20.0",
      "  telemetry: false",
      "connectors:",
      '  slack: { token: "xoxb-abc" }',
      "",
    ].join("\n");

    const after = okText(stampVersionInYaml(before, "0.26.0"));

    // The marker is updated and reads back exactly.
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // The old value is gone.
    expect(after).not.toContain("0.20.0");

    // Comments and quoting on untouched nodes survive (the yaml lib may
    // normalize whitespace before an inline comment, so assert the comment text,
    // not byte-exact spacing).
    expect(after).toContain("# top-of-file comment");
    expect(after).toContain("# inline comment stays");
    expect(after).toContain("# marker for the last applied migration");
    expect(after).toContain("model: 'opus'");
    expect(after).toContain('slack: { token: "xoxb-abc" }');
    // Sibling keys are untouched.
    expect(after).toContain("telemetry: false");
  });

  it("appends version into an existing hundredfold block that lacks the key", () => {
    const before = ["hundredfold:", "  telemetry: false", "other:", "  x: 1", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // The new key landed inside the hundredfold block, not under `other:`.
    expect(after.indexOf('version: "0.26.0"')).toBeLessThan(after.indexOf("other:"));
    expect(after).toContain("  telemetry: false");
    expect(after).toContain("  x: 1");
  });

  it("creates a hundredfold block when none exists, keeping the rest intact", () => {
    const before = ["engines:", "  default: claude", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain("engines:");
    expect(after).toContain("  default: claude");
    expect(markerOf(after)).toBe("0.26.0");
    expect(after).toMatch(/hundredfold:\n {2}version: "0\.26\.0"\n$/);
  });

  it("creates the hundredfold block from a completely empty file", () => {
    const after = okText(stampVersionInYaml("", "0.26.0"));
    expect(after).toBe('hundredfold:\n  version: "0.26.0"\n');
    expect(markerOf(after)).toBe("0.26.0");
  });

  it("updates a CRLF file (line endings may normalize to LF, marker still correct)", () => {
    const before = "hundredfold:\r\n  version: 0.20.0\r\n";
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
  });

  // Round-3 QA HIGH: version written as a PARENT key (its value is a nested map).
  // The old text patcher wrote `version: "0.26.0"` then left the orphaned deeper-
  // indented `major: 0` behind → invalid YAML that read back as 0.0.0 while
  // exiting 0. setIn collapses the whole map to the scalar — no orphan survives.
  it("collapses a version-as-parent-key map to the scalar with no orphaned children", () => {
    const before = ["hundredfold:", "  version:", "    major: 0", "  telemetry: false", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain('version: "0.26.0"');
    expect(after).not.toContain("major: 0"); // the orphan is gone
    expect(after).toContain("telemetry: false");
    // Crucially, the output is valid YAML and the marker reads back exactly.
    expect(markerOf(after)).toBe("0.26.0");
  });

  it("collapses a version parent-key that has a comment then a deeper child", () => {
    const before = ["hundredfold:", "  version: # stale", "    major: 0", "  telemetry: false", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).not.toContain("major: 0");
    expect(after).toContain("telemetry: false");
    expect(markerOf(after)).toBe("0.26.0");
  });

  // Round-3 HIGH → now IMPROVED: an inline/flow `hundredfold: { … }` UPDATES in place
  // (the document model edits the flow mapping) rather than refusing.
  it("updates an inline/flow hundredfold mapping in place", () => {
    const before = 'hundredfold: { version: "0.20.0", telemetry: false }\nother: 1\n';
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // Still a single hundredfold key, sibling preserved, unrelated key intact.
    expect((after.match(/^hundredfold:/gm) ?? []).length).toBe(1);
    expect(after).toContain("telemetry: false");
    expect(after).toContain("other: 1");
  });

  // A nested `metadata.version` must NEVER be mistaken for the marker — only the
  // DIRECT `hundredfold.version` child is the marker.
  it("adds a direct-child version and leaves a nested metadata.version untouched", () => {
    const before = [
      "hundredfold:",
      "  metadata:",
      "    version: custom-metadata",
      "  telemetry: false",
      "",
    ].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));

    // The nested value is preserved verbatim.
    expect(after).toContain("    version: custom-metadata");
    // The direct-child hundredfold.version is what reads back — not the nested one.
    expect(markerOf(after)).toBe("0.26.0");
    expect(after).toContain('version: "0.26.0"');
  });

  it("REFUSES (no text) when the config isn't valid YAML — a tab-indented file", () => {
    const before = "hundredfold:\n\tversion: 0.20.0\n";
    const res = stampVersionInYaml(before, "0.26.0");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toMatch(/valid YAML|parse|tab/i);
  });

  it("REFUSES a hundredfold.version written as a YAML anchor referenced by an alias", () => {
    // Replacing the anchored node orphans the `*v` alias; serialization throws
    // and the stamper refuses rather than emit broken YAML.
    const before = "hundredfold:\n  version: &v 0.20.0\nrefs:\n  x: *v\n";
    const res = stampVersionInYaml(before, "0.26.0");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.reason).toMatch(/anchor|alias|serialize/i);
  });

  it("does not confuse a `versioning:` sibling key for `version:`", () => {
    const before = ["hundredfold:", "  versioning: semver", "  telemetry: false", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain("versioning: semver"); // untouched
    expect(after).toContain('version: "0.26.0"'); // added as a new direct child
    expect(markerOf(after)).toBe("0.26.0");
  });

  // MEDIUM (a): an empty `hundredfold:` (null value) is a sane user shape — the marker
  // just hasn't been written yet. setIn can't descend into a null scalar, so we
  // materialize an empty map first and SET the version (success, not refusal).
  it("treats an empty `hundredfold:` (null value) as an empty block and sets the version", () => {
    const after = okText(stampVersionInYaml("hundredfold:\n", "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0"); // valid YAML out (independent parse)
  });

  it("sets the version on an empty `hundredfold:` that has sibling keys after it", () => {
    const before = ["hundredfold:", "other:", "  x: 1", ""].join("\n");
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(markerOf(after)).toBe("0.26.0");
    // The new key landed under hundredfold, not merged into `other:`.
    expect(after.indexOf('version: "0.26.0"')).toBeLessThan(after.indexOf("other:"));
    expect(after).toContain("  x: 1");
  });

  // MEDIUM (b): a genuinely non-collection `hundredfold` (a non-null scalar) can't hold
  // a version child. setIn throws; the stamper must REFUSE cleanly (no throw
  // escapes) so both call sites stay on their no-stack-trace paths.
  it("REFUSES cleanly (no throw) when `hundredfold` is a non-null scalar like `false`", () => {
    let res: ReturnType<typeof stampVersionInYaml>;
    expect(() => {
      res = stampVersionInYaml("hundredfold: false\n", "0.26.0");
    }).not.toThrow();
    expect(res!.ok).toBe(false);
    if (res!.ok) throw new Error("expected refusal");
    expect(res!.reason).toMatch(/hundredfold|mapping|collection/i);
  });

  it("REFUSES cleanly when `hundredfold` is a sequence, not a mapping", () => {
    const before = ["hundredfold:", "  - a", "  - b", ""].join("\n");
    let res: ReturnType<typeof stampVersionInYaml>;
    expect(() => {
      res = stampVersionInYaml(before, "0.26.0");
    }).not.toThrow();
    expect(res!.ok).toBe(false);
  });

  // LOW: an inline comment attached to the version VALUE node is dropped by a
  // naive setIn (which replaces the value wholesale). Carry it onto the new
  // scalar so it survives like every other comment does.
  it("preserves an inline comment attached to the version value", () => {
    const before = "hundredfold:\n  version: '0.20.0' # version inline comment\nother: 1\n";
    const after = okText(stampVersionInYaml(before, "0.26.0"));
    expect(after).toContain('version: "0.26.0"');
    expect(after).toContain("# version inline comment");
    expect(markerOf(after)).toBe("0.26.0");
    expect(after).toContain("other: 1");
  });
});
