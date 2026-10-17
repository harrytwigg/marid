// Photographs a Button and a Switch in each state a native control has, for the PR.
//
//   node states.mjs <sandbox-home> <base-url> <out-dir>
//
// The Button is the board's New Todo control (desktop), the Switch the first one on Settings. For
// each theme it takes a close crop at rest, under the pointer (hover), held down (pressed), and
// focused by the keyboard (focus-visible). Writes <out-dir>/<control>-<theme>-<state>.png. Exits
// non-zero when the keyboard-focused control draws no ring.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { THEMES } from './screens.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: states.mjs <sandbox-home> <base-url> <out-dir>')

const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()
const failures = []

const CONTROLS = [
  { name: 'button', url: '/todos', ready: 'Everything', locate: (page) => page.locator('[data-primary-action="trailing"]') },
  { name: 'switch', url: '/settings', ready: 'Appearance', locate: (page) => page.getByRole('switch').first() },
]

// The press box: the switch's label, or the button itself. Runs in the page.
function pressBox(node, isSwitch) {
  const r = (isSwitch ? node.closest('label') : node).getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

// The ring as rendered: an outline, or a box-shadow layer that is not just the control's material.
function ringOf(node, isSwitch) {
  const target = isSwitch ? node.closest('label').querySelector('.switch__control') : node
  const style = getComputedStyle(target)
  const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
  return { outline, shadow: style.boxShadow }
}

for (const theme of THEMES) {
  for (const control of CONTROLS) {
    const isSwitch = control.name === 'switch'
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
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
      await page.goto(baseUrl + control.url, { waitUntil: 'networkidle' })
      await page.getByText(control.ready, { exact: false }).locator('visible=true').first().waitFor({ timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
      const el = control.locate(page)
      await el.scrollIntoViewIfNeeded()
      const handle = await el.elementHandle()
      const shoot = async (state) => {
        await page.waitForTimeout(350)
        const box = await handle.evaluate(pressBox, isSwitch)
        const pad = 14
        await page.screenshot({
          path: path.join(outDir, `${control.name}-${theme}-${state}.png`),
          clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
        })
      }
      await page.mouse.move(5, 5)
      await shoot('rest')
      const box = await handle.evaluate(pressBox, isSwitch)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await shoot('hover')
      await page.mouse.down()
      await shoot('pressed')
      // Release away from the control so nothing is toggled or opened.
      await page.mouse.move(5, 5)
      await page.mouse.up()
      await page.evaluate(() => document.activeElement?.blur?.())
      // A real Tab marks the page as keyboard-driven (:focus-visible); focus() then moves to the
      // control, which on Settings sits behind dozens of other tab stops.
      await page.keyboard.press('Tab')
      await handle.evaluate((node) => node.focus())
      if (!(await handle.evaluate((node) => node.matches(':focus-visible')))) throw new Error('the control is not :focus-visible after a keyboard focus')
      await shoot('focus-visible')
      const ring = await handle.evaluate(ringOf, isSwitch)
      const shadowLayers = ring.shadow === 'none' ? 0 : ring.shadow.split(/,(?![^(]*\))/).length
      console.log(`  ${control.name} ${theme} focus ring: outline ${ring.outline}, ${shadowLayers} shadow layers`)
      if (!ring.outline && shadowLayers < 1) failures.push(`${control.name} ${theme}: no ring when focused by the keyboard`)
    } catch (err) {
      failures.push(`${control.name} ${theme}: ${String(err.message).split('\n')[0]}`)
    } finally {
      await context.close()
    }
  }
  console.log(`photographed ${theme}`)
}
await browser.close()
if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join('\n'))
  process.exit(1)
}
