// Lays out before/after captures as one comparison sheet per screen, so a PR
// carries a handful of images instead of dozens.
//
//   node sheet.mjs <before-dir> <after-dir> <out-dir>
//
// JINN_SHEET_LABELS="Firefox,Chromium" renames the two columns (default
// "Before,After"), for comparing two browsers or two settings instead.
//
// Each sheet has a row per theme and viewport with before on the left and
// after on the right. A capture missing on one side is shown as missing.
import fs from 'node:fs'
import path from 'node:path'
import { firefox } from '@playwright/test'
import { SCREENS, THEMES, VIEWPORTS } from './screens.mjs'

const [beforeDir, afterDir, outDir] = process.argv.slice(2)
if (!beforeDir || !afterDir || !outDir) throw new Error('usage: sheet.mjs <before-dir> <after-dir> <out-dir>')
fs.mkdirSync(outDir, { recursive: true })
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const [leftLabel, rightLabel] = (process.env.JINN_SHEET_LABELS ?? 'Before,After')
  .split(',')
  .map((label) => escapeHtml(label.trim()))
if (!leftLabel || !rightLabel) throw new Error('JINN_SHEET_LABELS needs two comma-separated labels, e.g. "Firefox,Chromium"')

const img = (dir, file) => {
  const p = path.join(dir, file)
  return fs.existsSync(p)
    ? `<img src="data:image/png;base64,${fs.readFileSync(p).toString('base64')}">`
    : '<div class="missing">not captured</div>'
}

function rowsFor(screen) {
  const pairs = VIEWPORTS.flatMap((viewport) => THEMES.map((theme) => ({ viewport, theme })))
  return pairs
    .map(({ viewport, theme }) => ({ viewport, theme, file: `${screen.name}-${theme}-${viewport.name}.png` }))
    .filter(({ file }) => fs.existsSync(path.join(beforeDir, file)) || fs.existsSync(path.join(afterDir, file)))
    .map(({ viewport, theme, file }) => `<section class="${viewport.name}"><h2>${theme} · ${viewport.name}</h2>
          <div class="pair"><figure><figcaption>${leftLabel}</figcaption>${img(beforeDir, file)}</figure>
          <figure><figcaption>${rightLabel}</figcaption>${img(afterDir, file)}</figure></div></section>`)
}

const STYLE = `<style>
      body { margin: 0; padding: 24px; background: #f2f4f7; font: 15px system-ui, sans-serif; color: #1b1f24; width: 1880px; }
      h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 14px; margin: 18px 0 8px; text-transform: capitalize; color: #57606a; }
      .pair { display: flex; gap: 16px; align-items: flex-start; }
      figure { margin: 0; flex: 1; } .narrow figure { flex: 0 0 auto; }
      figcaption { font-weight: 600; margin-bottom: 6px; }
      img { display: block; width: 100%; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
      .narrow img { width: 300px; } .missing { padding: 40px; background: #e1e4e8; border-radius: 8px; color: #57606a; }
    </style>`

const browser = await firefox.launch()
try {
  for (const screen of SCREENS) {
    const rows = rowsFor(screen)
    if (!rows.length) continue
    const page = await browser.newPage({ viewport: { width: 1928, height: 800 } })
    await page.setContent(`<!doctype html><meta charset="utf-8">${STYLE}<h1>${screen.title}: ${leftLabel} / ${rightLabel}</h1>${rows.join('')}`, { waitUntil: 'load' })
    await page.screenshot({ path: path.join(outDir, `${screen.name}.png`), fullPage: true })
    await page.close()
    console.log(`sheet ${screen.name}`)
  }
} finally {
  await browser.close()
}
