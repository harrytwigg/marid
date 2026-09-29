import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) } };
});

vi.mock("../../shared/version.js", () => ({
  isStrictSemver: vi.fn((v: string) => /^\d+\.\d+\.\d+$/.test(v)),
  getPackageVersion: vi.fn(() => "1.1.0"),
}));

vi.mock("../../migrations/sync-template-skills.js", () => ({
  syncTemplateSkills: vi.fn(),
}));

import { syncTemplateSkills } from "../../migrations/sync-template-skills.js";
import { runMigrate } from "../migrate.js";

const mockSync = vi.mocked(syncTemplateSkills);
const noChange = { added: [], updated: [], removed: [], backupDir: null };

describe("migrate: sync the skills Marid ships", () => {
  let printed: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => { printed.push(String(line)); });
  });

  it("reports every skill it added, updated, and removed, and where the old copies went", async () => {
    mockSync.mockReturnValue({ added: ["notes"], updated: ["cron-manager"], removed: ["retired"], backupDir: "/home/.migration-backups/1.1.0-x" });

    await runMigrate();

    const output = printed.join("\n");
    expect(output).toContain("added    notes");
    expect(output).toContain("updated  cron-manager");
    expect(output).toContain("removed  retired");
    expect(output).toContain("Synced the skills Marid ships to 1.1.0.");
    expect(output).toContain("/home/.migration-backups/1.1.0-x");
  });

  it("says the instance is already current when nothing moved", async () => {
    mockSync.mockReturnValue(noChange);

    await runMigrate();

    expect(printed.join("\n")).toContain("Already on 1.1.0");
  });

  it("syncs against the shipped template rather than a migration bundle", async () => {
    mockSync.mockReturnValue(noChange);

    await runMigrate();

    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ packageVersion: "1.1.0" }));
  });
});
