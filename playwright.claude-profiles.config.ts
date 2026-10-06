import path from 'node:path'
import { defineConfig } from '@playwright/test'

const baseURL = process.env.JINN_VERIFY_BASE_URL ?? 'http://127.0.0.1:8060'
const artifacts = process.env.JINN_VERIFY_ARTIFACTS ?? path.join('/tmp', 'jinn-claude-profiles-artifacts')

export default defineConfig({
  testDir: './e2e/claude-profiles',
  testMatch: ['claude-profiles.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: path.join(artifacts, 'playwright-results'),
  reporter: [['line']],
  use: { baseURL, headless: true, trace: 'off', screenshot: 'only-on-failure' },
})
