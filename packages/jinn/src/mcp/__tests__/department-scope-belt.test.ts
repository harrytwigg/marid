import { describe, expect, it } from "vitest";
import { buildTools } from "../server.js";
import { buildNoteTools } from "../note-tools.js";
import { DEPARTMENT_REFUSED_TOOLS, departmentBelt } from "../department-profile.js";

/**
 * FR-019: a scoped session's manifest omits exactly the tools whose routes are all
 * refused to it, and carries the note tools whether or not Notes are enabled. Any other
 * manifest is `buildTools`'s own.
 */

const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);
const scoped = { JINN_DEPARTMENT: "side-project" } as NodeJS.ProcessEnv;

describe("departmentBelt", () => {
  it("omits exactly the eight refused tools", () => {
    expect([...DEPARTMENT_REFUSED_TOOLS].sort()).toEqual([
      "archive_work_item", "cost_report", "create_label", "get_cron_run_history", "list_cron_jobs", "list_files", "read_file", "send_connector_message",
    ]);
    const full = buildTools({ notesEnabled: true });
    for (const refused of DEPARTMENT_REFUSED_TOOLS) expect(names(full), `${refused} exists in the full manifest`).toContain(refused);
    const belt = departmentBelt(buildTools, { notesEnabled: true }, scoped);
    expect(names(belt)).toEqual(names(full).filter((name) => !DEPARTMENT_REFUSED_TOOLS.has(name)));
    expect(belt).toHaveLength(full.length - 8);
  });

  it("includes the note tools even when Notes are disabled, and keeps list_departments", () => {
    const notes = names(buildNoteTools());
    expect(notes.length).toBeGreaterThan(0);
    expect(names(buildTools({ notesEnabled: false }))).not.toEqual(expect.arrayContaining(notes));
    const belt = names(departmentBelt(buildTools, { notesEnabled: false }, scoped));
    expect(belt).toEqual(expect.arrayContaining(notes));
    expect(belt).toContain("list_departments");
    for (const refused of DEPARTMENT_REFUSED_TOOLS) expect(belt).not.toContain(refused);
  });

  it("leaves the knowledge wording and every other tool as buildTools builds it", () => {
    const wording = { searchOnly: true } as never;
    const plain = buildTools({ notesEnabled: true, knowledge: wording });
    const belt = departmentBelt(buildTools, { notesEnabled: true, knowledge: wording }, scoped);
    const kept = plain.filter((tool) => !DEPARTMENT_REFUSED_TOOLS.has(tool.name));
    expect(belt.map((tool) => [tool.name, tool.description, tool.inputSchema])).toEqual(kept.map((tool) => [tool.name, tool.description, tool.inputSchema]));
  });

  it.each([[true], [false], [undefined]])("is buildTools itself without JINN_DEPARTMENT (notesEnabled %s)", (notesEnabled) => {
    const opts = notesEnabled === undefined ? {} : { notesEnabled };
    for (const env of [{}, { JINN_DEPARTMENT: "" }] as NodeJS.ProcessEnv[]) {
      const belt = departmentBelt(buildTools, opts, env);
      const plain = buildTools(opts);
      expect(belt.map((tool) => [tool.name, tool.description, tool.inputSchema])).toEqual(plain.map((tool) => [tool.name, tool.description, tool.inputSchema]));
    }
  });
});
