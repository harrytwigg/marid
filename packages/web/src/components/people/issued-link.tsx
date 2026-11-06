import { useState } from "react"
import { copyText } from "@/platform"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatWhen } from "./errors"

interface IssuedLinkProps {
  /** Null when the gateway could not build one (it could not tell which address people reach it by). */
  link: string | null
  expiresAt?: string
  hint?: string
  onDismiss: () => void
  testId?: string
}

/** An invite or reset link the gateway returns once and never again: the field holds it until the
 *  person dismisses it, and nothing afterwards can bring it back. */
export function IssuedLink(props: IssuedLinkProps) {
  const testId = props.testId ?? "issued-link"
  return props.link
    ? <LinkBox {...props} link={props.link} testId={testId} />
    : <LinkUnavailable onDismiss={props.onDismiss} testId={testId} />
}

function LinkUnavailable({ onDismiss, testId }: { onDismiss: () => void; testId: string }) {
  return (
    <div role="alert" data-testid={`${testId}-unavailable`} className="mt-3 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-3">
      <p className="min-w-0 flex-1 text-[length:var(--text-footnote)] text-[var(--system-orange)]">
        Couldn&rsquo;t build the link; open this page from the address people will use.
      </p>
      <Button variant="ghost" size="sm" onClick={onDismiss} data-testid={`${testId}-dismiss`}>
        Done
      </Button>
    </div>
  )
}

function LinkBox({ link, expiresAt, hint, onDismiss, testId }: IssuedLinkProps & { link: string; testId: string }) {
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
