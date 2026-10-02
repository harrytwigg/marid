import { FileText } from 'lucide-react'

/** A file preview tab's label: a document glyph and the file's basename in code type. */
export function PaneFileTabLabel({ title, active }: { title: string; active: boolean }) {
  return (
    <>
      <FileText size={12} strokeWidth={1.8} aria-hidden className={`shrink-0 ${active ? 'opacity-100' : 'opacity-50'}`} />
      <span data-pane-tab-title className="min-w-0 flex-1 truncate font-[family-name:var(--font-code)]">{title}</span>
    </>
  )
}
