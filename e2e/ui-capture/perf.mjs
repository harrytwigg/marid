// Frame times while scrolling a long chat transcript, for comparing two builds.
//
//   node perf.mjs <sandbox-home> <base-url> <out-dir>
//
// Chromium only. For each theme and width it opens the chat, throttles the CPU, warms up with one
// scroll, then scrolls the transcript up and down with real compositor-driven wheel gestures while
// a requestAnimationFrame loop records the gap between frames. The warm-up scroll is discarded.
// Writes <out-dir>/perf.json (every frame gap per
// run, so runs from separate launches can be pooled) and prints one summary line per run.
//
// Environment: JINN_PERF_RUNS (measured runs per variant, default 3), JINN_PERF_THROTTLE (CPU
// slowdown, default 4), JINN_PERF_VARIANTS (comma list of theme-width, default all four).
//
// This is software raster when /dev/dri is hidden (see README): a blur costs more there than on a
// GPU, so compare the two builds with each other, never against a target.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { THEMES, VIEWPORTS } from './screens.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: perf.mjs <sandbox-home> <base-url> <out-dir>')

const RUNS = Number(process.env.JINN_PERF_RUNS ?? 3)
const THROTTLE = Number(process.env.JINN_PERF_THROTTLE ?? 4)
const WANTED = process.env.JINN_PERF_VARIANTS?.split(',')
const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
fs.mkdirSync(outDir, { recursive: true })

const STEPS = 6
const DISTANCE = 2400
const SPEED = 1800

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function summarise(frames) {
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    frames: frames.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    over33: frames.filter((f) => f > 33.4).length,
  }
}

async function scrollRun(client, page, viewport) {
  const x = Math.round(viewport.width / 2)
  const y = Math.round(viewport.height / 2)
  await page.evaluate(() => {
    window.__frames = []
    window.__last = 0
    window.__run = true
    const tick = (t) => {
      if (window.__last) window.__frames.push(t - window.__last)
      window.__last = t
      if (window.__run) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  for (let step = 0; step < STEPS; step += 1) {
    const dir = step % 2 === 0 ? 1 : -1
    // yDistance > 0 scrolls up: first toward older messages, then back down.
    await client.send('Input.synthesizeScrollGesture', { x, y, yDistance: dir * DISTANCE, speed: SPEED, gestureSourceType: 'mouse' })
  }
  return page.evaluate(() => {
    window.__run = false
    return window.__frames
  })
}

async function runVariant(browser, { theme, viewport }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    reducedMotion: 'reduce',
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
  await context.addInitScript((t) => {
    localStorage.setItem('jinn-theme', t)
    localStorage.setItem('jinn-onboarded', 'true')
  }, theme)
  const page = await context.newPage()
  await page.goto(baseUrl + `/?session=${fixtures.chatSession}`, { waitUntil: 'networkidle' })
  await page.locator('.chat-messages-scroll').first().waitFor({ timeout: 15_000 })
  await page.locator('[data-chat-composer]').first().waitFor({ timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
  const scrollable = await page.evaluate(() => {
    const s = document.querySelector('.chat-messages-scroll')
    return s ? s.scrollHeight - s.clientHeight : 0
  })
  if (scrollable < DISTANCE * 2) throw new Error(`the transcript scrolls only ${scrollable}px; seed it with JINN_CAPTURE_MESSAGES`)
  const client = await context.newCDPSession(page)
  await client.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  await scrollRun(client, page, viewport) // warm-up, discarded
  const runs = []
  for (let i = 0; i < RUNS; i += 1) {
    // Start every run from the same place: the bottom of the thread.
    await page.evaluate(() => {
      const s = document.querySelector('.chat-messages-scroll')
      s.scrollTop = s.scrollHeight
    })
    await page.waitForTimeout(500)
    const frames = await scrollRun(client, page, viewport)
    runs.push({ frames, ...summarise(frames) })
  }
  await context.close()
  return runs
}

function report(label, runs) {
  for (const [i, run] of runs.entries()) {
    console.log(`PERF ${label} run${i + 1}: ${run.frames} frames, median ${run.median.toFixed(1)}ms, p95 ${run.p95.toFixed(1)}ms, p99 ${run.p99.toFixed(1)}ms, max ${run.max.toFixed(1)}ms, ${run.over33} over 33ms`)
  }
}

const variants = THEMES.flatMap((theme) => VIEWPORTS.map((viewport) => ({ theme, viewport, label: `${theme}-${viewport.name}` })))
  .filter((variant) => !WANTED || WANTED.includes(variant.label))
const browser = await chromium.launch()
const results = []
try {
  for (const variant of variants) {
    const runs = await runVariant(browser, variant)
    results.push({ label: variant.label, throttle: THROTTLE, runs })
    report(variant.label, runs)
  }
} finally {
  await browser.close()
}
fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(results))
