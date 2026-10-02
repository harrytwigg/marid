import { FileText } from "lucide-react"
import { api, type WorkItemAttachmentWire } from "@/lib/api"
import { AttachmentTile, useAttachmentPreview } from "./attachment-preview"
import { formatBytes } from "./attachments"

/* The files a comment carries: previewable ones as tiles that open a lightbox,
 * the rest as download links. */

export function AttachmentChips({ attachments, workItemId }: { attachments: WorkItemAttachmentWire[]; workItemId: string }) {
  const preview = useAttachmentPreview()
  if (attachments.length === 0) return null
  const images = attachments.filter((attachment) => preview.canPreview(attachment))
  return (
    <div className="ml-[38px] mt-[7px] flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        preview.canPreview(attachment) ? (
          <AttachmentTile
            key={attachment.id}
            attachment={attachment}
            preview={preview}
            gallery={images}
            meta={formatBytes(attachment.bytes)}
            dense
            testId={`comment-attachment-${attachment.id}`}
          />
        ) : (
          <a
            key={attachment.id}
            href={api.workItemAttachmentUrl(workItemId, attachment.id)}
            download={attachment.filename}
            data-testid={`comment-attachment-${attachment.id}`}
            className="focus-ring flex h-10 items-center gap-2 rounded-[10px] bg-[var(--fill-tertiary)] pl-2 pr-3 text-[12.5px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-ambient)] outline-none"
          >
            <span className="grid size-6 place-items-center rounded-[7px] bg-[var(--fill-secondary)] text-[var(--text-tertiary)]">
              <FileText size={12} strokeWidth={1.8} aria-hidden />
            </span>
            {attachment.filename}
            <span className="text-[11px] font-normal text-[var(--text-quaternary)]">{formatBytes(attachment.bytes)}</span>
          </a>
        ),
      )}
      {preview.lightbox}
    </div>
  )
}
