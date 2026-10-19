import { BRAND_MARK_SRC } from "@/lib/brand"

/** The default glass mark, decorative: the name beside it labels it. It lives apart
 *  from PortalMark so the screens that draw before settings exist (sign-in, route
 *  failure and loading) do not pull the settings provider in with it. */
export function BrandMark({ size, className }: { size: number; className?: string }) {
  return <img src={BRAND_MARK_SRC} width={size} height={size} alt="" aria-hidden draggable={false} className={className} />
}
