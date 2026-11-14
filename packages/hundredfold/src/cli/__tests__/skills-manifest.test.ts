import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// House pattern (TESTING.md): own tmp home, HUNDREDFOLD_HOME set BEFORE anything that
// reads paths.ts is imported, then a dynamic import of the module under test.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-skills-manifest-"));
process.env.HUNDREDFOLD_HOME = HOME;

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE_MANIFEST = path.join(PKG, "template", "skills.json");
const MANIFEST = path.join(HOME, "skills.json");
const SKILLS_DIR = path.join(HOME, "skills");

let skills: typeof import("../skills.js");

/** Command entry paths print; keep the suite output readable. */
function silence(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeAll(async () => {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  skills = await import("../skills.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(MANIFEST, { recursive: true, force: true });
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    fs.rmSync(path.join(SKILLS_DIR, entry), { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe("skills.json has one owner: the flat SkillManifestEntry[] array", () => {
  it("T1: reads the shipped template seed as a usable manifest", () => {
    expect(fs.readFileSync(TEMPLATE_MANIFEST, "utf-8").trim()).toBe("[]");
    fs.copyFileSync(TEMPLATE_MANIFEST, MANIFEST);

    expect(skills.readManifest()).toEqual([]);
    skills.upsertManifest("demo", "owner/repo@demo");
    expect(skills.readManifest().map((e) => e.name)).toEqual(["demo"]);
  });

  it("T2: degrades any non-array shape to [] with one warning naming the file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacyShapes = [
      { installed: {} },
      { installed: { demo: { source: "owner/repo@demo", installedAt: "2026-01-01T00:00:00.000Z" } } },
    ];

    for (const legacy of legacyShapes) {
      warn.mockClear();
      fs.writeFileSync(MANIFEST, JSON.stringify(legacy, null, 2));

      expect(skills.readManifest()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain(MANIFEST);
      expect(message).toContain("array");
    }
  });

  it("T3: upsert/remove round-trips on a legacy home without a TypeError", () => {
    silence();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(MANIFEST, JSON.stringify({ installed: {} }, null, 2));
    fs.mkdirSync(path.join(SKILLS_DIR, "legacy-skill"), { recursive: true });

    expect(() => skills.skillsList()).not.toThrow();
    // update/restore early-return on an empty manifest, so no npx is spawned.
    expect(() => skills.skillsUpdate()).not.toThrow();
    expect(() => skills.skillsRestore()).not.toThrow();
    // The manifest half of `skills add`; its npx spawn is out of unit scope.
    expect(() => skills.upsertManifest("legacy-skill", "owner/repo@legacy-skill")).not.toThrow();
    expect(skills.readManifest().map((e) => e.name)).toEqual(["legacy-skill"]);

    expect(() => skills.skillsRemove("legacy-skill")).not.toThrow();
    expect(skills.readManifest()).toEqual([]);
    expect(fs.existsSync(path.join(SKILLS_DIR, "legacy-skill"))).toBe(false);
  });

  it("T4: a failed manifest write leaves the skill directory intact", () => {
    silence();
    const skillDir = path.join(SKILLS_DIR, "ordering-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    skills.upsertManifest("ordering-skill", "owner/repo@ordering-skill");

    // Reproduces the EISDIR a directory-shaped skills.json raises on write: the
    // manifest update has to run first, so removal aborts before any rmSync.
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EISDIR: illegal operation on a directory, write"), {
        code: "EISDIR",
      });
    });

    expect(() => skills.skillsRemove("ordering-skill")).toThrow(/EISDIR/);
    vi.restoreAllMocks();

    expect(fs.existsSync(skillDir)).toBe(true);
    expect(skills.readManifest().map((e) => e.name)).toEqual(["ordering-skill"]);
  });
});
