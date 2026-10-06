import path from "node:path";
import { resolveJinnHome } from "../../shared/paths.js";
import type { Employee } from "../../shared/types.js";
import type { DepartmentScope } from "../../work-items/department-scope.js";
import { departmentScopeOf } from "../department-registry.js";
import { departmentDisagreement, scopedEmployeeRefusal } from "../org-department-check.js";
import { employeeYamlPaths } from "../org-yaml-files.js";

/**
 * The employees a department scope change would drop from the roster, each with the
 * reason the next org scan would give. The scan refuses an employee whose directories
 * and `department` field disagree about a non-open department (FR-007), and a scoped
 * employee on another engine or a remote host (FR-026); either can follow from scoping a
 * department, for its members and for anyone whose file sits under its directory. A
 * change through the API is refused while any would be dropped, rather than the
 * employee vanishing from the roster at the next scan.
 */
export function droppedByScopeChange(slug: string, scope: DepartmentScope, roster: Iterable<Employee>): Array<{ name: string; reason: string }> {
  const orgDir = path.join(resolveJinnHome(), "org");
  const files = employeeYamlPaths(orgDir);
  const scopeOf = (department: string) => (department === slug ? scope : departmentScopeOf(department));
  const dropped: Array<{ name: string; reason: string }> = [];
  for (const employee of roster) {
    const file = files.get(employee.name);
    const reason = (file ? departmentDisagreement(orgDir, file, employee.department, scopeOf) : null) ?? scopedEmployeeRefusal(employee, scopeOf);
    if (reason) dropped.push({ name: employee.name, reason });
  }
  return dropped;
}
