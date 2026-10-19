import { fireEvent, render, screen } from "@testing-library/react"
import { Link } from "react-aria-components"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { AriaRouter } from "../aria-router"

function Where() {
  const { pathname, state } = useLocation()
  return <p data-testid="where">{pathname + (state ? ` ${JSON.stringify(state)}` : "")}</p>
}

function renderLink(link: React.ReactNode) {
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <AriaRouter>
        {link}
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </AriaRouter>
    </MemoryRouter>,
  )
}

describe("AriaRouter", () => {
  it("routes a React Aria link through the app's router", () => {
    renderLink(<Link href="/todos">Todos</Link>)

    fireEvent.click(screen.getByRole("link", { name: "Todos" }))

    expect(screen.getByTestId("where").textContent).toBe("/todos")
  })

  it("passes the link's router options on to the navigation", () => {
    renderLink(<Link href="/chat" routerOptions={{ state: { from: "menu" } }}>Chat</Link>)

    fireEvent.click(screen.getByRole("link", { name: "Chat" }))

    expect(screen.getByTestId("where").textContent).toBe('/chat {"from":"menu"}')
  })
})
