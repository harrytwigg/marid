import { useState } from "react"
import { copyText } from "@/platform"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatWhen } from "./errors"

/** An invite or reset link the gateway returns once and never again: the field holds it until the
 *  person dismisses it, and nothing afterwards can bring it back. */
export function IssuedLink({
  link,
  expiresAt,
  hint,
  onDismiss,
  testId = "issued-link",
}: {
  link: string
  expiresAt?: string
  hint?: string
  onDismiss: () => void
  testId?: string
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle")
  const copy = () => {
    void copyText(link).then((result) => setCopied(result.status === "performed" ? "copied" : "failed"))
  }
  return (
    <div
      role="status"
      data-testid={testId}
      className="mt-3 flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-3"
    >
      <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        Shown once. Copy it now and send it to them yourself; it cannot be shown again.
        {expiresAt ? ` Expires ${formatWhen(expiresAt)}.` : ""}
        {hint ? ` ${hint}` : ""}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          readOnly
          aria-label="Link"
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-[40px] min-w-0 flex-1 md:min-h-0"
          style={{ fontFamily: "var(--font-code)" }}
        />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={copy} data-testid={`${testId}-copy`}>
            {copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss} data-testid={`${testId}-dismiss`}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
