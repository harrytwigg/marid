import { expect, test, type Page } from '@playwright/test'
import { gatewayToken, linkSeededSession, openPage, screenshotPath, SIZES, tallerFor, THEMES, type Size, type Theme } from './departments.context'

/**
 * Scope editing in the department panel, and the department badge on sessions: the control in
 * each state, the refusal that names who holds a stranded Todo, and the badge on the chat
 * sidebar's rows and the Todo page's session tree. Nothing here starts an engine turn: the
 * sessions are rows seeded straight into the registry.
 */

let todoId = ''

const authHeaders = () => ({ authorization: `Bearer ${gatewayToken()}`, 'content-type': 'application/json' })
const panelUrl = (slug: string) => `/org?department=${slug}`
const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true })
const shoot = (page: Page, name: string, theme: Theme, size: Size) => page.screenshot({ path: screenshotPath(name, theme, size) })

/** A Todo in side-project held by an employee of an open department: a change to dedicated strands it. */
test.beforeAll(async ({ request, baseURL }) => {
  const created = await request.post(`${baseURL}/api/work-items`, { headers: authHeaders(), data: { title: 'Release checklist', department: 'side-project', autoStart: false } })
  expect(created.ok()).toBe(true)
  todoId = ((await created.json()) as { workItem: { id: string } }).workItem.id
  const assigned = await request.post(`${baseURL}/api/work-items/${todoId}/assign`, { headers: authHeaders(), data: { assignee: 'eng-dev' } })
  expect(assigned.ok()).toBe(true)
  expect(((await assigned.json()) as { workItem: { department: string } }).workItem.department).toBe('side-project')
  linkSeededSession('scoped-build', todoId)
})

for (const theme of THEMES) {
  for (const size of SIZES) {
    test.describe(`${theme}, ${size.name}`, () => {
      const panel = async (browser: Parameters<typeof openPage>[0], slug: string) => {
        const opened = await openPage(browser, theme, tallerFor(size), panelUrl(slug))
        await expect(opened.page.getByTestId('department-panel')).toBeVisible()
        return opened
      }

      test('scope control: open is selected', async ({ browser }) => {
        const { context, page } = await panel(browser, 'workshop')
        await expect(radio(page, 'Open')).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('button', { name: 'Save scope' })).toHaveCount(0)
        await shoot(page, 'scope-control-open', theme, size)
        await context.close()
      })

      test('scope control: scoped is selected', async ({ browser }) => {
        const { context, page } = await panel(browser, 'side-project')
        await expect(radio(page, 'Scoped')).toHaveAttribute('aria-checked', 'true')
        await shoot(page, 'scope-control-scoped', theme, size)
        await context.close()
      })

      test('scope control: a pick is staged and sends nothing until saved', async ({ browser }) => {
        const { context, page } = await panel(browser, 'workshop')
        const writes: string[] = []
        page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request.url()) })
        await radio(page, 'Scoped').click()
        await expect(page.getByTestId('department-scope')).toContainText('Its employees are confined to this department')
        await expect(page.getByRole('button', { name: 'Save scope' })).toBeVisible()
        await expect(radio(page, 'Scoped')).toHaveAttribute('aria-checked', 'true')
        await page.waitForTimeout(400) // the pills fade between states; capture them settled
        await shoot(page, 'scope-control-staged', theme, size)
        await page.getByRole('button', { name: 'Cancel' }).click()
        await expect(radio(page, 'Open')).toHaveAttribute('aria-checked', 'true')
        expect(writes).toEqual([])
        await context.close()
      })

      test('scope control: a change that would strand a Todo is refused, naming who holds it', async ({ browser }) => {
        const { context, page } = await panel(browser, 'side-project')
        await radio(page, 'Dedicated').click()
        await page.getByRole('button', { name: 'Save scope' }).click()
        const alert = page.getByTestId('department-scope-error')
        await expect(alert).toBeVisible()
        await expect(alert).toHaveAttribute('role', 'alert')
        await expect(alert.getByRole('link', { name: todoId })).toHaveAttribute('href', `/todos/${todoId}`)
        await expect(alert).toContainText('held by eng-dev')
        // The refusal changed nothing: the saved scope is still scoped, and the pick is still staged.
        await expect(page.getByTestId('department-panel')).toHaveAttribute('data-scope', 'scoped')
        await expect(radio(page, 'Dedicated')).toHaveAttribute('aria-checked', 'true')
        await page.waitForTimeout(400)
        await shoot(page, 'scope-control-stranded-refusal', theme, size)
        await context.close()
      })

      test('scope control: a refused department.yaml has no control', async ({ browser }) => {
        const { context, page } = await panel(browser, 'new-lab')
        await expect(page.getByTestId('department-definition-error')).toBeVisible()
        await expect(page.getByRole('radio')).toHaveCount(0)
        await expect(page.getByTestId('department-scope')).toContainText('cannot be changed until department.yaml is fixed')
        await shoot(page, 'scope-control-refused-read-only', theme, size)
        await context.close()
      })

      test('session badge: the chat sidebar', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/', { chatListOpen: true })
        await expect(page.getByTestId('session-department-badge')).toHaveCount(2)
        await expect(page.getByTestId('session-department-badge').first()).toBeVisible()
        await expect(page.getByTestId('session-department-badge').first()).toHaveText('side-project')
        await expect(page.getByTestId('session-department-badge').first()).toHaveAttribute('title', 'Bound to department side-project: this session works only inside it')
        if (size.name === 'phone') await expect(page.locator('[data-row="mobile"]').filter({ has: page.getByTestId('session-department-badge') })).toHaveCount(2)
        // The row that is not bound has none.
        await expect(page.locator('[data-chat-session-row], [data-row="mobile"]').filter({ hasText: 'Plan the next release' }).getByTestId('session-department-badge')).toHaveCount(0)
        await shoot(page, size.name === 'phone' ? 'session-badge-mobile-row' : 'session-badge-chat-sidebar', theme, size)
        await context.close()
      })

      test('session badge: the chat sidebar tree view', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/', { chatListOpen: true })
        await page.evaluate(() => localStorage.setItem('jinn-sidebar-focus-mode', 'tree'))
        await page.goto('/', { waitUntil: 'networkidle' })
        await expect(page.getByTestId('session-department-badge')).toHaveCount(2)
        await expect(page.getByTestId('session-department-badge').first()).toBeVisible()
        await shoot(page, 'session-badge-sidebar-tree', theme, size)
        await context.close()
      })

      test('session badge: a Team group expanded to its sessions', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/', { chatListOpen: true })
        await expect(page.getByTestId('session-department-badge')).toHaveCount(2)
        await page.getByRole('button', { name: /side-dev.*2 chats/ }).click()
        // Expanding a group also opens its newest chat, which on a phone takes the screen:
        // go back to the list, which keeps the group expanded.
        if (size.name === 'phone') {
          await page.getByRole('button', { name: 'Back to chats' }).click()
          await expect(page.getByRole('button', { name: 'Back to chats' })).toBeHidden()
        }
        await expect(page.getByTestId('session-department-badge')).toHaveCount(4)
        // No pointer over a row (its menu would cover the time), and the list settled.
        await page.mouse.move(size.width - 1, size.height - 1)
        await page.waitForTimeout(500)
        await shoot(page, 'session-badge-team-group', theme, size)
        await context.close()
      })

      test('session badge: the Todo page session tree', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, `/todos/${todoId}`)
        const node = page.getByTestId('session-tree').locator('[data-testid^="session-tree-node-"]')
        await expect(node).toHaveCount(1)
        await expect(node.getByTestId('session-department-badge')).toHaveText('side-project')
        await shoot(page, 'session-badge-todo-tree', theme, size)
        await context.close()
      })
    })
  }
}

test('saving a scope updates the panel and the org tree', async ({ browser, request, baseURL }) => {
  const { context, page } = await openPage(browser, 'light', tallerFor(SIZES[0]), panelUrl('workshop'))
  try {
    await radio(page, 'Scoped').click()
    await page.getByRole('button', { name: 'Save scope' }).click()
    await expect(page.getByTestId('department-panel')).toHaveAttribute('data-scope', 'scoped')
    await expect(page.getByTestId('department-panel').getByTestId('department-scope-badge')).toHaveText('Scoped')
    await expect(page.getByRole('button', { name: 'Save scope' })).toHaveCount(0)
    // The org tree behind the panel reads the departments list, which the save refetched.
    await expect(page.locator('[data-testid="department-group-workshop"] [data-testid="department-scope-badge"]')).toHaveText('Scoped')
  } finally {
    const restored = await request.patch(`${baseURL}/api/departments/workshop`, { headers: authHeaders(), data: { scope: 'open' } })
    expect(restored.ok()).toBe(true)
    await context.close()
  }
})

test('the sandbox starts no scheduled turn: the board walk is switched off and no walk session exists', async ({ request, baseURL }) => {
  const jobs = (await (await request.get(`${baseURL}/api/cron`, { headers: authHeaders() })).json()) as Array<{ id: string; enabled: boolean }>
  expect(jobs.length).toBeGreaterThan(0)
  expect(jobs.filter((job) => job.enabled)).toEqual([])
  const { sessions } = (await (await request.get(`${baseURL}/api/sessions`, { headers: authHeaders() })).json()) as { sessions: Array<{ title: string | null }> }
  expect(sessions.filter((session) => /board walk/i.test(session.title ?? ''))).toEqual([])
})
