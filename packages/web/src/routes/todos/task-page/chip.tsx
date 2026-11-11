/* One pill under the Todo's title: a button when the person may change the property, a label when not. Desktop uses the approved
 * 28px chips; mobile keeps every interactive target at 34px. */

export function Chip({
  onOpen,
  children,
  testId,
  label,
  mobile,
  clearSlot,
}: {
  /** Absent for a property the person may not change: the chip is then a label, not a button. */
  onOpen?: () => void
  children: React.ReactNode
  testId?: string
  label: string
  mobile: boolean
  /** Reserves trailing room for a clear control laid over the pill's end. */
  clearSlot?: boolean
}) {
  const Tag = onOpen ? "button" : "span"
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, "aria-label": label, onClick: onOpen } : { title: label })}
      data-testid={testId}
      className={`focus-outline flex flex-none items-center gap-[7px] bg-[var(--fill-tertiary)] font-medium text-[var(--text-secondary)] outline-none ${onOpen ? "hover:bg-[var(--fill-secondary)]" : ""} ${
        mobile
          ? `h-[34px] rounded-[17px] text-[13.5px] ${clearSlot ? "pl-3 pr-[34px]" : "px-3"}`
          : `h-7 rounded-[14px] text-[12.5px] ${clearSlot ? "pl-[11px] pr-7" : "px-[11px]"}`
      }`}
    >
      {children}
    </Tag>
  )
}
