/**
 * `gateway.todoDepartments` (JIN-1): a closed set of Todo departments.
 *
 * Unset keeps the open behaviour — any slug a writer names becomes a
 * department, and assignment moves a Todo into the assignee's org department.
 * Set, it makes the Todo department a classification the operator owns rather
 * than a side effect of who happens to be working on it:
 *
 * - create and the metadata pen accept only `allowed` slugs (or null);
 * - a create that names none lands in `default` (when set) instead of the
 *   company namespace;
 * - assignment and delegation leave the department alone.
 */
export interface TodoDepartmentsConfig {
  allowed: string[];
  default?: string;
}

export interface TodoDepartmentPolicy {
  allowed: readonly string[];
  defaultDepartment: string | null;
}

/** Same grammar the slugs already in the registry follow. */
const SLUG = /^[a-z][a-z0-9-]*$/;

function allowedProblems(allowed: unknown): string[] {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return ["gateway.todoDepartments.allowed must be a non-empty list of department slugs"];
  }
  const problems = allowed
    .filter((slug) => typeof slug !== "string" || !SLUG.test(slug))
    .map((slug) => `gateway.todoDepartments.allowed entries must be lowercase kebab-case slugs (got ${JSON.stringify(slug)})`);
  if (new Set(allowed).size !== allowed.length) problems.push("gateway.todoDepartments.allowed must not repeat a slug");
  return problems;
}

/** Shape-check `gateway.todoDepartments`. Unset is valid (open departments). */
export function todoDepartmentsProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["gateway.todoDepartments must be a mapping"];
  }
  const { allowed, default: fallback } = value as { allowed?: unknown; default?: unknown };
  const problems = allowedProblems(allowed);
  if (fallback !== undefined && !(Array.isArray(allowed) && allowed.includes(fallback))) {
    problems.push(`gateway.todoDepartments.default must be one of gateway.todoDepartments.allowed (got ${JSON.stringify(fallback)})`);
  }
  return problems;
}

/** The runtime policy, or null when departments are open. Assumes the config
 *  already passed `todoDepartmentsProblems` (loadConfig refuses it otherwise). */
export function resolveTodoDepartmentPolicy(value: TodoDepartmentsConfig | undefined): TodoDepartmentPolicy | null {
  if (!value) return null;
  return { allowed: [...value.allowed], defaultDepartment: value.default ?? null };
}

export class TodoDepartmentNotAllowedError extends Error {
  readonly allowed: readonly string[];

  constructor(department: string, allowed: readonly string[]) {
    super(`department "${department}" is not one of the configured Todo departments: ${allowed.join(", ")}`);
    this.name = "TodoDepartmentNotAllowedError";
    this.allowed = allowed;
  }
}

/** Refuse a department the policy does not list. Null (no department) and an
 *  open policy always pass. */
export function assertTodoDepartmentAllowed(policy: TodoDepartmentPolicy | null, department: string | null): void {
  if (!policy || department === null) return;
  if (!policy.allowed.includes(department)) throw new TodoDepartmentNotAllowedError(department, policy.allowed);
}
