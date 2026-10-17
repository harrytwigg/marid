// Measures the press target of every switch on the Settings page, in a real browser.
//
//   node hit-area.mjs <sandbox-home> <base-url> <out-dir>
//
// The element that receives the press is the switch's own label (the native checkbox sits inside
// it) or, for a switch that is a bare button, the button. For each width and theme it reports that
// box and the track inside it, checks that a press 2px inside each corner of the box toggles the
// switch (and, by hit test, that the box is what sits under each of those points), and photographs
// a close crop of the first switch with its row. Writes
// <out-dir>/hit-area.json and <out-dir>/switch-<theme>-<width>.png. Exits non-zero when a switch's
// press box is under 40px tall at 390px wide, under 34px tall from md up, or under 44px wide.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { THEMES, VIEWPORTS } from './screens.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: hit-area.mjs <sandbox-home> <base-url> <out-dir>')

const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()
const results = []
const failures = []

// Runs in the page: the box that takes the press, and the visible track in it.
function describe(el) {
  const press = el.closest('label') ?? el
  const track = press.querySelector('.switch__control') ?? press.querySelector('span') ?? press
  const box = (node) => {
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  return { name: el.getAttribute('aria-label') ?? '', press: box(press), track: box(track), pressTag: press.tagName.toLowerCase() }
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    const label = `${theme}-${viewport.width}`
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 3,
      colorScheme: theme,
      reducedMotion: 'reduce',
      extraHTTPHeaders: { authorization: `Bearer ${token}` },
    })
    await context.addInitScript(([t]) => {
      localStorage.setItem('jinn-theme', t)
      localStorage.setItem('jinn-onboarded', 'true')
    }, [theme])
    const page = await context.newPage()
    try {
      await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle' })
      await page.getByText('Appearance', { exact: false }).locator('visible=true').first().waitFor({ timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(800)
      const switches = page.getByRole('switch')
      const count = await switches.count()
      const rows = []
      for (let i = 0; i < count; i++) {
        const handle = await switches.nth(i).elementHandle()
        await handle.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        const info = await handle.evaluate(describe)
        const { press } = info
        // A press 2px inside each corner must reach the switch (boxes are viewport coordinates).
        const toggled = []
        const hits = []
        for (const [dx, dy] of [[2, 2], [press.width - 2, 2], [2, press.height - 2], [press.width - 2, press.height - 2]]) {
          const hit = await handle.evaluate((el, [x, y]) => {
            const top = document.elementFromPoint(x, y)
            return (el.closest('label') ?? el).contains(top) ? true : `${top?.tagName.toLowerCase()}${[...(top?.classList ?? [])].map((c) => `.${c}`).join('')}`
          }, [press.x + dx, press.y + dy])
          hits.push(hit)
          const before = await switches.nth(i).isChecked()
          await page.mouse.click(press.x + dx, press.y + dy)
          await page.waitForTimeout(60)
          const changed = before !== (await switches.nth(i).isChecked())
          toggled.push(changed)
          if (changed) {
            await page.mouse.click(press.x + dx, press.y + dy)
            await page.waitForTimeout(60)
          }
        }
        rows.push({ ...info, cornersHit: hits, cornersToggle: toggled })
      }
      results.push({ label, theme, width: viewport.width, switches: rows })
      const minHeight = viewport.width < 768 ? 40 : 34
      for (const row of rows) {
        const { width, height } = row.press
        if (height < minHeight - 0.5 || width < 43.5) failures.push(`${label} "${row.name}": press box ${width.toFixed(1)}x${height.toFixed(1)}`)
      }
      if (rows.length > 0) {
        // A close crop of the first switch with the label to its left.
        const first = switches.first()
        await (await first.elementHandle()).evaluate((el) => el.scrollIntoView({ block: 'center' }))
        const press = await (await first.elementHandle()).evaluate((el) => {
          const r = (el.closest('label') ?? el).getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        const left = Math.max(0, press.x - 300)
        await page.screenshot({
          path: path.join(outDir, `switch-${label}.png`),
          clip: { x: left, y: Math.max(0, press.y - 16), width: Math.min(viewport.width - left, press.x - left + press.width + 16), height: press.height + 32 },
        })
      }
      console.log(`measured ${label}: ${rows.length} switches`)
    } catch (err) {
      failures.push(`${label}: ${String(err.message).split('\n')[0]}`)
    } finally {
      await context.close()
    }
  }
}
await browser.close()
fs.writeFileSync(path.join(outDir, 'hit-area.json'), JSON.stringify(results, null, 2))
if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join('\n'))
  process.exit(1)
}
