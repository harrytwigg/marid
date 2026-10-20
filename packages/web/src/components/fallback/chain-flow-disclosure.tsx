import { useState } from "react"
import { ChevronDown, ChevronRight } from "@/components/ui/icon"
import { ChainFlow, type ChainFlowInput } from "./chain-flow"

/** The diagram behind a toggle: a card of chains stays a list of rows until
 *  someone asks to see the flow, and the diagram's code loads only then. */
export function ChainFlowDisclosure({ title = "Diagram", ...input }: ChainFlowInput & { title?: string }) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="mt-[var(--space-2)]" data-chain-flow-disclosure>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-[32px] cursor-pointer items-center gap-[4px] rounded-[8px] border-none bg-transparent px-[4px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      >
        <Chevron size={13} aria-hidden />
        {title}
      </button>
      {open && <ChainFlow {...input} />}
    </div>
  )
}
