// The dialogs, the lightbox and the phone sheet, each photographed open. They sit in their own file so
// screens.mjs stays under the size ratchet; it spreads them into SCREENS.
const BOARD_READY = 'Draft the release checklist'

const visible = (page, testIds) =>
  page.locator(testIds.map((id) => `[data-testid="${id}"]`).join(', ')).locator('visible=true').first()

async function openNewTodo(page) {
  await visible(page, ['todo-new', 'todo-new-fab']).click()
  await page.getByTestId('todo-new-title').waitFor({ state: 'visible', timeout: 10_000 })
}

async function openSprintPlanner(page, narrow) {
  if (narrow) {
    await page.getByTestId('todo-mobile-filters').click()
    await page.getByTestId('todo-filter-sheet').getByRole('button', { name: /^Sprint/ }).click()
    await page.getByRole('button', { name: 'Manage sprints…' }).click()
  } else {
    await page.getByTestId('filter-chip-sprint').click()
    await page.getByTestId('filter-sprint-manage').click()
  }
  await page.getByTestId('sprints-dialog').waitFor({ state: 'visible', timeout: 10_000 })
}

export const DIALOG_SCREENS = [
  {
    // The create dialog over the board: a sheet from the bottom on a phone, centred from `sm` up.
    name: 'new-todo-dialog',
    title: 'New Todo dialog',
    url: () => '/todos',
    ready: BOARD_READY,
    prepare: async (page) => {
      await openNewTodo(page)
      await page.getByTestId('todo-new-title').fill('Write the release notes')
      await page.waitForTimeout(500)
    },
  },
  {
    // The sprint planner, opened from the filter menu on a desktop and from the filter sheet on a phone.
    name: 'sprints-dialog',
    title: 'Sprints dialog',
    url: () => '/todos',
    ready: BOARD_READY,
    prepare: async (page) => {
      await openSprintPlanner(page, (page.viewportSize()?.width ?? 1440) < 700)
      await page.waitForTimeout(500)
    },
  },
  {
    // An attachment opened full screen, with its previous and next arrows.
    name: 'lightbox',
    title: 'Image lightbox',
    url: (f) => `/todos/${f.todos[0]}`,
    ready: 'Neutral fixture used for interface captures.',
    prepare: async (page) => {
      await page.locator('[data-testid^="attachment-tile-"]').locator('visible=true').first().click()
      await page.getByTestId('attachment-lightbox-image').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(600)
    },
  },
  {
    // The phone's filter sheet: bottom anchored, with its drag handle and safe-area padding.
    name: 'filter-sheet',
    viewports: ['narrow'],
    title: 'Filter sheet, phone',
    url: () => '/todos',
    ready: BOARD_READY,
    prepare: async (page) => {
      await page.getByTestId('todo-mobile-filters').click()
      await page.getByTestId('todo-filter-sheet').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(500)
    },
  },
]
