import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { formatMessage } from "../chat-messages"
import { inFileLinkSession } from "../file-link-session-context"
import { FileOpenContext, type OpenFile } from "../file-open-context"

function renderLink(openFile: OpenFile | null) {
  render(
    <FileOpenContext.Provider value={openFile}>
      {inFileLinkSession("chat-1", formatMessage("see `/srv/work/report.md`"))}
    </FileOpenContext.Provider>,
  )
  return screen.getByRole("link", { name: "/srv/work/report.md" })
}

// fireEvent.click returns false when the click's default (following the href
// into a new browser tab) was prevented.
describe("chat file links", () => {
  it("open inside the app on a plain click, with the session that linked them", () => {
    const openFile = vi.fn<OpenFile>(() => true)
    const link = renderLink(openFile)

    expect(fireEvent.click(link)).toBe(false)
    expect(openFile).toHaveBeenCalledWith("/srv/work/report.md", "chat-1")
    // The href stays, for a modified click or a copied link.
    expect(link.getAttribute("href")).toBe("/file?path=%2Fsrv%2Fwork%2Freport.md&session=chat-1")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("leave modified and middle clicks to the browser", () => {
    const openFile = vi.fn<OpenFile>(() => true)
    const link = renderLink(openFile)

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, modifier)).toBe(true)
    }
    expect(openFile).not.toHaveBeenCalled()
  })

  it("fall back to a new browser tab when the app cannot open them", () => {
    const declined = renderLink(vi.fn<OpenFile>(() => false))
    expect(fireEvent.click(declined)).toBe(true)
  })

  it("open in a new browser tab where nothing provides an opener", () => {
    const link = renderLink(null)
    expect(fireEvent.click(link)).toBe(true)
    expect(link.getAttribute("title")).toBe("Open /srv/work/report.md in a new tab")
  })
})
