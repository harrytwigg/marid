import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { gatewayToken, openPage, sandboxFile, screenshotPath, SIZES, tallerFor, THEMES } from './departments.context'

/**
 * Scope badges on the board switcher and the org tree, and the department panel, driven the way
 * an operator uses them: against a sandbox gateway seeded with an open, a scoped, a dedicated and
 * a refused department, in light and dark, at desktop and phone widths.
 */

interface PanelState {
  slug: string
  label: string
  scope: 'open' | 'scoped' | 'dedicated'
  check: (page: Page) => Promise<void>
}

const PANEL_STATES: PanelState[] = [
  {
    slug: 'engineering',
    label: 'open',
    scope: 'open',
    check: async (page) => {
      await expect(panelBadge(page)).toHaveCount(0)
      await expect(page.getByTestId('department-open-note')).toBeVisible()
      await expect(page.getByTestId('department-members')).toContainText('eng-dev')
    },
  },
  {
    slug: 'side-project',
    label: 'scoped',
    scope: 'scoped',
    check: async (page) => {
      await expect(panelBadge(page)).toHaveText('Scoped')
      await expect(page.getByTestId('department-workdirs')).toContainText('side-project')
      await expect(page.getByTestId('department-skills')).toContainText('management')
      await expect(page.getByTestId('department-warnings')).toContainText('no-such-skill')
      // linked-skill is on the allow-list but holds a symlink: it is not offered, and the panel says why under the skills.
      await expect(page.getByTestId('department-skill-problems')).toContainText('linked-skill is not offered to this department: it contains a symlink (company.md).')
      await expect(page.getByTestId('department-mcp')).toContainText('docs')
      await expect(page.getByTestId('department-mcp')).toContainText('browser')
      await expect(page.getByTestId('department-instructions')).toContainText("then the company's")
      await expect(page.getByTestId('department-yaml')).toContainText('org/side-project/department.yaml')
    },
  },
  {
    slug: 'friend-lab',
    label: 'dedicated',
    scope: 'dedicated',
    check: async (page) => {
      await expect(panelBadge(page)).toHaveText('Dedicated')
      await expect(page.getByTestId('department-scope')).toContainText('only they can hold its Todos')
      await expect(page.getByTestId('department-mcp')).toContainText('None. Scoped sessions get only the jinn server.')
    },
  },
  {
    slug: 'new-lab',
    label: 'a new department.yaml that was refused is held as dedicated',
    scope: 'dedicated',
    check: async (page) => {
      await expect(page.getByTestId('department-definition-error')).toContainText('does not match the directory')
      await expect(panelBadge(page)).toHaveText('Dedicated')
    },
  },
]

/** The badge in the panel, not the ones on the org tree behind it. */
const panelBadge = (page: Page) => page.getByTestId('department-panel').getByTestId('department-scope-badge')
const badgeText = (page: Page, container: string) => page.locator(`${container} [data-testid="department-scope-badge"]`)

/** A Todo in each non-open department, so the switcher and the panel have counts to show. */
test.beforeAll(async ({ request, baseURL }) => {
  const headers = { authorization: `Bearer ${gatewayToken()}`, 'content-type': 'application/json' }
  for (const department of ['side-project', 'friend-lab', 'engineering']) {
    const response = await request.post(`${baseURL}/api/work-items`, { headers, data: { title: `A task in ${department}`, department } })
    expect(response.ok()).toBe(true)
  }
})

for (const theme of THEMES) {
  for (const size of SIZES) {
    test.describe(`${theme}, ${size.name}`, () => {
      test('the board switcher badges scoped and dedicated departments, and no others', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/todos/b/everything')
        await page.getByTestId('board-switcher').click()
        await expect(page.getByTestId('board-menu-side-project')).toBeVisible()
        await expect(badgeText(page, '[data-testid="board-menu-side-project"]')).toHaveText('Scoped')
        await expect(badgeText(page, '[data-testid="board-menu-friend-lab"]')).toHaveText('Dedicated')
        // A department whose only file was refused is held dedicated, but a read does not put it on the board.
        await expect(page.getByTestId('board-menu-new-lab')).toHaveCount(0)
        await expect(badgeText(page, '[data-testid="board-menu-engineering"]')).toHaveCount(0)
        await page.screenshot({ path: screenshotPath('board-switcher', theme, size) })
        await context.close()
      })

      test('the org tree badges each department group box', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/org')
        await expect(page.getByTestId('department-group-side-project')).toBeVisible()
        await expect(badgeText(page, '[data-testid="department-group-side-project"]')).toHaveText('Scoped')
        await expect(badgeText(page, '[data-testid="department-group-friend-lab"]')).toHaveText('Dedicated')
        await expect(badgeText(page, '[data-testid="department-group-engineering"]')).toHaveCount(0)
        await page.screenshot({ path: screenshotPath('org-tree', theme, size) })
        await context.close()
      })

      test('the org tree badges, zoomed so a phone can read them', async ({ browser }) => {
        test.skip(size.name !== 'phone', 'the full-width capture is readable on a desktop')
        const { context, page } = await openPage(browser, theme, size, '/org', { deviceScaleFactor: 3 })
        for (const slug of ['side-project', 'friend-lab']) {
          const box = page.getByTestId(`department-group-${slug}`)
          await expect(box).toBeVisible()
          await box.screenshot({ path: screenshotPath(`org-tree-zoom-${slug}`, theme, size) })
        }
        await context.close()
      })

      for (const state of PANEL_STATES) {
        test(`the department panel: ${state.label}`, async ({ browser }) => {
          const { context, page } = await openPage(browser, theme, tallerFor(size), `/org?department=${state.slug}`)
          const panel = page.getByTestId('department-panel')
          await expect(panel).toBeVisible()
          await expect(panel).toHaveAttribute('data-scope', state.scope)
          await state.check(page)
          await page.screenshot({ path: screenshotPath(`panel-${state.slug}`, theme, size) })
          await context.close()
        })
      }

      test('a refused department.yaml shows its reason and the department keeps its last good scope, live', async ({ browser }) => {
        const file = sandboxFile('org', 'garden', 'department.yaml')
        const good = fs.readFileSync(file, 'utf8')
        const { context, page } = await openPage(browser, theme, tallerFor(size), '/org?department=garden')
        const panel = page.getByTestId('department-panel')
        await expect(panel).toHaveAttribute('data-scope', 'scoped')
        await expect(page.getByTestId('department-definition-error')).toHaveCount(0)
        try {
          fs.writeFileSync(file, 'name: garden\nscope: [broken\n')
          // The watcher reloads the org, the gateway announces the change, and the open panel refetches: no reload here.
          await expect(page.getByTestId('department-definition-error')).toBeVisible({ timeout: 20_000 })
          await expect(page.getByTestId('department-definition-error')).toContainText('The department stays scoped until the file is fixed')
          await expect(panel).toHaveAttribute('data-scope', 'scoped')
          await page.screenshot({ path: screenshotPath('panel-garden-refused-last-good', theme, size) })
        } finally {
          fs.writeFileSync(file, good)
        }
        await expect(page.getByTestId('department-definition-error')).toHaveCount(0, { timeout: 20_000 })
        await context.close()
      })
    })
  }
}

test('clicking a department group box on the org tree opens its panel, and a member opens the employee', async ({ browser }) => {
  const { context, page } = await openPage(browser, 'light', SIZES[0], '/org')
  await page.getByTestId('department-group-side-project').click({ position: { x: 60, y: 6 } })
  await expect(page).toHaveURL(/department=side-project/)
  await expect(page.getByTestId('department-panel')).toBeVisible()
  await page.getByRole('button', { name: 'side-dev' }).click()
  await expect(page).toHaveURL(/employee=side-dev/)
  await expect(page.getByTestId('department-panel')).toHaveCount(0)
  await context.close()
})
