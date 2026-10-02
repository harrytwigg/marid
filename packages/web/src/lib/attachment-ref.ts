// The attachment-ref grammar: `attachment:<todo>:<id>:<mime>`. The rejections
// are what matter — a ref is an employee-authored string, so a lax parser here
// would let a path or a whitespace-smuggled token reach an <img> src.

/** One `type/subtype` token: dot, plus and dash may join runs, never repeat. */
const MIME_TOKEN = String.raw`[a-z0-9]+(?:[.+-][a-z0-9]+)*`

const ATTACHMENT_REF = new RegExp(
  String.raw`^attachment:([A-Z]{3}-[1-9][0-9]*):(wia_[0-9a-f]{12}):(${MIME_TOKEN}/${MIME_TOKEN})$`,
)

/** Finds refs embedded in prose. Same grammar, bounded by whitespace or ends. */
const ATTACHMENT_REF_IN_TEXT = new RegExp(
  String.raw`(?<=^|\s)attachment:[A-Z]{3}-[1-9][0-9]*:wia_[0-9a-f]{12}:${MIME_TOKEN}/${MIME_TOKEN}(?=\s|$)`,
  "g",
)

export interface AttachmentRef {
  workItemId: string
  attachmentId: string
  mime: string
}

/** The ref's parts, or `null` if the value is not a ref. */
export function parseAttachmentRef(value: unknown): AttachmentRef | null {
  if (typeof value !== "string") return null
  const match = ATTACHMENT_REF.exec(value)
  if (!match) return null
  return { workItemId: match[1]!, attachmentId: match[2]!, mime: match[3]! }
}

/** A string split into its prose runs and the refs standing between them, in
 *  order. A string with no ref comes back as one text segment. */
export type AttachmentRefSegment =
  | { kind: "text"; text: string }
  | { kind: "ref"; ref: AttachmentRef }

export function splitAttachmentRefs(text: string): AttachmentRefSegment[] {
  const segments: AttachmentRefSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(ATTACHMENT_REF_IN_TEXT)) {
    const ref = parseAttachmentRef(match[0])
    if (!ref) continue
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) })
    segments.push({ kind: "ref", ref })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) })
  return segments
}
