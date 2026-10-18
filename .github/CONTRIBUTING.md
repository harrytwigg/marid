# Contributing to Jinn

Thanks for your interest in contributing. This guide covers the basics.

Read [AGENTS.md](../AGENTS.md) before opening a pull request. It is the review rubric this
repository is judged against -- how to verify a ticket's premise, which extension point to
reach for, what makes a test worth keeping, and what a plan has to show.

## Prerequisites

- Node.js **24.13.0**, pinned by `.nvmrc` (`package.json` requires `>=24 <25`). Native modules
  such as `better-sqlite3` are ABI-locked, so a different major will fail to load.
- pnpm 10.6+
- At least one engine CLI, e.g. [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  (`npm install -g @anthropic-ai/claude-code`)

## Development Setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Initialize Jinn (one-time - builds all packages and creates the instance home at `~/.jinn`):
   ```bash
   pnpm setup
   ```
   This is safe to re-run; it skips files that already exist.
4. Start development mode:
   ```bash
   pnpm dev
   ```
   This runs the gateway (port from your instance `config.yaml`, 7777 by default) alongside the
   Vite dev server for the web dashboard.
5. Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` and `/ws` through to
   the gateway; set `GATEWAY_PORT` if yours does not run on 7777.

## Submitting Pull Requests

- Create a feature branch from `main`.
- Keep commits focused and descriptive.
- Run all four gates before submitting. Each one runs as a CI job, so a failure here is a
  failure there:
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  ```
  `pnpm test` also runs on Windows in CI; if you touch filesystem paths or process spawning,
  expect that leg to have an opinion.
  Locally `pnpm test` runs at the lowest scheduling priority available (`nice 19` and, on Linux,
  the `ionice` idle class), so it yields to whatever else you are doing; set `JINN_TEST_NICE=0`
  for a normal-priority run. Each vitest suite leases up to eight workers from a core pool shared
  by every run on the machine (cores minus 12, never fewer than 8; `JINN_TEST_GLOBAL_CORES`,
  `JINN_TEST_RUN_CORES` and `JINN_TEST_RESERVED_CORES` tune it, `JINN_TEST_GLOBAL_CORES=0`
  turns it off) and waits when the pool is empty. CI is unaffected — turbo is serial and vitest
  is capped at two workers there.
- Branch protection on `main` requires exactly one status check: `all-checks-pass`. It needs
  every other job in `.github/workflows/ci.yml` and passes only when all of them report
  `success` — a skipped or cancelled job counts as a failure, because it proved nothing.
  Individual jobs are never added to the required list, so **a new CI job has to be added to
  that job's `needs`**, and `scripts/__tests__/ci-workflow.test.mjs` fails the build if it is
  not.
- Open a pull request against `main` with a clear description of your changes.

## Code Style

- TypeScript with strict mode enabled.
- ESM modules (no CommonJS).
- Tailwind CSS for styling in the web package.
- Follow existing patterns in the codebase.

## Footgun Checks

CI runs `scripts/check-footguns.mjs` over the lines your change **adds**. It
covers six things this project has actually shipped by accident: an absolute
`/Users/` path, a `.jinn` home built from `os.homedir()` instead of
`resolveJinnHome()`, an email on a real domain, a literal `7777`/`7788` port, a
`process.env` read outside the config layer, and a `child_process` spawn with no
explicit `stdio`. Each finding prints the fix.

- `pnpm footguns` checks your branch against `origin/main`.
- `node scripts/check-footguns.mjs --staged` checks what you are about to commit.
- `node scripts/check-footguns.mjs --all` audits the whole tree, including the
  debt that predates the check. CI never reads that debt.
- `node scripts/check-footguns.mjs --list` prints the six rules and their fixes.

Suppress a single line by ending it with `// footgun: ok <reason>` (or
`# footgun: ok <reason>` in YAML and shell). The reason is the point — a
suppression without one still suppresses, but the run lists it as unaudited, so
`git grep 'footgun: ok'` stays a document rather than noise.

The privacy rule ships structural checks only. A committed list of real names
would itself be the leak, so personal terms are read at run time from
`scripts/.footgun-terms.local` (gitignored) or from `$FOOTGUN_TERMS_FILE`.

## Project Layout

- `packages/jinn` -- Core gateway daemon and CLI (package dir).
- `packages/web` -- Web dashboard frontend.
- `packages/gateway-events` -- Shared event contract between the gateway and the dashboard.

## Questions?

Open an issue on GitHub if you have questions or run into problems.
