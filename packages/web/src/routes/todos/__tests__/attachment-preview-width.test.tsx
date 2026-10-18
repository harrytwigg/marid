import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemAttachmentWire } from "@/lib/api"
import { AttachmentTile, useAttachmentPreview } from "../task-page/attachment-preview"

vi.mock("@/lib/api", () => ({
  api: {
    workItemAttachmentUrl: (id: string, attachmentId: string) => `/api/work-items/${id}/attachments/${attachmentId}`,
  },
}))

const clip: WorkItemAttachmentWire = {
  id: "att-1",
  workItemId: "TST-1",
  commentId: null,
  filename: "clip.mp4",
  mime: "video/mp4",
  bytes: 2048,
  sha256: "0".repeat(64),
  storagePath: "attachments/clip.mp4",
  uploadedBy: "employee",
  createdAt: "2026-01-01T00:00:00.000Z",
}

function VideoPreview() {
  const preview = useAttachmentPreview()
  return (
    <>
      <AttachmentTile attachment={clip} preview={preview} gallery={[clip]} testId="attachment-tile" />
      {preview.lightbox}
    </>
  )
}

describe("AttachmentVideoDialog width", () => {
  it("beats the dialog's own sm:max-w-lg cap so the box can reach 960px", () => {
    render(<VideoPreview />)
    fireEvent.click(screen.getByTestId("attachment-tile"))
    const classes = screen.getByTestId("attachment-video-dialog").className.split(/\s+/)
    // DialogContent's base class caps every dialog at `sm:max-w-lg` (512px), and a
    // bare `max-w-none` is a different utility — it leaves the `sm:` variant in the
    // merged class list and loses to it above 640px. Only an `sm:` override makes
    // tailwind-merge drop the cap.
    expect(classes).toContain("sm:max-w-none")
    expect(classes).not.toContain("sm:max-w-lg")
  })
})
