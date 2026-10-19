import "@/test/preload-dialogs"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AttachmentRefText, AttachmentRefs, attachmentRefsOf } from "../attachment-ref-preview"
import { parseAttachmentRef, type AttachmentRef } from "@/lib/attachment-ref"
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport"

const IMAGE = "attachment:PLA-135:wia_ab12cd34ef56:image/png"
const PDF = "attachment:PLA-135:wia_00112233aabb:application/pdf"
const ACTIVE_ORIGIN = "https://qa-a.example:7779"

let restoreTransport: (() => void) | null = null

beforeEach(() => {
  restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
    origin: ACTIVE_ORIGIN,
    request: vi.fn(),
    navigate: vi.fn(),
  }))
})

afterEach(() => {
  restoreTransport?.()
  restoreTransport = null
})

function ref(value: string): AttachmentRef {
  return parseAttachmentRef(value)!
}

describe("attachmentRefsOf", () => {
  it("reads a single ref and a list of them", () => {
    expect(attachmentRefsOf(IMAGE)).toEqual([ref(IMAGE)])
    expect(attachmentRefsOf([IMAGE, PDF])).toEqual([ref(IMAGE), ref(PDF)])
  })

  it("claims nothing it cannot fully parse", () => {
    expect(attachmentRefsOf("Looks good")).toBeNull()
    expect(attachmentRefsOf([IMAGE, "plain"])).toBeNull()
    expect(attachmentRefsOf([])).toBeNull()
    expect(attachmentRefsOf(42)).toBeNull()
    expect(attachmentRefsOf({ shot: IMAGE })).toBeNull()
  })
})

describe("AttachmentRefs", () => {
  it("renders an image ref as a thumbnail off the attachment's own byte route", () => {
    render(<AttachmentRefs refs={[ref(IMAGE)]} />)
    const thumb = screen.getByTestId("attachment-ref-thumb-wia_ab12cd34ef56")
    expect(thumb.querySelector("img")?.getAttribute("src"))
      .toBe(`${ACTIVE_ORIGIN}/api/work-items/PLA-135/attachments/wia_ab12cd34ef56?thumb=1`)
  })

  it("renders a non-image ref as a named file row, never an image", () => {
    render(<AttachmentRefs refs={[ref(PDF)]} />)
    const row = screen.getByTestId("attachment-ref-file-wia_00112233aabb")
    expect(row.getAttribute("href")).toBe(`${ACTIVE_ORIGIN}/api/work-items/PLA-135/attachments/wia_00112233aabb`)
    expect(row.querySelector("img")).toBeNull()
    expect(row.textContent).toContain("PDF")
    expect(screen.queryByTestId("attachment-ref-thumb-wia_00112233aabb")).toBeNull()
  })

  it("falls back to the file row when the bytes no longer resolve", () => {
    render(<AttachmentRefs refs={[ref(IMAGE)]} />)
    fireEvent.error(screen.getByTestId("attachment-ref-thumb-wia_ab12cd34ef56").querySelector("img")!)

    expect(screen.queryByTestId("attachment-ref-thumb-wia_ab12cd34ef56")).toBeNull()
    expect(screen.getByTestId("attachment-ref-file-wia_ab12cd34ef56")).toBeTruthy()
  })

  it("opens the shared lightbox on the full-size image", () => {
    render(<AttachmentRefs refs={[ref(IMAGE), ref(PDF)]} />)
    fireEvent.click(screen.getByTestId("attachment-ref-thumb-wia_ab12cd34ef56"))

    const lightbox = screen.getByTestId("attachment-lightbox")
    expect(lightbox.querySelector("img")?.getAttribute("src"))
      .toBe(`${ACTIVE_ORIGIN}/api/work-items/PLA-135/attachments/wia_ab12cd34ef56`)
  })
})

describe("AttachmentRefText", () => {
  it("leaves prose carrying no ref exactly as it was", () => {
    const { container } = render(<AttachmentRefText text="Ship it?" />)
    expect(container.textContent).toBe("Ship it?")
    expect(container.querySelector("img")).toBeNull()
  })

  it("renders a ref in place, keeping the words around it", () => {
    const { container } = render(<AttachmentRefText text={`Ship this? ${IMAGE} Right?`} />)
    expect(container.textContent).toContain("Ship this?")
    expect(container.textContent).toContain("Right?")
    expect(container.textContent).not.toContain("wia_ab12cd34ef56:image/png")
    expect(screen.getByTestId("attachment-ref-thumb-wia_ab12cd34ef56")).toBeTruthy()
  })
})
