import { getSession } from "./registry.js";

/** The variable naming the employee a session runs as, in every process of that session. */
export const HUNDREDFOLD_EMPLOYEE_ENV = "HUNDREDFOLD_EMPLOYEE";

/** `HUNDREDFOLD_EMPLOYEE` for a session that has an employee; nothing for any other session. */
export function employeeSessionEnv(sessionId: string | undefined): Record<string, string> {
  const employee = sessionId ? getSession(sessionId)?.employee : null;
  return employee ? { [HUNDREDFOLD_EMPLOYEE_ENV]: employee } : {};
}
