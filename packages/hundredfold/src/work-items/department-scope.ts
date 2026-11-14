import { OPERATOR_ASSIGNEE } from "./operator-assignee.js";

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

/**
 * The skills a non-open department offers its sessions (its `department.yaml` allow-list,
 * FR-027), injected beside the scope resolver. `null` means no restriction: an open
 * department, or no resolver.
 */
export type DepartmentSkillsResolver = (department: string) => readonly string[] | null;

let skillsResolver: DepartmentSkillsResolver | null = null;

export function setDepartmentSkillsResolver(next: DepartmentSkillsResolver | null): void {
  skillsResolver = next;
}

/** The skill allow-list of a department; `null` when it is open, has none, or there is no resolver. */
export function departmentSkillAllowList(department: string | null | undefined): readonly string[] | null {
  return department && skillsResolver ? skillsResolver(department) : null;
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
  /** The Todos and holders a stranding refusal names (FR-015), when it is one. */
  readonly holders: ReadonlyArray<{ todo: string; assignee: string }>;
  constructor(message: string, holders: ReadonlyArray<{ todo: string; assignee: string }> = []) {
    super(message);
    this.name = "DepartmentBoundaryError";
    this.holders = holders;
  }
}

/**
 * The department an employee belongs to, by name; `undefined` for a name that is not
 * on the roster. Injected beside the scope resolver, because the work-items layer
 * does not read the org either. With none injected nobody is on the roster, so every
 * name counts as unscoped.
 */
export type EmployeeDepartmentResolver = (employee: string) => string | undefined;

let employeeResolver: EmployeeDepartmentResolver | null = null;

export function setEmployeeDepartmentResolver(next: EmployeeDepartmentResolver | null): void {
  employeeResolver = next;
}

export function employeeDepartment(employee: string): string | undefined {
  return employeeResolver?.(employee);
}

/** What `mayHoldTodo` reads; the stranding checks pass a hypothetical one. */
export interface HoldLookups {
  scopeOf: (department: string | null | undefined) => DepartmentScope;
  departmentOf: (employee: string) => string | undefined;
}

export const LIVE_HOLD_LOOKUPS: HoldLookups = { scopeOf: departmentScope, departmentOf: employeeDepartment };

/**
 * FR-015: whether `assignee` may hold a Todo whose ROOT sits in `rootDepartment`.
 * A scoped employee holds only its own department's Todos; anyone else holds any
 * Todo outside a `dedicated` department; `@operator`, and no assignee at all, always
 * pass. With no resolvers injected every department is open, so everything passes.
 */
export function mayHoldTodo(
  assignee: string | null | undefined,
  rootDepartment: string | null | undefined,
  lookups: HoldLookups = LIVE_HOLD_LOOKUPS,
): boolean {
  if (!assignee || assignee === OPERATOR_ASSIGNEE) return true;
  const own = lookups.departmentOf(assignee);
  if (lookups.scopeOf(own) !== "open") return own === rootDepartment;
  return lookups.scopeOf(rootDepartment) !== "dedicated";
}

/** Why `assignee` may not hold the Todo, for a refusal; null when it may. */
export function holdRefusal(
  assignee: string | null | undefined,
  todoId: string,
  rootDepartment: string | null | undefined,
  lookups: HoldLookups = LIVE_HOLD_LOOKUPS,
): string | null {
  if (mayHoldTodo(assignee, rootDepartment, lookups)) return null;
  const own = lookups.departmentOf(assignee!);
  const where = rootDepartment ? `department "${rootDepartment}"` : "the company";
  if (lookups.scopeOf(own) !== "open") return `${assignee} is confined to department "${own}" and cannot hold ${todoId}, which is in ${where}`;
  return `${todoId} is in dedicated department "${rootDepartment}", which only its own members can hold; ${assignee} is not one`;
}

/** FR-007/FR-008: the department `employee` is confined to, or null when it is not scoped. */
export function scopedDepartmentOf(employee: string | null | undefined): string | null {
  if (!employee) return null;
  const own = employeeDepartment(employee);
  return own && departmentScope(own) !== "open" ? own : null;
}

/** Cron stays company-level in v1: a job may not run as a department-scoped employee. */
export function cronTargetRefusal(employee: string | null | undefined): string | null {
  const department = scopedDepartmentOf(employee);
  return department ? `cron jobs cannot target ${employee}, who is confined to department "${department}"; cron stays company-level` : null;
}

/**
 * Why a session's department binding no longer holds, or null while it does (or the
 * session is not scoped). A binding is fixed at creation (FR-008), so it is lost when
 * the employee has since moved, or its department was opened, or the employee was
 * scoped after the session was created and the session has no binding at all.
 */
export function lostBindingReason(session: { employee?: string | null; scopeDepartment?: string | null }): string | null {
  const live = scopedDepartmentOf(session.employee);
  const bound = session.scopeDepartment ?? null;
  if (bound === live) return null;
  if (bound === null) return `this session of ${session.employee} was created before department "${live}" was scoped, so it has no binding; start a new session`;
  if (live === null) return `this session is bound to department "${bound}", which ${session.employee} is no longer confined to; start a new session`;
  return `this session is bound to department "${bound}", but ${session.employee} is now in department "${live}"; start a new session`;
}

/**
 * FR-002: the department a Todo's scope is decided by, which is its ROOT's. Every scope
 * decision reads this, never a sub-task's own column. `rootOf` looks the root up; a root
 * that cannot be found falls back to the Todo's own department.
 */
export function scopeDepartmentOfItem(
  item: { id: string; rootId: string; department: string | null },
  rootOf: (rootId: string) => { department: string | null } | undefined,
): string | null {
  if (item.rootId === item.id) return item.department;
  const root = rootOf(item.rootId);
  return root ? root.department : item.department;
}
