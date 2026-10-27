import { declaredClaudeAccounts, type DeclaredClaudeAccount } from "../shared/claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { scopedDepartmentOf } from "../work-items/department-scope.js";
import type { Employee, JinnConfig } from "../shared/types.js";

/**
 * Starting a session on a declared Claude account instead of its employee's own
 * login. The choice rides on the `engine` string a request already carries:
 * `claude:<name>` names `engines.claude.accounts.<name>`, the spelling a fallback
 * chain entry already uses, and every bare engine name keeps meaning what it did.
 * It is made at creation only; the session stores the account's canonical
 * directory (`sessions.claude_config_dir`), and `session-account.ts` reads it
 * wherever it used to read the employee's.
 */

const PREFIX = `${DEFAULT_CLAUDE_ACCOUNT}:`;

export type PrimaryEngine =
  | { ok: true; engine: string; profile?: DeclaredClaudeAccount }
  | { ok: false; status: 400 | 403; error: string };

/** Whether an engine string names a Claude profile rather than an engine. */
export function namesClaudeProfile(raw: unknown): raw is string {
  return typeof raw === "string" && raw.trim().startsWith(PREFIX);
}

/** `claude:<name>` as the engine and the declared account it names, or why it names none; a bare engine passes through. */
export function parsePrimaryEngine(config: Pick<JinnConfig, "engines">, raw: string): PrimaryEngine {
  const value = raw.trim();
  if (!value.startsWith(PREFIX)) return { ok: true, engine: value };
  const name = value.slice(PREFIX.length).trim();
  const declared = declaredClaudeAccounts(config);
  const profile = declared.find((account) => account.name === name);
  if (profile) return { ok: true, engine: DEFAULT_CLAUDE_ACCOUNT, profile };
  const known = declared.map((account) => account.name);
  return {
    ok: false,
    status: 400,
    error: `unknown Claude profile "${name}" for engine "${value}" — ${known.length > 0
      ? `declared profiles: ${known.join(", ")}`
      : "no Claude profiles are declared under engines.claude.accounts"}`,
  };
}

type RequestContext = { employee?: Employee; scopedCaller?: boolean; operatorCaller?: boolean };

/** Why this caller may not start this employee on a declared profile of this machine, or undefined when it may. */
function profileRefusal(profile: DeclaredClaudeAccount, context: RequestContext): Extract<PrimaryEngine, { ok: false }> | undefined {
  const { employee } = context;
  const department = context.operatorCaller ? null : scopedDepartmentOf(employee?.name);
  if (department) {
    return { ok: false, status: 403, error: `employee "${employee!.name}" belongs to the department-scoped "${department}"; only the operator can start it on another Claude profile` };
  }
  if (isRemoteTarget(employee)) {
    return { ok: false, status: 400, error: `employee "${employee.name}" runs on a remote host and uses that host's Claude login; it cannot start on the local profile "${profile.name}"` };
  }
  return undefined;
}

/**
 * `parsePrimaryEngine` for a request that creates a session, with the refusals that depend on who asks and for whom:
 * a department-scoped caller never picks a profile (its department's separate allowance is not its to spend elsewhere);
 * nor does anyone but the operator pick one for a member of a scoped department, since an unscoped agent (the
 * dispatcher working that department's Todo, say) would otherwise move the department off its own account; and a
 * remote employee runs on its host's own login, which a profile of this machine cannot replace.
 */
export function resolvePrimaryEngine(config: Pick<JinnConfig, "engines">, raw: string, context: RequestContext): PrimaryEngine {
  // Before the lookup: a scoped caller is not told which profiles exist.
  if (namesClaudeProfile(raw) && context.scopedCaller) {
    return { ok: false, status: 403, error: "a department-scoped session cannot start a session on another Claude profile" };
  }
  const parsed = parsePrimaryEngine(config, raw);
  return (parsed.ok && parsed.profile ? profileRefusal(parsed.profile, context) : undefined) ?? parsed;
}
