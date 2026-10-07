import path from 'node:path'
import { defineConfig } from '@playwright/test'

const baseURL = process.env.JINN_VERIFY_BASE_URL ?? 'http://127.0.0.1:8060'
const artifacts = process.env.JINN_VERIFY_ARTIFACTS ?? path.join('/tmp', 'jinn-departments-artifacts')

export default defineConfig({
  testDir: './e2e/departments',
  testMatch: ['departments.spec.ts', 'scope-editing.spec.ts', 'scoped-context.spec.ts', 'employee-editor.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(artifacts, 'playwright-results'),
  reporter: [['line']],
  use: {
    baseURL,
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
})
