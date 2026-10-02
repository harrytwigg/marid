import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // These suites render whole pages into jsdom and query them by role, which
    // recomputes an accessibility tree over a large DOM on every poll. Several
    // cost seconds on an idle machine, and under a full monorepo run — vitest
    // forks competing with the gateway suite — they pass the 5s default and the
    // gate goes red on load rather than on code. 20s is headroom for the slow
    // ones, still short enough that a genuine hang fails the run.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Kept in step with vite.config.ts: a suite that resolved the SDK by a
      // different route would prove nothing about what the app ships.
      '@jinn/plugin-sdk': path.resolve(__dirname, 'src/plugins/sdk/index.ts'),
      '@jinn/fallback-map-wire': path.resolve(__dirname, '../jinn/src/shared/fallback-map-wire.ts'),
      '@jinn/model-id': path.resolve(__dirname, '../jinn/src/shared/model-id.ts'),
    },
  },
})
