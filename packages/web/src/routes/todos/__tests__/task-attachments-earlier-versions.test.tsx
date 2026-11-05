import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemAttachmentWire } from "@/lib/api"
import { AttachmentsSection } from "../task-page/attachments"

/* A same-name re-attach supersedes the earlier row. The strip shows the current
 * files; the replaced versions sit in a collapsed list that can still download
 * and remove them. */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: { ...actual.api, workItemAttachmentUrl: (id: string, aid: string) => `/api/work-items/${id}/attachments/${aid}` },
  }
})

function row(id: string, extra: Partial<WorkItemAttachmentWire> = {}): WorkItemAttachmentWire {
  return {
    id,
    workItemId: "TSK-1",
    commentId: null,
    filename: "notes.md",
    mime: "text/markdown",
    bytes: 2048,
    sha256: "0".repeat(64),
    storagePath: "/x",
    uploadedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededBy: null,
    ...extra,
  }
}

describe("AttachmentsSection earlier versions", () => {
  it("shows the current file in the strip and the superseded one under a collapsed 'Earlier versions' list", () => {
    const onRemove = vi.fn()
    const older = row("wia_000000000001", { supersededBy: "wia_000000000002" })
    const current = row("wia_000000000002", { earlierVersions: [older.id] })
    render(<AttachmentsSection attachments={[older, current]} onUpload={vi.fn()} onRemove={onRemove} />)

    const strip = screen.getByTestId("attachment-strip")
    expect(within(strip).getAllByRole("link")).toHaveLength(1)
    expect(screen.getByTestId("attachment-chip-wia_000000000002")).toBeTruthy()
    expect(screen.queryByTestId("attachment-chip-wia_000000000001")).toBeNull()

    const details = screen.getByTestId("attachment-earlier-versions") as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText("Earlier versions (1)")).toBeTruthy()
    const earlier = screen.getByTestId("attachment-earlier-wia_000000000001")
    expect(within(earlier).getByRole("link").getAttribute("href")).toBe("/api/work-items/TSK-1/attachments/wia_000000000001")
    fireEvent.click(screen.getByTestId("attachment-remove-wia_000000000001"))
    expect(onRemove).toHaveBeenCalledWith(older)
  })

  it("lists no earlier-versions section when nothing was superseded, and ignores comment rows", () => {
    const onItem = row("wia_000000000003")
    const onComment = row("wia_000000000004", { commentId: "wic_0a1b2c3d4e5f" })
    render(<AttachmentsSection attachments={[onItem, onComment]} onUpload={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.queryByTestId("attachment-earlier-versions")).toBeNull()
    expect(screen.getAllByRole("link")).toHaveLength(1)
  })
})
