import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Project scoping, phase one, in a browser against a throwaway gateway whose `projects/`
 * directory holds two hand-written YAML files (see scripts/seed-projects.mjs). The journey
 * proves the UI end to end — the project filter on the board, project badges on cards and list
 * rows, the project field in the create dialog and the Todo detail rail, the Projects page, and
 * the switcher — and leaves a light and a dark screenshot of each as evidence.
 */

const home = process.env.JINN_VERIFY_HOME
const artifacts = process.env.JINN_VERIFY_ARTIFACTS
if (!home || !artifacts) throw new Error('JINN_VERIFY_HOME and JINN_VERIFY_ARTIFACTS are required')

const GARDEN = 'prj_0a1b2c3d4e5f'
const BOAT = 'prj_1a2b3c4d5e6f'
const DESKTOP = { width: 1440, height: 900 }
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]

function gatewayToken(): string {
  const gateway = JSON.parse(fs.readFileSync(path.join(home!, 'gateway.json'), 'utf8')) as { token?: unknown }
  if (typeof gateway.token !== 'string' || !gateway.token) throw new Error('sandbox gateway token is missing')
  return gateway.token
}

function shot(name: string, theme: Theme): string {
  const dir = path.join(artifacts!, 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${name}-${theme}.png`)
}

async function openApp(browser: Browser, theme: Theme, viewport = DESKTOP): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    screen: viewport,
    colorScheme: theme,
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
  })
  await context.addInitScript((value: Theme) => {
    localStorage.setItem('jinn-theme', value)
    localStorage.setItem('jinn-onboarded', 'true')
  }, theme)
  const page = await context.newPage()
  await page.goto('/todos', { waitUntil: 'networkidle' })
  return page
}

/** Writes need the page's own origin (the gateway refuses cross-origin mutations), so they run in the page. */
async function createTodo(page: Page, input: { title: string; project?: string }): Promise<string> {
  const id = await page.evaluate(async (body) => {
    const res = await fetch('/api/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { workItem: { id: string } }).workItem.id
  }, input)
  return id
}

/** Menus and dialogs fade in; a screenshot taken mid-fade is evidence of nothing. */
const settle = (page: Page) => page.waitForTimeout(450)

test.describe.configure({ mode: 'serial' })

let todoInGarden = ''
let todoInBoat = ''
let todoWithout = ''

test('seeded YAML files load as projects with no API write involved', async ({ browser }) => {
  const page = await openApp(browser, 'light')
  const listed = await page.evaluate(async () => (await fetch('/api/projects')).json()) as { projects: Array<{ id: string; name: string }> }
  expect(listed.projects.map((p) => p.id).sort()).toEqual([GARDEN, BOAT].sort())

  todoInGarden = await createTodo(page, { title: 'Plan the autumn planting calendar', project: GARDEN })
  todoInBoat = await createTodo(page, { title: 'Collect regatta sign-ups', project: BOAT })
  todoWithout = await createTodo(page, { title: 'Renew the shared domain' })

  // The same Todo reads back with its project on the wire, and the list filter narrows to it.
  const filtered = await page.evaluate(async (project) => (await fetch(`/api/work-items?project=${project}`)).json(), GARDEN) as { workItems: Array<{ id: string }> }
  expect(filtered.workItems.map((w) => w.id)).toEqual([todoInGarden])
  const none = await page.evaluate(async () => (await fetch('/api/work-items?project=none')).json()) as { workItems: Array<{ id: string }> }
  expect(none.workItems.map((w) => w.id)).toContain(todoWithout)
  await page.context().close()
})

for (const theme of THEMES) {
  test(`board: project badges on cards and the project filter chip (${theme})`, async ({ browser }) => {
    const page = await openApp(browser, theme)
    const card = page.getByTestId(`board-card-${todoInGarden}`)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('project-badge')).toHaveText(/Garden Planner/)
    await expect(page.getByTestId(`board-card-${todoWithout}`).getByTestId('project-badge')).toHaveCount(0)
    await page.screenshot({ path: shot('board-card-badges', theme) })

    await page.getByTestId('filter-chip-project').click()
    await expect(page.getByTestId(`filter-project-${GARDEN}`)).toBeVisible()
    await settle(page)
    await page.screenshot({ path: shot('board-filter-chip-open', theme) })

    await page.getByTestId(`filter-project-${GARDEN}`).click()
    await expect(page.getByTestId(`board-card-${todoInGarden}`)).toBeVisible()
    await expect(page.getByTestId(`board-card-${todoInBoat}`)).toHaveCount(0)
    await expect(page.getByTestId(`board-card-${todoWithout}`)).toHaveCount(0)
    await page.screenshot({ path: shot('board-filtered-to-project', theme) })
    await page.context().close()
  })

  test(`list: project badges on rows at phone width (${theme})`, async ({ browser }) => {
    const page = await openApp(browser, theme, { width: 430, height: 900 })
    const row = page.getByTestId(`todo-list-row-${todoInGarden}`)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('project-badge')).toHaveText(/Garden Planner/)
    await expect(page.getByTestId(`todo-list-row-${todoWithout}`).getByTestId('project-badge')).toHaveCount(0)
    await page.screenshot({ path: shot('list-row-badges', theme) })
    await page.context().close()
  })

  test(`create dialog: project field starts a Todo in a project (${theme})`, async ({ browser }) => {
    const page = await openApp(browser, theme)
    await page.getByRole('button', { name: 'New todo' }).first().click()
    await page.getByTestId('todo-new-title').fill(`Order seed potatoes (${theme})`)
    await page.getByRole('button', { name: /Project/ }).first().click()
    await expect(page.getByTestId(`project-option-${GARDEN}`)).toBeVisible()
    await settle(page)
    await page.screenshot({ path: shot('create-dialog-project-field', theme) })
    await page.getByTestId(`project-option-${GARDEN}`).click()
    await page.getByTestId('todo-new-create').click()
    await expect(page.getByTestId('todo-new-title')).toHaveCount(0)
    const created = await page.evaluate(async (title) => {
      const body = (await (await fetch('/api/work-items?limit=200')).json()) as { workItems: Array<{ title: string; project?: { id: string } | null }> }
      return body.workItems.find((w) => w.title === title)?.project?.id ?? null
    }, `Order seed potatoes (${theme})`)
    expect(created).toBe(GARDEN)
    await page.context().close()
  })

  test(`detail: the rail shows and changes the project (${theme})`, async ({ browser }) => {
    const page = await openApp(browser, theme)
    await page.goto(`/todos/${todoWithout}`, { waitUntil: 'networkidle' })
    const rail = page.getByTestId('task-props-rail')
    await expect(rail).toBeVisible()
    await page.screenshot({ path: shot('detail-rail-no-project', theme) })
    await rail.getByTestId('rail-project').click()
    await expect(page.getByTestId(`rail-project-${BOAT}`)).toBeVisible()
    await settle(page)
    await page.screenshot({ path: shot('detail-rail-project-picker', theme) })
    await page.getByTestId(`rail-project-${BOAT}`).click()
    await expect(page.getByTestId(`rail-project-${BOAT}`)).toHaveCount(0)
    await expect(rail).toContainText('Boat Club')
    await page.screenshot({ path: shot('detail-rail-project-set', theme) })
    // Put it back, so the next theme's run starts from the same board.
    await rail.getByTestId('rail-project').click()
    await page.getByTestId('rail-project-none').click()
    await expect(page.getByTestId('rail-project-none')).toHaveCount(0)
    await expect(rail).not.toContainText('Boat Club')
    await page.context().close()
  })

  test(`Projects page and the switcher (${theme})`, async ({ browser }) => {
    const page = await openApp(browser, theme)
    await page.goto('/projects', { waitUntil: 'networkidle' })
    await expect(page.getByTestId(`project-card-${GARDEN}`)).toBeVisible()
    await expect(page.getByTestId(`project-card-${BOAT}`)).toBeVisible()
    await page.screenshot({ path: shot('projects-page', theme) })

    await page.getByTestId(`project-card-${GARDEN}`).getByRole('button', { name: /Garden Planner project/ }).click()
    await expect(page.getByTestId('project-yaml-path')).toHaveText('projects/garden-planner.yaml')
    await page.screenshot({ path: shot('projects-page-detail', theme) })

    // The status-bar switcher narrows the app to one project.
    await page.getByRole('button', { name: /^Project: All projects/ }).first().click()
    await settle(page)
    await page.screenshot({ path: shot('switcher-status-bar', theme) })
    await page.getByRole('menuitem', { name: 'Boat Club' }).click()
    await expect(page.getByRole('button', { name: /^Project: Boat Club/ }).first()).toBeVisible()

    // The chat sidebar carries the same choice.
    await page.goto('/', { waitUntil: 'networkidle' })
    await expect(page.getByTestId('sidebar-project-bar')).toBeVisible()
    await page.screenshot({ path: shot('switcher-chat-sidebar', theme) })
    await page.context().close()
  })
}

test('creating a project from the Projects page writes a YAML file under projects/', async ({ browser }) => {
  const page = await openApp(browser, 'light')
  await page.goto('/projects', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /New project/ }).first().click()
  const form = page.getByTestId('project-create-form')
  await form.getByLabel('Name').fill('Allotment Rota')
  await form.getByRole('button', { name: /^Create/ }).click()
  await expect(page.getByText('Allotment Rota').first()).toBeVisible()
  const written = fs.readdirSync(path.join(home!, 'projects'))
  expect(written).toContain('allotment-rota.yaml')
  expect(fs.readFileSync(path.join(home!, 'projects', 'allotment-rota.yaml'), 'utf8')).toMatch(/^id: prj_[0-9a-f]{12}$/m)
  await page.screenshot({ path: shot('projects-page-created', 'light') })
  await page.context().close()
})
