import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { isEngineExhausted, readEngineHealth, type EngineHealthReading } from "../shared/engine-health.js";
import { rosterClaudeAccounts } from "../shared/engine-limits-accounts.js";
import type { Employee, JinnConfig } from "../shared/types.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { OPERATOR_ASSIGNEE } from "../work-items/assignment.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";
import type { WorkItem } from "../work-items/store.js";

/**
 * The board walk's view of accounts for one tick (spec FR-075): which account
 * a backlog Todo would run on, and whether that account is recorded at its
 * limit. The walk judges each account on its own, so a friend's account about
 * to lapse can be used while the operator's is near its ceiling, and the
 * reverse.
 *
 * A Todo runs on its assignee's account: the assignee's engine (or the Todo's
 * dispatch override, when it names one) and the login that employee runs as.
 * An unassigned Todo is `unrouted`: the Dispatcher picks its employee, so it is
 * judged against the default account, and the exhausted accounts go to the
 * Dispatcher as advice. A child that still lands on an exhausted account waits
 * for that account's own reset (FR-056).
 */

export const UNROUTED = "unrouted";

export interface WalkAccounts {
  /** More than one Claude account is in use: candidates and the snapshot name accounts. */
  multi: boolean;
  /** The account a Todo would run on, or `unrouted`. */
  of(item: Pick<WorkItem, "id" | "assignee">): string;
  label(account: string): string;
  /** Recorded at its limit now. `unrouted` is judged as the default account. */
  exhausted(account: string): boolean;
  /** Every Claude account recorded at its limit, by label. */
  exhaustedLabels(): string[];
}

export interface WalkAccountsDeps {
  config: JinnConfig;
  now: number;
  health?: EngineHealthReading;
  employee?: (name: string) => Employee | undefined;
}

export function walkAccounts(deps: WalkAccountsDeps): WalkAccounts {
  const { config, now } = deps;
  const health = deps.health ?? readEngineHealth();
  const employee = deps.employee ?? ((name: string) => orgRegistry(config).get(name));
  const accounts = rosterClaudeAccounts(config);
  const labels = new Map(accounts.map((account) => [account.key, account.label]));
  const exhausted = (account: string) => isEngineExhausted(health, account === UNROUTED ? DEFAULT_CLAUDE_ACCOUNT : account, new Date(now));
  return {
    multi: accounts.length > 1,
    of(item) {
      if (!item.assignee || item.assignee === OPERATOR_ASSIGNEE) return UNROUTED;
      const assignee = employee(item.assignee);
      if (!assignee) return UNROUTED;
      const engine = getTodoDispatchConfig(item.id)?.engine ?? assignee.engine ?? config.engines.default;
      return accountForEmployee(assignee, engine);
    },
    label: (account) => labels.get(account) ?? account,
    exhausted,
    exhaustedLabels: () => accounts.filter((account) => exhausted(account.key)).map((account) => account.label),
  };
}

/** The exhausted accounts the Dispatcher is told about, only when there is
 *  more than one Claude account: a single-account suffix is unchanged (FR-078). */
export function exhaustedAdvice(config: JinnConfig, now: number = Date.now()): string[] {
  const accounts = walkAccounts({ config, now });
  return accounts.multi ? accounts.exhaustedLabels() : [];
}

/** The snapshot's per-account inputs for one tick. */
export function accountSnapshotInputs(config: JinnConfig, now: number, state: { priorFiveHourByAccount?: Record<string, { resetsAt: number; usedPercent: number; atMs: number }> }) {
  const accounts = walkAccounts({ config, now });
  return {
    todoAccount: (item: { id: string; assignee: string | null }) => accounts.of(item),
    ...(state.priorFiveHourByAccount ? { prior: state.priorFiveHourByAccount } : {}),
  };
}
