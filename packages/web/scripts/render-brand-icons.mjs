#!/usr/bin/env node
/**
 * Rasterises the brand mark SVGs in public/icons into the PNGs the manifest,
 * the apple-touch-icon and the favicon fallback point at. Firefox draws them:
 * it needs no GPU process (see the UI capture notes).
 *
 *   node scripts/render-brand-icons.mjs
 *
 * The SVGs are the source of truth and carry no text, so nothing here reads the
 * product name.
 */
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { firefox } from "@playwright/test"

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public")

const OUTPUTS = [
  { svg: "icons/marid-mark.svg", png: "icons/icon-192.png", size: 192 },
  { svg: "icons/marid-mark.svg", png: "icons/icon-512.png", size: 512 },
  { svg: "icons/marid-mark-maskable.svg", png: "icons/icon-maskable-512.png", size: 512 },
  // iOS rounds the corners itself and paints transparency black, so it gets the full-bleed square.
  { svg: "icons/marid-mark-maskable.svg", png: "apple-touch-icon.png", size: 180 },
  { svg: "icons/marid-favicon.svg", png: "icons/favicon-32.png", size: 32 },
]

const browser = await firefox.launch()
try {
  for (const { svg, png, size } of OUTPUTS) {
    const page = await browser.newPage()
    const data = (await readFile(join(publicDir, svg))).toString("base64")
    // A canvas keeps the corners transparent; Firefox cannot omit a screenshot's background.
    const url = await page.evaluate(
      ([src, px]) =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = px
            canvas.getContext("2d").drawImage(img, 0, 0, px, px)
            resolve(canvas.toDataURL("image/png"))
          }
          img.onerror = () => reject(new Error("svg did not load"))
          img.src = src
        }),
      /** @type {[string, number]} */ ([`data:image/svg+xml;base64,${data}`, size]),
    )
    await writeFile(join(publicDir, png), Buffer.from(url.split(",")[1], "base64"))
    await page.close()
    console.log(`${png} ${size}x${size}`)
  }
} finally {
  await browser.close()
}
