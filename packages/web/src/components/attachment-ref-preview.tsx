import { useRef, useState, type ReactNode } from "react"
import { FileText } from "lucide-react"
import { ImageLightbox, type ImageLightboxItem } from "@/components/ui/image-lightbox"
import { api } from "@/lib/api"
import { parseAttachmentRef, splitAttachmentRefs, type AttachmentRef } from "@/lib/attachment-ref"
import { isImageMime } from "@/routes/todos/task-page/attachment-preview"

/* Todo text carries attachments as refs, not bytes, so the
 * surfaces an operator reads it at have only `attachment:<todo>:<id>:<mime>` to
 * work with. That is enough for the byte route, and the mime is enough to pick
 * a renderer: an image becomes a thumbnail into the shared lightbox, anything
 * else — and any image whose bytes no longer resolve — becomes a named row.
 *
 * Deliberately not built on `useAttachmentPreview`: that hook is keyed on a
 * whole `WorkItemAttachmentWire`, and a ref has no filename, size or uploader
 * to give it. Faking six fields to reuse a hook is not reuse. */

function kindLabel(mime: string): string {
  return (mime.split("/")[1] ?? mime).toUpperCase()
}

/** A ref we could not render as an image: wrong kind, or bytes that are gone. */
function AttachmentRefRow({ attachment }: { attachment: AttachmentRef }) {
  return (
    <a
      href={api.workItemAttachmentUrl(attachment.workItemId, attachment.attachmentId)}
      data-testid={`attachment-ref-file-${attachment.attachmentId}`}
      className="focus-ring inline-flex min-h-[34px] max-w-full items-center gap-2 rounded-[10px] bg-[var(--fill-tertiary)] px-2.5 text-[13px] text-[var(--text-secondary)] no-underline outline-none transition-colors hover:bg-[var(--fill-secondary)]"
    >
      <FileText size={15} strokeWidth={1.8} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="truncate font-medium">{kindLabel(attachment.mime)}</span>
      <span className="shrink-0 text-[11px] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
        {attachment.attachmentId}
      </span>
    </a>
  )
}

function AttachmentRefThumbnail({
  attachment,
  onOpen,
  onFail,
}: {
  attachment: AttachmentRef
  onOpen: (target: HTMLElement) => void
  onFail: () => void
}) {
  const url = api.workItemAttachmentUrl(attachment.workItemId, attachment.attachmentId)
  return (
    <button
      type="button"
      data-testid={`attachment-ref-thumb-${attachment.attachmentId}`}
      aria-label={`Preview ${kindLabel(attachment.mime)} attachment`}
      onClick={(event) => onOpen(event.currentTarget)}
      className="focus-ring grid min-h-[34px] min-w-[34px] place-items-center overflow-hidden rounded-[12px] bg-[var(--fill-tertiary)] outline-none transition-colors hover:bg-[var(--fill-secondary)]"
    >
      <img
        src={`${url}?thumb=1`}
        alt=""
        loading="lazy"
        decoding="async"
        onError={onFail}
        className="block max-h-[168px] w-auto max-w-full object-contain"
      />
    </button>
  )
}

interface AttachmentRefPreview {
  /** One ref rendered: a thumbnail while its bytes resolve, a row otherwise. */
  tile: (attachment: AttachmentRef) => ReactNode
  /** Render once, alongside the tiles — the gallery they share. */
  lightbox: ReactNode
}

/** Shared viewer state for the refs shown together, so they navigate as one
 *  gallery. Shaped like `useAttachmentPreview` next door, for the same reason:
 *  the caller decides the layout, the hook decides what is viewable. */
function useAttachmentRefPreview(refs: AttachmentRef[]): AttachmentRefPreview {
  const [active, setActive] = useState<AttachmentRef | null>(null)
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set())
  const opener = useRef<HTMLElement | null>(null)

  const viewable = refs.filter((ref) => isImageMime(ref.mime) && !broken.has(ref.attachmentId))
  const item = (ref: AttachmentRef): ImageLightboxItem => ({
    id: ref.attachmentId,
    url: api.workItemAttachmentUrl(ref.workItemId, ref.attachmentId),
    name: kindLabel(ref.mime),
  })
  const fail = (ref: AttachmentRef): void => {
    setBroken((current) => new Set(current).add(ref.attachmentId))
    setActive((current) => (current?.attachmentId === ref.attachmentId ? null : current))
  }

  return {
    tile: (attachment) =>
      isImageMime(attachment.mime) && !broken.has(attachment.attachmentId) ? (
        <AttachmentRefThumbnail
          key={attachment.attachmentId}
          attachment={attachment}
          onOpen={(target) => { opener.current = target; setActive(attachment) }}
          onFail={() => fail(attachment)}
        />
      ) : (
        <AttachmentRefRow key={attachment.attachmentId} attachment={attachment} />
      ),
    lightbox: active ? (
      <ImageLightbox
        image={item(active)}
        gallery={viewable.map(item)}
        onNavigate={(next) => setActive(viewable.find((ref) => ref.attachmentId === next.id) ?? active)}
        onClose={() => {
          setActive(null)
          const target = opener.current
          window.setTimeout(() => target?.focus(), 0)
        }}
        onError={() => fail(active)}
      />
    ) : null,
  }
}

/** Every ref in `refs`, wrapped, sharing one lightbox. */
export function AttachmentRefs({ refs }: { refs: AttachmentRef[] }) {
  const preview = useAttachmentRefPreview(refs)
  return (
    <span className="flex flex-wrap items-center gap-2">
      {refs.map(preview.tile)}
      {preview.lightbox}
    </span>
  )
}

/** Prose whose refs render inline, in place. Text carrying no ref is returned
 *  untouched, so this is safe to wrap any operator-facing string in. */
export function AttachmentRefText({ text }: { text: string }) {
  const segments = splitAttachmentRefs(text)
  const refs = segments.flatMap((segment) => (segment.kind === "ref" ? [segment.ref] : []))
  const preview = useAttachmentRefPreview(refs)
  if (refs.length === 0) return <>{text}</>
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {segments.map((segment, index) =>
        segment.kind === "text"
          ? <span key={index} className="whitespace-pre-wrap">{segment.text}</span>
          : preview.tile(segment.ref),
      )}
      {preview.lightbox}
    </span>
  )
}

/** A node-output field value: one ref, a list of them, or neither. */
export function attachmentRefsOf(value: unknown): AttachmentRef[] | null {
  const single = parseAttachmentRef(value)
  if (single) return [single]
  if (!Array.isArray(value) || value.length === 0) return null
  const refs = value.map(parseAttachmentRef)
  return refs.every((ref): ref is AttachmentRef => ref !== null) ? refs : null
}
