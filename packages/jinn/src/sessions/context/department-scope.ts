import fs from "node:fs";
import path from "node:path";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import type { OrgHierarchy } from "../../shared/types.js";
import { getSession } from "../registry.js";
import { departmentSkillAllowList, scopedDepartmentOf } from "../../work-items/department-scope.js";

/**
 * The prompt of a department-scoped session (FR-014, FR-029): its roster shows only
 * its department's members, as the org tools do, and a section says what the scope
 * means. Unscoped sessions are untouched.
 */

interface ScopeInputs {
  sessionId?: string;
  employee?: { name: string; remoteHost?: string; remoteCwd?: string };
  hierarchy?: OrgHierarchy;
}

export function promptDepartment(opts: ScopeInputs): string | null {
  if (!opts.employee) return null;
  const bound = opts.sessionId ? getSession(opts.sessionId)?.scopeDepartment : null;
  return bound ?? scopedDepartmentOf(opts.employee.name);
}

/** The hierarchy narrowed to `department`'s members: anyone else, a manager included, is left out. */
export function departmentHierarchy(hierarchy: OrgHierarchy, department: string): OrgHierarchy {
  const members = new Set(Object.values(hierarchy.nodes).filter((node) => node.employee.department === department).map((node) => node.employee.name));
  const nodes = Object.fromEntries(
    [...members].map((name) => {
      const node = hierarchy.nodes[name];
      return [name, {
        ...node,
        parentName: node.parentName && members.has(node.parentName) ? node.parentName : null,
        directReports: node.directReports.filter((report) => members.has(report)),
        chain: node.chain.filter((link) => members.has(link)),
      }];
    }),
  );
  return { root: hierarchy.root && members.has(hierarchy.root) ? hierarchy.root : null, nodes, sorted: hierarchy.sorted.filter((name) => members.has(name)), warnings: [] };
}

/** `opts` with its roster narrowed to the session's department, when it is scoped. */
export function withDepartmentScope<T extends ScopeInputs>(opts: T): T {
  const department = promptDepartment(opts);
  return department && opts.hierarchy ? { ...opts, hierarchy: departmentHierarchy(opts.hierarchy, department) } : opts;
}

/**
 * The skills the department offers (FR-027): its allow-list, narrowed to the copies the stage
 * directory actually holds once it exists (a skill the generator refused is not there,
 * and when every one was refused there is no `.claude/skills` at all).
 */
function departmentSkills(department: string): readonly string[] {
  const allowed = departmentSkillAllowList(department) ?? [];
  const stage = departmentStageDir(department);
  return fs.existsSync(stage) ? allowed.filter((name) => fs.existsSync(path.join(stage, ".claude", "skills", name, "SKILL.md"))) : allowed;
}

function departmentSkillsLine(department: string): string {
  const skills = departmentSkills(department);
  return skills.length > 0 ? `Company skills available to you: ${skills.join(", ")} (in \`.claude/skills/\`). No other company skill is offered.` : "No company skills are offered to this department.";
}

/**
 * On a remote host the session's cwd is the department's stage directory, which the whole
 * department shares and every spawn resyncs, so it is told where its own work goes (FR-061).
 */
function workAreaLines(employee: ScopeInputs["employee"]): string[] {
  if (!employee?.remoteHost || !employee.remoteCwd) return [];
  return [`- You run on ${employee.remoteHost}. Your working directory is the department's stage directory, which is rewritten before every session starts: do your work in your work area, \`${employee.remoteCwd}\`.`];
}

/** The section that tells a scoped session what its scope is. Empty for anyone else. */
export function departmentScopeSections(opts: ScopeInputs): Array<{ tier: number; required: true; marker: string; content: string }> {
  const department = promptDepartment(opts);
  if (!department) return [];
  const content = [
    "## Department scope",
    `This session is scoped to department **${department}**. The jinn tools reach only this department: its Todos, its members, sessions bound to it, and its Notes under \`knowledge/departments/${department}/\`. Everything else answers as not found or refused.`,
    `- Create and work Todos in ${department} only; delegate and spawn only to its members. You may reply to the session that asked you for work.`,
    "- Use the jinn tools for company state. Do not use your shell to read the Jinn home, other repositories, or other sessions' transcripts.",
    `- Keep your working state in \`knowledge/departments/${department}/state.md\` through the note tools.`,
    `- ${departmentSkillsLine(department)}`,
    ...workAreaLines(opts.employee),
  ].join("\n");
  return [{ tier: 0, required: true, marker: "## Department scope", content }];
}
