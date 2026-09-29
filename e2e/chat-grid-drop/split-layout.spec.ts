import { expect, test, type Page } from '@playwright/test'
import { artifactPath, openGridPage } from './chat-grid-drop.context'
import { dragSession, expectGeometryMatch, expectNoDropOverlay, rect, seededSessionIds, type Rect } from './chat-grid-drop.helpers'

/**
 * The split layout on top of the flat-grid journeys in chat-grid-drop.spec.ts: an edge drop
 * that the flat grid could only express as a reorder becomes a real split, splitters resize by
 * pointer and keyboard, and the arrangement survives a reload.
 */

function pane(page: Page, sessionId: string) {
  return page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${sessionId}"])`)
}

async function box(page: Page, sessionId: string): Promise<Rect> {
  const found = await pane(page, sessionId).boundingBox()
  expect(found, `pane ${sessionId}`).not.toBeNull()
  return rect(found!)
}

/** Every pane idle and laid out, so a measurement is not racing the FLIP pass. */
async function settle(page: Page, count: number): Promise<void> {
  const panes = page.locator('[data-chat-grid-pane]')
  await expect(panes).toHaveCount(count)
  for (let index = 0; index < count; index += 1) {
    await expect(panes.nth(index)).toHaveAttribute('data-grid-motion', 'idle')
  }
  await page.waitForTimeout(150)
}

/** A, then B split to its right, then C split above B: A | (C over B). */
async function arrangeThree(page: Page, [a, b, c]: string[]): Promise<void> {
  await page.locator(`[data-chat-session-row="${a}"]`).first().click()
  await expect(pane(page, a)).toBeVisible()
  await dragSession(page, b, a, 'right')
  await settle(page, 2)
  const geometry = await dragSession(page, c, b, 'top')
  expectGeometryMatch(geometry.preview, geometry.result, 'top split of the right pane')
  await settle(page, 3)
}

test('an edge drop splits the pane under it instead of reflowing the grid', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { video: true, clearWorkingSet: true })
  const ids = await seededSessionIds(page)
  const [a, b, c] = ids
  await arrangeThree(page, ids)

  await expect(page.getByTestId('chat-grid')).toHaveAttribute('data-split-layout', 'arranged')
  const [left, top, bottom] = [await box(page, a), await box(page, c), await box(page, b)]
  // C and B share the right column; A keeps the full height on the left. The flat grid can
  // only make three panes a 2x2 with a hole, never this.
  expect(Math.abs(top.left - bottom.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(top.width - bottom.width)).toBeLessThanOrEqual(1)
  expect(top.top + top.height).toBeLessThan(bottom.top)
  expect(Math.abs(left.height - (bottom.top + bottom.height - top.top))).toBeLessThanOrEqual(1)
  expect(left.left + left.width).toBeLessThan(top.left)
  await page.screenshot({ path: artifactPath('split-layout-arranged.png') })
  await context.close()
})

/** Press, move and release a sidebar row at a point; returns the overlay's region and box. */
async function dropRowAt(page: Page, sessionId: string, x: number, y: number) {
  const source = await page.locator(`[data-chat-session-row="${sessionId}"]`).first().boundingBox()
  expect(source).not.toBeNull()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 16 })
  await page.waitForTimeout(100)
  await page.mouse.move(x + 0.5, y + 0.5, { steps: 2 })
  const overlay = page.getByTestId('chat-grid-drop-zone')
  await expect(overlay).toBeVisible()
  const region = await overlay.getAttribute('data-drop-region')
  const preview = rect((await overlay.boundingBox())!)
  await page.mouse.up()
  return { region, preview }
}

test('a stacked pane splits at its bottom edge, above the composer', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { clearWorkingSet: true })
  const ids = await seededSessionIds(page)
  const [, , c, d] = ids
  await arrangeThree(page, ids)

  // C is a half-height pane. Its bottom quarter is almost all composer, where drops are refused,
  // so the bottom band is measured on the part of the pane above the composer.
  const target = await box(page, c)
  const composer = await pane(page, c).locator('[data-chat-composer]').first().boundingBox()
  expect(composer).not.toBeNull()
  const band = composer!.y - target.top
  const { region, preview } = await dropRowAt(page, d, target.left + target.width / 2, target.top + band * 0.875)
  expect(region).toBe('bottom')

  await settle(page, 4)
  const [above, below] = [await box(page, c), await box(page, d)]
  expect(Math.abs(above.left - below.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(above.width - below.width)).toBeLessThanOrEqual(1)
  expect(above.top + above.height).toBeLessThan(below.top)
  expectGeometryMatch(preview, below, 'bottom split of a stacked pane')
  await context.close()
})

test('closing the shown chat of a pane with a hidden tab shows that tab and follows it', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { clearWorkingSet: true })
  const ids = await seededSessionIds(page)
  const [a, , , d] = ids
  await arrangeThree(page, ids)
  const slot = await box(page, a)
  const { region } = await dropRowAt(page, d, slot.left + slot.width / 2, slot.top + slot.height / 3)
  expect(region).toBe('center')
  await settle(page, 3)
  await expect(pane(page, a)).toHaveCount(0)

  const shown = pane(page, d)
  await shown.hover()
  // The pane's own close, not a tab's: a pane with a hidden tab also shows a strip of tabs, each with a close.
  await shown.getByTestId('chat-pane-title-actions').getByRole('button', { name: /^Close / }).click()

  // The pane falls back to its hidden tab, and focus and the URL go with it rather than jumping
  // to a neighbour and pulling the closed chat back in.
  await settle(page, 3)
  await expect(pane(page, d)).toHaveCount(0)
  expectGeometryMatch(slot, await box(page, a), 'fallback tab keeps the pane')
  await expect(page).toHaveURL(new RegExp(a))
  await context.close()
})

test('a drop in the middle of a pane keeps the pane count and shows the dropped chat there', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { clearWorkingSet: true })
  const [a, b, c] = await seededSessionIds(page)
  await page.locator(`[data-chat-session-row="${a}"]`).first().click()
  await dragSession(page, b, a, 'right')
  await settle(page, 2)

  const target = await box(page, b)
  const source = await page.locator(`[data-chat-session-row="${c}"]`).first().boundingBox()
  expect(source).not.toBeNull()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.left + target.width / 2, target.top + target.height / 3, { steps: 16 })
  await page.waitForTimeout(100)
  await page.mouse.move(target.left + target.width / 2 + 0.5, target.top + target.height / 3 + 0.5, { steps: 2 })
  const overlay = page.getByTestId('chat-grid-drop-zone')
  await expect(overlay).toHaveAttribute('data-drop-region', 'center')
  const preview = rect((await overlay.boundingBox())!)
  await page.mouse.up()

  await settle(page, 2)
  await expect(pane(page, b)).toHaveCount(0)
  expectGeometryMatch(preview, await box(page, c), 'middle drop')
  await expectNoDropOverlay(page)
  await context.close()
})

test('splitters resize by pointer and keyboard, reset on double-click, and persist', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { video: true, clearWorkingSet: true })
  const ids = await seededSessionIds(page)
  const [a, b, c] = ids
  await arrangeThree(page, ids)

  const column = page.locator('[role="separator"][aria-orientation="vertical"]')
  await expect(column).toHaveCount(1)
  const before = await box(page, a)
  const handle = rect((await column.boundingBox())!)
  const x = handle.left + handle.width / 2
  const y = handle.top + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 150, y, { steps: 10 })
  await page.mouse.up()
  const dragged = await box(page, a)
  expect(Math.abs(dragged.width - before.width - 150)).toBeLessThanOrEqual(2)

  await column.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  const keyed = await box(page, a)
  expect(Math.abs(dragged.width - keyed.width - 32)).toBeLessThanOrEqual(2)

  const row = page.locator('[role="separator"][aria-orientation="horizontal"]')
  await row.focus()
  await page.keyboard.press('Shift+ArrowDown')
  const topAfterKeys = await box(page, c)
  expect(topAfterKeys.height).toBeGreaterThan((await box(page, b)).height)

  // Sizes persist: a reload restores the same rectangles.
  const saved = { a: await box(page, a), b: await box(page, b), c: await box(page, c) }
  await page.reload({ waitUntil: 'networkidle' })
  await settle(page, 3)
  for (const [id, expected] of [[a, saved.a], [b, saved.b], [c, saved.c]] as const) {
    expectGeometryMatch(expected, await box(page, id), `reload ${id}`)
  }
  await page.screenshot({ path: artifactPath('split-layout-resized.png') })

  await column.dblclick()
  const reset = await box(page, a)
  const right = await box(page, b)
  expect(Math.abs(reset.width - right.width)).toBeLessThanOrEqual(1)
  await context.close()
})

test('a narrower window keeps every pane inside the grid', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { clearWorkingSet: true })
  const ids = await seededSessionIds(page)
  await arrangeThree(page, ids)

  await page.setViewportSize({ width: 1100, height: 760 })
  await page.waitForTimeout(300)
  const grid = rect((await page.getByTestId('chat-grid').boundingBox())!)
  const panes = await page.locator('[data-chat-grid-pane]').evaluateAll((nodes) => nodes.map((node) => {
    const r = node.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }))
  expect(panes.length).toBeGreaterThan(0)
  for (const found of panes) {
    expect(found.width).toBeGreaterThan(0)
    expect(found.left + found.width).toBeLessThanOrEqual(grid.left + grid.width + 1)
    expect(found.top + found.height).toBeLessThanOrEqual(grid.top + grid.height + 1)
  }
  await context.close()
})
