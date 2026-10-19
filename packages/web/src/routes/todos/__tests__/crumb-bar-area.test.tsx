import { render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { AREAS } from "@/contrib/types"
import { contributeProbes, describeHostedArea } from "@/contrib/__tests__/hosted-area"
import { CrumbBar } from "../task-page/crumb-bar"

/* The crumb bar hosts `todo.detail.actions`. The contributed actions
 * lead the bar's right-hand group, so the app's own copy-link and ⋯ keep the
 * edge position the muscle memory expects. */

function renderCrumbBar() {
  render(
    <CrumbBar
      boardLabel="Platform"
      onBack={() => {}}
      ancestors={[]}
      id="TSK-12"
      title="A Todo"
      onOpenAncestor={() => {}}
      onCopyId={() => {}}
      mobile={false}
    />,
  )
}

describeHostedArea("the crumb bar", {
  area: AREAS.todoDetailActions,
  variant: "chip",
  renderHost: async () => renderCrumbBar(),
  findHostContent: async () => screen.getByTestId("task-copy-link"),
})

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
})

it("puts a contributed action inside the action group, ahead of copy-link", () => {
  dispose = contributeProbes(AREAS.todoDetailActions, [{ id: "widget" }])

  renderCrumbBar()

  const contributed = screen.getByTestId("probe-widget")
  const copyLink = screen.getByTestId("task-copy-link")
  const actionGroup = copyLink.parentElement

  expect(actionGroup?.contains(contributed)).toBe(true)
  expect(contributed.compareDocumentPosition(copyLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it("scrolls contributed actions instead of pushing copy-link and ⋯ off a narrow bar", () => {
  dispose = contributeProbes(AREAS.todoDetailActions, [{ id: "widget" }])

  renderCrumbBar()

  const copyLink = screen.getByTestId("task-copy-link")
  const strip = screen.getByTestId("probe-widget").closest("div[class*='overflow-x-auto']")

  expect(strip).not.toBeNull()
  expect(copyLink.className).toContain("flex-none")
  expect(screen.getByTestId("task-crumb-more").className).toContain("flex-none")
})
