import { BRAND_MARK_SRC, customBrandGlyph } from "@/lib/brand"
import { useSettings } from "@/routes/settings-provider"

/** The default glass mark, decorative: the name beside it labels it. */
export function BrandMark({ size, className }: { size: number; className?: string }) {
  return <img src={BRAND_MARK_SRC} width={size} height={size} alt="" aria-hidden draggable={false} className={className} />
}

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
