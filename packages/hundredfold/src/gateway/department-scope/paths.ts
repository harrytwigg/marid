import path from "node:path";
import { departmentRecord } from "../department-registry.js";
import { departmentStageRoot } from "../department-workdirs.js";

/** The department's generated stage directory (FR-020); Phase 3 fills it. */
export function departmentStageDir(slug: string): string {
  return path.join(departmentStageRoot(), slug);
}

/** FR-018's roots for department `slug`: its working directories and its stage directory. */
export function departmentFileRoots(slug: string): string[] {
  return [...(departmentRecord(slug).definition?.workdirs ?? []), departmentStageDir(slug)];
}
