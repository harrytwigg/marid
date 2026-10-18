import { defineConfig } from 'vitest/config'

// GitHub Actions (and most CI providers) set CI=true. The hosted runners are
// far smaller than a dev machine (few slow vCPUs, limited memory), and a large
// slice of this suite spins up REAL gateway servers, worker threads, and PTY
// proxies that bind real (ephemeral) ports. Under high fork parallelism those
// heavy integration tests pile onto the same starved cores, and operations that
// finish in milliseconds locally blow past the default 5s test / 10s hook
// timeouts on CI — producing cascading "step-timeout" / "socket lost" failures.
//
// So we scale vitest down in CI: fewer concurrent forks (less peak CPU/mem
// contention) and generous timeouts (slow-but-correct boots don't get killed).
//
// Locally the forks are capped too, at four. Full parallelism was measured on this
// repo's shared build machine and did not survive it: with ~60 forks on 64 cores
// alongside other worktrees' suites (load average 52-132), jsdom files blew their
// 20s budget in four of five runs and one run lost 122 files to 30s hook timeouts
// on `await import("../api.js")`. The upstream `--maxWorkers=2` cap was there for
// stability and it was right about the shape of the problem; four rather than two
// is the throughput the machine was asked for. scripts/low-priority.mjs is what
// makes the cap affordable at all — the workers yield to whatever else is running
// instead of having to be throttled to nothing.
//
// A niced run also widens the timeouts. nice 19 in the idle I/O class means 5s is
// no longer generous on a core something else is using, and a false red at nice 19
// is worse than a slow green. That wrapper sets JINN_TEST_LOW_PRIORITY, so the
// widening follows the priority rather than the environment.
const isCI = !!process.env.CI
const isLowPriority = process.env.JINN_TEST_LOW_PRIORITY === '1'

// Local forks. Kept in step with `packages/web/vitest.config.ts`'s LOCAL_MAX_WORKERS:
// the two suites can run at the same time under the machine-wide slot gate, so a
// run's peak is roughly two of these plus the light packages.
const LOCAL_MAX_WORKERS = 4

// Windows needs the same headroom, for a different reason: it has no fork(), so
// every pool worker is a full process spawn that re-resolves the module graph
// from scratch, over NTFS, with realtime AV scanning each file. Suites whose
// beforeAll does `await import("../api.js")` — a 350KB module pulling in most of
// the gateway — routinely pass 10s under full local parallelism.
//
// This matters more than a slow test: vitest reports a timed-out hook by marking
// the file's tests SKIPPED, not failed. Around twenty suites (~180 tests,
// including the work-item and privileged-read guards) were dropping out of local
// Windows runs while the run still reported green.
const isWindows = process.platform === 'win32'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: './vitest.global-setup.ts',
    setupFiles: ['./vitest.setup.ts'],
    // Forks (the vitest v4 default) give each test file a clean process, which
    // matters for the gateway/PTY tests that mutate process-global state.
    pool: 'forks',
    // Cap concurrency so heavy integration tests don't contend for the runner's
    // handful of cores and its limited memory — on CI, and locally at four. In
    // vitest v4 the pool concurrency is set via top-level maxWorkers/minWorkers
    // (the old poolOptions.forks.maxForks was removed).
    ...(isCI ? { minWorkers: 1, maxWorkers: 2 } : { maxWorkers: LOCAL_MAX_WORKERS }),
    // Give slow, resource-starved CI runners — and a niced run sharing this
    // machine with an editor — enough headroom to boot real servers/workers/PTYs
    // without tripping spurious timeouts.
    testTimeout: isCI || isWindows || isLowPriority ? 30000 : 5000,
    hookTimeout: isCI || isWindows || isLowPriority ? 30000 : 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      // A floor against regression, not an aspiration. Each value is the
      // coverage measured when this gate was wired up (74.7 statements /
      // 70.0 branches / 77.7 functions / 77.5 lines), rounded down and cut by
      // three points. That margin absorbs v8's run-to-run variance and the
      // CI-only maxWorkers: 2 path above — a gate that flakes red is a gate
      // everyone learns to ignore. Raise these when coverage genuinely rises.
      thresholds: {
        statements: 71,
        branches: 67,
        functions: 74,
        lines: 74,
      },
    },
  },
})
