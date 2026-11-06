import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const loaded = vi.hoisted(() => vi.fn())
vi.mock("../board-share-dialog", () => {
  loaded()
  return {
    BoardShareDialog: ({ department, mode, onClose }: { department: string; mode: string; onClose: () => void }) => (
      <div data-testid="stub-dialog">
        {department}:{mode}
        <button onClick={onClose}>close</button>
      </div>
    ),
  }
})

import { ShareBoardButton } from "../share-board-button"

describe("ShareBoardButton", () => {
  it("does not load the dialog until the button is pressed", () => {
    render(<ShareBoardButton department="design" mode="operator" />)
    expect(loaded).not.toHaveBeenCalled()
    expect(screen.queryByTestId("stub-dialog")).toBeNull()
  })

  it("opens the dialog on a press and closes it again", async () => {
    render(<ShareBoardButton department="design" mode="member" ownRole="owner" selfUserId="usr_1" />)
    fireEvent.click(screen.getByTestId("board-share"))
    expect((await screen.findByTestId("stub-dialog")).textContent).toContain("design:member")
    expect(loaded).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("close"))
    expect(screen.queryByTestId("stub-dialog")).toBeNull()
  })

  it("starts loading the dialog when the pointer reaches the button", async () => {
    render(<ShareBoardButton department="design" mode="operator" />)
    fireEvent.pointerEnter(screen.getByTestId("board-share"))
    await vi.waitFor(() => expect(loaded).toHaveBeenCalled())
    expect(screen.queryByTestId("stub-dialog")).toBeNull()
  })
})
