import { expect, test, type Page } from '@playwright/test'
import { openPage, screenshotPath, SIZES, THEMES, type Size, type Theme } from './departments.context'

/**
 * The employee editor's Department control against department scope. The API refuses a move
 * into or out of a scoped or dedicated department (the field has to agree with where the file
 * sits under org/), so the editor shows those departments disabled for an employee of an open
 * department, and makes the control read-only for a member of one, with the reason either way.
 */

const HINT = /Scope follows the file location under org\/.*; move the YAML by hand\./

async function openEditor(page: Page) {
  await page.getByRole('button', { name: 'Edit employee' }).click()
  await expect(page.getByText('Edit employee', { exact: true })).toBeVisible()
}

const shoot = (page: Page, name: string, theme: Theme, size: Size) => page.screenshot({ path: screenshotPath(name, theme, size) })

for (const theme of THEMES) {
  for (const size of SIZES) {
    test.describe(`${theme}, ${size.name}`, () => {
      test('an open department member sees scoped and dedicated departments disabled', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/org?employee=eng-dev')
        await openEditor(page)
        await expect(page.getByTestId('department-file-move-hint')).toHaveText(HINT)
        await shoot(page, 'employee-editor-open-member', theme, size)
        await page.getByRole('combobox', { name: 'Department' }).click()
        await expect(page.getByRole('option', { name: 'workshop' })).not.toHaveAttribute('aria-disabled', 'true')
        for (const slug of ['side-project', 'friend-lab', 'garden', 'new-lab']) {
          await expect(page.getByRole('option', { name: new RegExp(`^${slug}`) })).toHaveAttribute('aria-disabled', 'true')
        }
        await page.waitForTimeout(300) // the menu animates in; capture it settled
        await shoot(page, 'employee-editor-open-member-menu', theme, size)
        await context.close()
      })

      test('a scoped department member sees the department read-only', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/org?employee=side-dev')
        await openEditor(page)
        await expect(page.getByTestId('confined-readonly-department')).toHaveText('side-project')
        await expect(page.getByRole('combobox', { name: 'Department' })).toHaveCount(0)
        await expect(page.getByTestId('department-file-move-hint')).toHaveText('Scope follows the file location under org/side-project; move the YAML by hand.')
        await shoot(page, 'employee-editor-scoped-member', theme, size)
        await context.close()
      })

      test('a dedicated department member sees the department read-only', async ({ browser }) => {
        const { context, page } = await openPage(browser, theme, size, '/org?employee=friend-lead')
        await openEditor(page)
        await expect(page.getByTestId('confined-readonly-department')).toHaveText('friend-lab')
        await expect(page.getByTestId('department-file-move-hint')).toHaveText('Scope follows the file location under org/friend-lab; move the YAML by hand.')
        await shoot(page, 'employee-editor-dedicated-member', theme, size)
        await context.close()
      })
    })
  }
}
