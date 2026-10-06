import { expect, test } from '@playwright/test'
import { cellRectForIndex } from '../../packages/web/src/routes/chat/grid-cells'
import { capForViewport, layoutFor } from '../../packages/web/src/routes/chat/grid-layout'
import { artifactPath, DESKTOP, openGridPage, openSeededGridPage, type Viewport } from './chat-grid-drop.context'
import {
  describeRect,
  dragSession,
  dragSessionToRightQuarter,
  expectGeometryMatch,
  expectNoDropOverlay,
  rect,
  rectDelta,
  seededSessionIds,
  setWorkingSet,
  settledGridGeometry,
  type DropRegion,
} from './chat-grid-drop.helpers'

test('real pointer preview matches the 2-to-3 pane right-region result', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { video: true, clearWorkingSet: true })

  const [sessionA, sessionB, sessionC] = await seededSessionIds(page)

  await page.locator(`[data-chat-session-row="${sessionA}"]`).first().click()
  await expect(page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${sessionA}"])`)).toBeVisible()
  await dragSessionToRightQuarter(page, sessionB, sessionA)
  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(2)

  const geometry = await dragSessionToRightQuarter(page, sessionC, sessionB)
  const delta = rectDelta(geometry.preview, geometry.result)
  const evidence = `preview ${describeRect(geometry.preview)} vs result ${describeRect(geometry.result)}; delta ${JSON.stringify(delta)}`
  console.log(`PLA-174 geometry: ${evidence}`)

  for (const [axis, value] of Object.entries(delta)) {
    expect(Math.abs(value), `${evidence}; ${axis} exceeded 1px`).toBeLessThanOrEqual(1)
  }
  await context.close()
})

/**
 * Whether a drop aimed at the grid's lower-right quarter can land in the 'end' region at all.
 *
 * placementForPointer only reports 'end' for a point inside the grid but outside every pane, so
 * 'end' exists only while the layout still has an empty trailing cell under that point. A grid
 * that fills its rectangle exactly -- four panes as 2x2, six as 3x2 -- has no 'end' to hit, and
 * asking for one there would drag into whichever pane occupies the corner instead.
 */
function endReachable(count: number, viewport: Viewport): boolean {
  const { columns, rows } = layoutFor(count, viewport.width, viewport.height)
  const column = Math.min(columns - 1, Math.floor(columns * 0.75))
  const row = Math.min(rows - 1, Math.floor(rows * 0.75))
  return row * columns + column >= count
}

/**
 * Every region at every pane count up to the viewport's TRUE cap.
 *
 * The counts are derived from capForViewport and never written down. main moved
 * MIN_PANE_WIDTH from 480 to 340, which lifted the cap from 4 to 6 at 1440x900 and from 6 to 8
 * at 1920x1080; the literal matrix this replaces ([2,3,4] and [2,3,5]) then sat below the cap,
 * so the cases meant to prove behaviour AT the cap quietly stopped doing so while still
 * passing. Deriving the counts means a future change to the pane geometry re-aims this matrix
 * instead of hollowing it out.
 *
 * The last count in the walk is the cap itself, so its drop is one pane too many: that case is
 * the eviction path, preview and result included.
 */
function dropMatrix(viewport: Viewport): Array<{ count: number; region: DropRegion; target: number }> {
  const cap = capForViewport(viewport.width, viewport.height)
  const cases: Array<{ count: number; region: DropRegion; target: number }> = []
  for (let count = 2; count <= cap; count += 1) {
    cases.push({ count, region: 'left', target: 0 })
    cases.push({ count, region: 'right', target: count - 1 })
    cases.push({ count, region: 'top', target: 0 })
    cases.push({ count, region: 'between', target: 0 })
    if (endReachable(count, viewport)) cases.push({ count, region: 'end', target: count - 1 })
  }
  return cases
}

for (const viewport of [DESKTOP, { width: 1920, height: 1080 }]) {
  test(`grid-cell oracle reproduces rendered panes at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const { context, page } = await openGridPage(browser, { viewport })
    const ids = await seededSessionIds(page)

    // Derived, not listed: the oracle has to be checked at the cap, and the cap moves with
    // MIN_PANE_WIDTH. cap - 1 keeps the last-row-short layout in the walk beside the full one.
    const cap = capForViewport(viewport.width, viewport.height)
    const renderedCounts = [...new Set([2, 3, cap - 1, cap])].filter((count) => count >= 2)
    for (const count of renderedCounts) {
      const seeded = await openSeededGridPage(context, ids.slice(0, count))

      const geometry = await settledGridGeometry(seeded, count)
      const spacing = await seeded.getByTestId('chat-grid').evaluate((element) => (
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--space-2'))
      ))

      geometry.panes.forEach((pane, index) => {
        const expected = cellRectForIndex(index, count, geometry.grid, {
          w: viewport.width,
          h: viewport.height,
        }, { padding: spacing, gap: spacing })
        const delta = rectDelta(expected, pane)
        for (const [axis, value] of Object.entries(delta)) {
          expect(Math.abs(value), `${count} panes, index ${index}, ${axis}`).toBeLessThanOrEqual(1)
        }
      })
      await seeded.close()
    }
    await context.close()
  })

  test(`preview simulation matches pointer drops at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    // Every region at every count up to the cap is ~22 drags at 1440x900 and ~32 at 1920x1080,
    // each one a reload plus a settled measurement. The old 180s budget was sized for six.
    test.setTimeout(900_000)
    const { context, page } = await openGridPage(browser, { viewport })
    const ids = await seededSessionIds(page)
    // The pane's bottom quarter is the composer, covered by the rejection journey below, so
    // 'bottom' is deliberately absent from the matrix.
    const cases = dropMatrix(viewport)

    for (const scenario of cases) {
      console.log(`PLA-174 matrix: ${viewport.width}x${viewport.height} ${scenario.count} panes ${scenario.region}`)
      await setWorkingSet(page, ids.slice(0, scenario.count))
      const geometry = await dragSession(
        page,
        ids[scenario.count],
        ids[scenario.target],
        scenario.region,
        scenario.region === 'end'
          ? scenario.count
          : scenario.target + (scenario.region === 'right' || scenario.region === 'bottom' || scenario.region === 'between' ? 1 : 0),
      )
      expectGeometryMatch(
        geometry.preview,
        geometry.result,
        `${scenario.count} panes ${scenario.region} at ${viewport.width}x${viewport.height}`,
      )
    }
    await context.close()
  })
}

test('the composer clears a prior pane preview and rejects the drop', async ({ browser }) => {
  const { context, page } = await openGridPage(browser)
  const ids = await seededSessionIds(page)
  await setWorkingSet(page, ids.slice(0, 2))

  const source = page.locator(`[data-chat-session-row="${ids[2]}"]`).first()
  const target = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[0]}"])`)
  const composer = target.locator('[data-chat-composer]')
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  const composerBox = await composer.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  expect(composerBox).not.toBeNull()

  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 3, { steps: 16 })
  await expect(page.getByTestId('chat-grid-drop-zone')).toBeVisible()
  await page.mouse.move(composerBox!.x + composerBox!.width / 2, composerBox!.y + composerBox!.height / 2, { steps: 8 })
  await expectNoDropOverlay(page)
  await page.mouse.up()

  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(2)
  await expect(page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[2]}"])`)).toHaveCount(0)
  await context.close()
})

test('ten consecutive member moves have no geometry drift or stale overlay', async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page } = await openGridPage(browser, { reducedMotion: true, video: true })
  const ids = await seededSessionIds(page)
  await setWorkingSet(page, ids.slice(0, 4))

  const regions: DropRegion[] = ['left', 'right', 'top', 'between']
  for (let index = 0; index < 10; index += 1) {
    const sourceId = ids[index % 4]
    const targetId = ids[(index + 1) % 4]
    const region = regions[index % regions.length]
    const geometry = await dragSession(page, sourceId, targetId, region)
    expectGeometryMatch(geometry.preview, geometry.result, `repeat ${index + 1} ${region}`)
    await expectNoDropOverlay(page)
  }
  await page.screenshot({ path: artifactPath('pla-174-light-1440.png') })
  await context.close()
})

test('dark-theme cap drop matches its preview with token-only overlay styling', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { theme: 'dark', video: true })
  const ids = await seededSessionIds(page)
  // Seed AT the cap so the drop below is genuinely one pane too many. Seeding a literal four
  // here was correct while the cap was four; once main lifted it to six the same case evicted
  // nothing and asserted eviction geometry against an ordinary insert.
  const cap = capForViewport(DESKTOP.width, DESKTOP.height)
  await setWorkingSet(page, ids.slice(0, cap))

  const source = page.locator(`[data-chat-session-row="${ids[cap]}"]`).first()
  const target = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[1]}"])`)
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width * 0.875, targetBox!.y + targetBox!.height / 2, { steps: 16 })
  await page.waitForTimeout(100)
  await page.mouse.move(targetBox!.x + targetBox!.width * 0.875 + 0.5, targetBox!.y + targetBox!.height / 2 + 0.5)
  const overlay = page.getByTestId('chat-grid-drop-zone')
  await expect(overlay).toBeVisible()
  const previewBox = await overlay.boundingBox()
  expect(previewBox).not.toBeNull()
  const overlayStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element)
    return { borderWidth: style.borderWidth, backgroundColor: style.backgroundColor }
  })
  expect(overlayStyle.borderWidth).toBe('0px')
  expect(overlayStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: artifactPath('pla-174-dark-1440-held.png') })
  await page.mouse.up()
  const droppedPane = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[cap]}"])`)
  await expect(droppedPane).toHaveAttribute('data-grid-motion', 'idle')
  const resultBox = await droppedPane.boundingBox()
  expect(resultBox).not.toBeNull()
  expectGeometryMatch(rect(previewBox!), rect(resultBox!), 'dark cap eviction')
  // The point of the case: the grid absorbed a (cap + 1)th chat by evicting, not by growing.
  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(cap)
  await expectNoDropOverlay(page)
  await page.screenshot({ path: artifactPath('pla-174-dark-1440.png') })
  await context.close()
})

test('Open beside follows the view toggle and opens the picker in both themes', async ({ browser }) => {
  for (const theme of ['light', 'dark'] as const) {
    const { context, page } = await openGridPage(browser, { theme })
    const [sessionId] = await seededSessionIds(page)
    await page.locator(`[data-chat-session-row="${sessionId}"]`).first().click()
    const more = page.locator('[data-more-menu]:visible').first()
    await more.getByRole('button', { name: 'More options' }).click()
    const buttons = more.getByRole('button')
    const labels = await buttons.allTextContents()
    const cliIndex = labels.findIndex((label) => label.trim() === 'CLI')
    const openIndex = labels.findIndex((label) => label.trim() === 'Open beside')
    const newTabIndex = labels.findIndex((label) => label.trim() === 'Open in new tab')
    const pinIndex = labels.findIndex((label) => label.trim() === 'Pin')
    // CLI, Open beside, Open in new tab, Pin: each directly after the one before.
    expect(cliIndex).toBeGreaterThanOrEqual(0)
    expect(openIndex).toBe(cliIndex + 1)
    expect(newTabIndex).toBe(openIndex + 1)
    expect(pinIndex).toBe(newTabIndex + 1)
    await page.screenshot({ path: artifactPath(`pla-174-${theme}-menu-1440.png`) })
    await buttons.nth(openIndex).click()
    await expect(page.getByTestId('session-picker-scroll')).toBeVisible()
    await context.close()
  }
})

test('the pane title-bar menu reads the same as the header in both themes', async ({ browser }) => {
  // The header menu above is the single-pane home of this action; the pane title bar is the
  // multi-pane one. Checking only the header is how the two came to disagree: PLA-180 gave the
  // pane its own copy under a different name, in a different slot, and nothing compared them.
  for (const theme of ['light', 'dark'] as const) {
    const { context, page } = await openGridPage(browser, { theme })
    const ids = await seededSessionIds(page)
    await setWorkingSet(page, ids.slice(0, 2))

    const pane = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[1]}"])`)
    await pane.hover()
    await pane.locator('[data-chat-pane-menu-trigger]').click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open beside' })).toBeVisible()

    const order = await menu.evaluate((element) => (
      Array.from(element.querySelectorAll('[role="menuitem"], button'))
        .map((item) => item.textContent?.trim() ?? '')
    ))
    expect(order.indexOf('Open beside')).toBe(order.indexOf('CLI') + 1)
    expect(order.indexOf('Open beside')).toBeLessThan(order.indexOf('Rename'))
    await page.screenshot({ path: artifactPath(`pla-174-${theme}-pane-menu-1440.png`) })
    await context.close()
  }
})
