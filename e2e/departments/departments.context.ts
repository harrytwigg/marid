import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'

/**
 * An authenticated page at a fixed viewport and theme, with onboarding already dismissed.
 * The theme has to be in localStorage before the app's first paint: colorScheme alone leaves
 * the app rendering its own stored preference. Motion is left at the browser's default: under
 * reduced motion the Todos page hides its large title on a phone, and the board switcher with it.
 */

export type Theme = 'light' | 'dark'
export interface Size { name: 'desktop' | 'phone'; width: number; height: number }

export const SIZES: Size[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]
export const THEMES: Theme[] = ['light', 'dark']

/** The department panel is a long column; it is captured at a height that holds all of it, at the same width. */
export function tallerFor(size: Size): Size {
  return { ...size, height: size.name === 'phone' ? 1500 : 1150 }
}

const home = process.env.JINN_VERIFY_HOME
const artifacts = process.env.JINN_VERIFY_ARTIFACTS
if (!home || !artifacts) throw new Error('JINN_VERIFY_HOME and JINN_VERIFY_ARTIFACTS are required')

export function gatewayToken(): string {
  const gateway = JSON.parse(fs.readFileSync(path.join(home!, 'gateway.json'), 'utf8')) as { token?: unknown }
  if (typeof gateway.token !== 'string' || !gateway.token) throw new Error('sandbox gateway token is missing')
  return gateway.token
}

export function sandboxFile(...segments: string[]): string {
  return path.join(home!, ...segments)
}

export function screenshotPath(name: string, theme: Theme, size: Size): string {
  const dir = path.join(artifacts!, 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${name}-${theme}-${size.name}.png`)
}

export async function openPage(browser: Browser, theme: Theme, size: Size, url: string, deviceScaleFactor = 1, chatListOpen = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    deviceScaleFactor,
    viewport: { width: size.width, height: size.height },
    screen: { width: size.width, height: size.height },
    colorScheme: theme,
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
  })
  await context.addInitScript((settings: { theme: Theme; chatListOpen: boolean }) => {
    localStorage.setItem('jinn-theme', settings.theme)
    localStorage.setItem('jinn-onboarded', 'true')
    localStorage.setItem('jinn-chat-list-open', String(settings.chatListOpen))
  }, { theme, chatListOpen })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  return { context, page }
}

/** Links a seeded session (see seed-departments.mjs) to a Todo, so it shows on that Todo's page. */
export function linkSeededSession(key: string, todoId: string): void {
  const seed = JSON.parse(fs.readFileSync(path.join(home!, 'departments-seed.json'), 'utf8')) as { sessions: Record<string, string> }
  const Database = createRequire(path.join(process.cwd(), 'packages', 'jinn', 'package.json'))('better-sqlite3')
  const db = new Database(path.join(home!, 'sessions', 'registry.db'))
  try {
    const result = db.prepare('UPDATE sessions SET work_item_id = ? WHERE id = ?').run(todoId, seed.sessions[key])
    if (result.changes !== 1) throw new Error(`seeded session ${key} was not found`)
  } finally {
    db.close()
  }
}
