import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { formatMessage } from "../chat-messages"
import { inFileLinkSession } from "../file-link-session-context"

// The thread peek renders message text outside any chat pane; this is how its
// file links learn which session (and so which host) they belong to.
describe("inFileLinkSession", () => {
  it("binds message file links to the given session", () => {
    render(<>{inFileLinkSession("peek-1", formatMessage("see `/srv/work/report.md`"))}</>)

    const link = screen.getByRole("link", { name: "/srv/work/report.md" })
    expect(link.getAttribute("href")).toBe("/file?path=%2Fsrv%2Fwork%2Freport.md&session=peek-1")
    expect(link.getAttribute("target")).toBe("_blank")
  })

  it("leaves session paths unlinked when the peek has no session", () => {
    render(<>{inFileLinkSession(undefined, formatMessage("see `/srv/work/report.md`"))}</>)

    expect(screen.queryByRole("link")).toBeNull()
  })
})
