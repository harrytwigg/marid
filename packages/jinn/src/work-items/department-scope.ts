/** How far a department confines its members and its Todos (`department.yaml`). */
export type DepartmentScope = "open" | "scoped" | "dedicated";

/**
 * What the work-items layer knows about department scope. The layer does not read
 * `department.yaml` or the org roster: the gateway injects a resolver at boot that
 * answers "what is this department's effective scope?". With none injected every
 * department is open, so a configless home, a test, and an instance with no
 * `department.yaml` behave exactly as before.
 */
export type DepartmentScopeResolver = (department: string) => DepartmentScope;

let resolver: DepartmentScopeResolver | null = null;

export function setDepartmentScopeResolver(next: DepartmentScopeResolver | null): void {
  resolver = next;
}

/** The effective scope of a department; `open` for no department or no resolver. */
export function departmentScope(department: string | null | undefined): DepartmentScope {
  if (!department || !resolver) return "open";
  return resolver(department);
}

export function isNonOpenDepartment(department: string | null | undefined): boolean {
  return departmentScope(department) !== "open";
}

/** A Todo write that would cross a non-open department's boundary. */
export class DepartmentBoundaryError extends Error {
  readonly code = "department-boundary";
  constructor(message: string) {
    super(message);
    this.name = "DepartmentBoundaryError";
  }
}
