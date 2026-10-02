# Cron

Cron jobs are simple scheduled prompts stored in `$JINN_HOME/cron/jobs.json`. The gateway validates and hot-reloads the array. Use `skills/cron-manager/SKILL.md` for creation, mutation, validation, delivery, and run-history procedure.

## Job contract

```typescript
interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  effortLevel?: string;
  employee?: string;
  prompt: string;
  delivery?: { connector: string; channel: string };
  action?: "board-walk";
}
```

`delivery.connector` is a connector instance id, for example `slack` or `slack-support`.

`action` makes the job run a built-in gateway action instead of a prompt. The shipped `board-walk` job (`"action": "board-walk"`) is when the board walk runs: run it now, reschedule it or disable it like any job; its rules stay in `board-walk.md`. An action job has an empty `prompt`, ignores `engine`, `model`, `employee` and `delivery`, mints no Todo per fire, and records each fire in its run history. Only one job may carry an action. Deleting the `board-walk` job is permanent (it is not re-created), so disable it to stop the walk.

`schedule` uses standard five-field cron syntax. `timezone` is an IANA timezone; when omitted, the system timezone applies. Engine values are claude, codex, antigravity, grok, pi, hermes, opencode. A model override must be supported by its engine.

## Delivery ownership

Analytical, reporting, or decision-informing output should target the COO. The COO delegates specialist work, reviews it, and produces the final deliverable. Direct employee delivery is reserved for simple output that does not need review.

Use the cron read tools for current definitions and run evidence. Local run logs are implementation detail, not the normal operating surface.
