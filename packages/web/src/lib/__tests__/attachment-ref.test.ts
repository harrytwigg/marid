import { describe, expect, it } from "vitest"
import { parseAttachmentRef, splitAttachmentRefs } from "../attachment-ref"

const REF = "attachment:TSK-135:wia_ab12cd34ef56:image/png"

describe("parseAttachmentRef", () => {
  it("parses a well-formed ref", () => {
    expect(parseAttachmentRef(REF)).toEqual({
      workItemId: "TSK-135",
      attachmentId: "wia_ab12cd34ef56",
      mime: "image/png",
    })
  })

  // The rejections are the point: whatever this accepts becomes an <img> src.
  it.each([
    ["a bare filename", "screenshot.png"],
    ["an absolute path", "/etc/passwd"],
    ["a parent-directory hop", "attachment:TSK-135:wia_ab12cd34ef56:../../etc/passwd"],
    ["a hop inside the id", "attachment:TSK-135:wia_../../../etc:image/png"],
    ["a slash outside the mime", "attachment:TSK/135:wia_ab12cd34ef56:image/png"],
    ["a second slash in the mime", "attachment:TSK-135:wia_ab12cd34ef56:image/png/x"],
    ["surrounding whitespace", ` ${REF} `],
    ["inner whitespace", "attachment:TSK-135:wia_ab12cd34ef56:image/p ng"],
    ["a malformed attachment id", "attachment:TSK-135:wia_ab12cd34ef5:image/png"],
    ["a URL", "https://example.com/shot.png"],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseAttachmentRef(value)).toBeNull()
  })

  it("rejects a non-string", () => {
    expect(parseAttachmentRef(null)).toBeNull()
    expect(parseAttachmentRef(42)).toBeNull()
  })
})

describe("splitAttachmentRefs", () => {
  it("returns prose with no ref as a single text segment", () => {
    expect(splitAttachmentRefs("Ship it?")).toEqual([{ kind: "text", text: "Ship it?" }])
  })

  it("pulls a ref out of the sentence around it", () => {
    expect(splitAttachmentRefs(`Ship this? ${REF} Looks right?`)).toEqual([
      { kind: "text", text: "Ship this? " },
      { kind: "ref", ref: { workItemId: "TSK-135", attachmentId: "wia_ab12cd34ef56", mime: "image/png" } },
      { kind: "text", text: " Looks right?" },
    ])
  })

  it("finds every ref in order", () => {
    const other = "attachment:TSK-135:wia_00112233aabb:application/pdf"
    const segments = splitAttachmentRefs(`${REF} and ${other}`)
    expect(segments.filter((segment) => segment.kind === "ref").map((segment) => segment.ref.attachmentId))
      .toEqual(["wia_ab12cd34ef56", "wia_00112233aabb"])
  })

  it("leaves a ref glued to other characters as plain text", () => {
    expect(splitAttachmentRefs(`see(${REF})`)).toEqual([{ kind: "text", text: `see(${REF})` }])
  })

  it("returns nothing for an empty string", () => {
    expect(splitAttachmentRefs("")).toEqual([])
  })
})
