import { BrandMark } from "@/components/brand-mark-image"
import { customBrandGlyph } from "@/lib/brand"
import { useSettings } from "@/routes/settings-provider"

/** The mark for this portal: the operator's own glyph when one is set, the
 *  glass mark otherwise. */
export function PortalMark({ size, glyphClassName }: { size: number; glyphClassName?: string }) {
  const { settings } = useSettings()
  const glyph = customBrandGlyph(settings)
  if (glyph) {
    return (
      <span aria-hidden className={glyphClassName}>
        {glyph}
      </span>
    )
  }
  return <BrandMark size={size} />
}

export { BrandMark }
